<?php
/**
 * Time_Travel: the debugger transport over an Offsetlog_Cursor node.
 *
 * Pause / step / play / seek a durable reader, plus the READ surface the inspector's
 * Time Travel panel gates on (frames + cursor in dump_metadata). Shared by
 * Consumer_Node (a file-tailing reader) and Remote_Source_Node (a push-driven SSE
 * pull) — the read surface, seek, snapshot restore, line_mode, verbs and command
 * handlers are identical; the four node-specific moves ride abstract hooks:
 *   - next_offset()          — reposition the read cursor to a {segment,offset}.
 *   - advance_one_message()  — STEP's single-tick advance (Consumer polls one line;
 *                              a push source can't single-step → a documented no-op).
 *   - time_travel_resume()   — re-arm the node's own poll/tick timer on PLAY.
 *   - time_travel_on_pause() — extra halt on PAUSE (Remote_Source drops the stream).
 *
 * The trait OWNS the transport state (snapshot_node, line_mode, saved_line_mode,
 * rewound_to, stepped_since_seek), the checkpoint bookkeeping (checkpoint_segment/off,
 * last_checkpoint) and the offsetlog geometry (OFFSETLOG_SEGMENT_SIZE / NUM_SEGMENTS);
 * it READS the using class's live read cursor (cursor_segment/off). It also owns the shared
 * frame writer commit_checkpoint_frame(), whose base frame ({segment,offset} + graceful-gated
 * attempt accounting) both nodes commit identically — each contributing only its
 * node-specific extra fields via checkpoint_frame_extra().
 *
 * REQUIRES the using class to also `use Offsetlog_Cursor` (the $offsetlog Partition +
 * commit_offsetlog_frame()) and `use Dead_Letter_Queue` (attempts / poison_reason /
 * first_crash_ts / CHECKPOINT_INTERVAL_S / sealed_quarantine, the accounting the base frame
 * stamps and the quarantine-marker preservation guard in commit_checkpoint_frame reads).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

trait Time_Travel {

	/**
	 * Offsetlog as an exact keyframe timeline for time-travel: segment_size=1 forces one
	 * checkpoint = one segment = one frame, uniformly for stateless readers (small offset
	 * records) and stateful/snapshot ones (offset + cache). Partition's do_rotate() adopts
	 * the still-empty newest segment on the first commit, then rotates to a fresh segment
	 * on every later commit (current_size ≥ 1 > the 1-byte threshold) — so segment_size=1
	 * produces no empty-segment spam. Retain the last 10 keyframes (history depth).
	 */
	public const OFFSETLOG_SEGMENT_SIZE = 1;
	public const OFFSETLOG_NUM_SEGMENTS = 10;

	/**
	 * Last (seg,off) committed to the offsetlog (-1/-1 before the first commit). Feeds the
	 * advance-guard (skip a redundant same-cursor write) and dump_metadata's on_frame signal.
	 */
	protected int $checkpoint_segment = -1;
	protected int $checkpoint_offset = -1;

	/**
	 * Wall-clock of the last durable commit — the throttle floor. Offsetlog is crash-resume
	 * only, so both nodes checkpoint coarsely (Dead_Letter_Queue::CHECKPOINT_INTERVAL_S);
	 * losing <30s of cursor on a crash just re-delivers those messages (at-least-once).
	 */
	protected float $last_checkpoint = 0.0;

	/**
	 * Name of a node whose state rides in the offsetlog alongside the cursor
	 * (Tachikoma's snapshot cache). Empty = offset-only. Set via set_snapshot_node.
	 * A node with no snapshot concern (Remote_Source) leaves it '' and the restore
	 * branches no-op.
	 */
	private string $snapshot_node = '';

	private bool $line_mode = false;

	/**
	 * Time-travel STEP captures the production line_mode here on the first step of
	 * a session; PLAY restores it (line_mode is a legitimate production setting —
	 * some topologies run it on) and clears this back to null.
	 */
	private ?bool $saved_line_mode = null;

	/**
	 * Offsetlog segment id the reader was last rewound to by seek_frame() while
	 * paused, or null when it hasn't been rewound. PLAY reads this to truncate the
	 * offsetlog after the rewind point before re-arming (commit-to-this-branch), so
	 * the re-written forward timeline stays monotonic; it then clears this back to
	 * null. A second seek overwrites it with the newer branch point.
	 */
	private ?int $rewound_to = null;

	/**
	 * True once STEP has advanced the cursor past the frame seek_frame() put it at;
	 * seek_frame() (a fresh park) and play() (going live) clear it. Feeds the seeked
	 * case of dump_metadata()'s `on_frame` signal (`! stepped_since_seek`), so the
	 * debugger panel's "off the keyframe" position survives a remount.
	 */
	private bool $stepped_since_seek = false;

	/**
	 * Jump to a known (cursor, state) keyframe identified by its OFFSETLOG SEGMENT
	 * ID (from dump_metadata's frames[].id): read that one offsetlog segment, take
	 * its (last) record to recover the co-committed cache, restore_state() it into
	 * the snapshot node (when one is set), then reposition the read cursor to the
	 * record's SOURCE {segment,offset}. Does NOT resume the timer — a paused reader stays
	 * paused after seeking.
	 *
	 * @api Consumed over the wire by the debugger UI (SEEK_FRAME command).
	 * @return string 'ok', or an error string when the offsetlog/segment is absent.
	 */
	public function seek_frame( int $segment ): string {
		if ( null === $this->offsetlog ) {
			return 'error: no offsetlog to seek';
		}
		$entry = $this->read_frame_record( $segment );
		if ( null === $entry ) {
			return "error: no frame at segment {$segment}";
		}
		if ( '' !== $this->snapshot_node ) {
			$node  = Core::node( $this->snapshot_node );
			$cache = \is_array( $entry['cache'] ?? null ) ? $entry['cache'] : null;
			if ( null !== $cache && null !== $node && \method_exists( $node, 'restore_state' ) ) {
				$node->restore_state( $cache );
			}
		}
		$this->next_offset( [ 'segment' => $entry['segment'], 'offset' => $entry['offset'] ] );
		// Record the rewind point: PLAY truncates after it to stay monotonic.
		$this->rewound_to         = $segment;
		$this->stepped_since_seek = false; // A fresh seek sits ON the keyframe.
		return 'ok';
	}

	/**
	 * Read ONE offsetlog segment and return its keyframe record VALUE (`{seg, off,
	 * ...cache}`), or null when the segment is absent / empty / unparseable. Take the
	 * last parseable line (Consumer's segment_size=1 makes that the sole record;
	 * a coarser offsetlog's newest record in the segment).
	 *
	 * @return array<array-key, mixed>|null
	 */
	private function read_frame_record( int $segment ): ?array {
		if ( null === $this->offsetlog ) {
			return null;
		}
		$sizes = \array_column( $this->offsetlog->get_segments( true ), 'size', 'id' );
		if ( ! isset( $sizes[ $segment ] ) ) {
			return null;
		}
		$bytes = $this->offsetlog->read_at( $segment, 0, $sizes[ $segment ] );
		$entry = null;
		foreach ( \explode( "\n", $bytes ) as $line ) {
			if ( '' === $line ) {
				continue;
			}
			$parsed = $this->parse_offsetlog_entry( $line );
			if ( null !== $parsed ) {
				$entry = $parsed; // Keep the last parseable record.
			}
		}
		return $entry;
	}

	/**
	 * Parse one packed offsetlog line into its {seg, off, ...} VALUE, or null when
	 * the line is unparseable or its VALUE isn't the expected struct.
	 *
	 * @return array<array-key, mixed>|null
	 */
	private function parse_offsetlog_entry( string $line ): ?array {
		try {
			$message = Message::unpacked( $line );
		} catch ( \InvalidArgumentException $e ) {
			return null;
		}
		$entry = $message[ Message::VALUE ];
		if ( ! \is_array( $entry ) || ! isset( $entry['segment'], $entry['offset'] ) ) {
			return null;
		}
		return $entry;
	}

	/**
	 * Single-step one message. Forces one-message granularity (capturing the
	 * production line_mode on the first step of a session so PLAY can restore it),
	 * then advances exactly one message via the node's advance_one_message() hook.
	 *
	 * @api Consumed over the wire by the debugger UI (auth-gated STEP command).
	 * @return array{segment:int, offset:int, at_eof:bool} The resulting cursor + EOF flag.
	 */
	public function step(): array {
		// Stepping stays paused: a self-rearming fire() leaps past messages.
		$this->stop_timer();
		$this->set_state( 'POLLING', 'PAUSED' );
		if ( null === $this->saved_line_mode ) {
			$this->saved_line_mode = $this->line_mode;
		}
		$this->line_mode          = true;
		$this->stepped_since_seek = true; // Cursor moves off the seeked frame.
		return $this->advance_one_message();
	}

	/**
	 * Name the node whose state is snapshotted into the offsetlog alongside the
	 * cursor (Tachikoma's `connect_edge` + cache_type=snapshot). Recording the name
	 * is all this does — the restore is deferred so topology declaration order can't
	 * forward-reference a node that doesn't exist yet. Lifts the offsetlog's PIPE_BUF
	 * cap (void_warranty): the worker holding the topology lock is the offsetlog's
	 * sole writer, so no per-write lock is needed.
	 */
	public function set_snapshot_node( string $name ): void {
		$this->snapshot_node = $name;
		$this->offsetlog?->void_warranty();
	}

	public function set_line_mode( bool $flag ): void {
		$this->line_mode = $flag;
	}

	/**
	 * Round-trippable `cmd {name}:config <verb>` lines for the PERSISTENT time-travel
	 * config the trait owns — so a `dump_config()` serialize/replay restores them
	 * (without it, a console-serialized topology loses its snapshot node and the
	 * downstream stateful node's save_state() stops co-committing). Only the durable
	 * settings round-trip: `snapshot_node` and `line_mode` (the production value —
	 * `saved_line_mode` holds it while a transient STEP session forces line_mode on).
	 * The imperative verbs (SEEK_FRAME/PAUSE/PLAY/STEP) are runtime, not config.
	 *
	 * @param string $name Node name the verbs address.
	 * @return string Zero or more trailing-newline-terminated `cmd` lines.
	 */
	protected function dump_time_travel_config( string $name ): string {
		$out = '';
		if ( '' !== $this->snapshot_node ) {
			$out .= "cmd {$name}:config set_snapshot_node {$this->snapshot_node}\n";
		}
		if ( $this->saved_line_mode ?? $this->line_mode ) {
			$out .= "cmd {$name}:config set_line_mode 1\n";
		}
		return $out;
	}

	/**
	 * The time-travel READ surface folded into the canvas-poll payload the inspector
	 * round-trips. CHEAP — the warm segments cache only (no record reads, no scandir):
	 *   - `frames`: the offsetlog segment list `[{id,size}]` — a keyframe per segment
	 *     (the debugger ruler identifies a frame by its segment id). Empty when the
	 *     offsetlog is disabled.
	 *   - `cursor`: the live source read position `{segment,offset}`.
	 *   - `polling`: the current polling state (`INIT`, `ACTIVE`, `PAUSED`).
	 *   - `at_frame`: the offsetlog keyframe the cursor is at-or-just-past. `rewound_to`
	 *     when seeked, else the newest frame id when live, null only with no frames yet.
	 *   - `on_frame`: the cursor is exactly on `at_frame`'s committed position vs
	 *     advanced past it. Seeked: `! stepped_since_seek`. Live: cursor == checkpoint.
	 *
	 * @return array{frames: array<int, array{id:int,size:int}>, cursor: array{segment:int, offset:int}, polling: string, at_frame: int|null, on_frame: bool}
	 */
	public function time_travel_metadata(): array {
		$frames    = $this->offsetlog?->get_segments() ?? [];
		$newest_id = empty( $frames ) ? null : \end( $frames )['id'];
		$at_frame  = $this->rewound_to ?? $newest_id;
		$on_frame  = null === $this->rewound_to
			? ( $this->cursor_segment === $this->checkpoint_segment && $this->cursor_offset === $this->checkpoint_offset )
			: ! $this->stepped_since_seek;
		return [
			'frames'   => $frames,
			'cursor'   => [ 'segment' => $this->cursor_segment, 'offset' => $this->cursor_offset ],
			'polling'  => Core::as_string( $this->set_state['POLLING'] ?? 'INIT' ),
			'at_frame' => $at_frame,
			'on_frame' => $on_frame,
		];
	}

	/** Hold the cursor and emit nothing until STEP / PLAY. */
	public function pause(): void {
		$this->stop_timer();
		$this->time_travel_on_pause();
		$this->set_state( 'POLLING', 'PAUSED' );
	}

	/**
	 * Resume normal polling: if rewound while paused, drop the now-stale forward
	 * keyframes (commit-to-this-branch, so the re-written timeline stays monotonic),
	 * restore the line_mode STEP captured, then re-arm the node's own poll/tick timer.
	 */
	public function play(): void {
		if ( null !== $this->rewound_to ) {
			$this->offsetlog?->truncate_after( $this->rewound_to );
			$this->rewound_to = null;
		}
		$this->stepped_since_seek = false; // Going live: off any seeked frame.
		if ( null !== $this->saved_line_mode ) {
			$this->line_mode       = $this->saved_line_mode;
			$this->saved_line_mode = null;
		}
		$this->time_travel_resume();
		$this->set_state( 'POLLING', 'ACTIVE' );
	}

	// --- Shared checkpoint writer (both nodes commit the same base frame) ---

	/**
	 * True once CHECKPOINT_INTERVAL_S has elapsed since the last durable commit — the
	 * shared throttle both nodes gate their per-tick healthy commit on (both in fire()).
	 */
	protected function checkpoint_due(): bool {
		return ( Core::$now - $this->last_checkpoint ) >= self::CHECKPOINT_INTERVAL_S;
	}

	/**
	 * The advance-guard: true when `{segment,offset}` differs from the last committed frame. Both
	 * nodes skip a redundant same-cursor healthy commit — else an idle reader spams identical
	 * keyframes (with segment_size=1, one per interval). The -1/-1 pre-commit sentinel never
	 * equals a real cursor, so the first commit always passes.
	 */
	protected function cursor_moved_since_checkpoint( int $segment, int $offset ): bool {
		return $segment !== $this->checkpoint_segment || $offset !== $this->checkpoint_offset;
	}

	/**
	 * Commit ONE offsetlog frame at `{segment,offset}`. A graceful frame is a clean handoff
	 * (attempts=0 → a respawn resumes at the virgin baseline); a non-graceful frame
	 * carries the live attempt accounting (a climbing poison lineage / pinned crawl).
	 * Records the committed position + wall-clock, then lets the node react
	 * (on_checkpoint_committed — Consumer publishes its CHECKPOINT state).
	 *
	 * @param bool                    $graceful Stamp attempts=0 instead of the live count.
	 * @param array<array-key, mixed> $extra    Per-call frame additions (cache / dlq marker).
	 */
	protected function commit_checkpoint_frame( int $segment, int $offset, bool $graceful, array $extra = [] ): void {
		if ( null === $this->offsetlog ) {
			return;
		}
		// Keep 'quarantined' on the DLQ'd message; past it drops the seal.
		if ( null !== $this->sealed_quarantine ) {
			$sealed = $this->sealed_quarantine;
			if ( $segment === $sealed['segment'] && $offset === $sealed['offset'] ) {
				$extra['quarantined'] = true;
			} elseif ( [ $segment, $offset ] > [ $sealed['segment'], $sealed['offset'] ] ) {
				$this->sealed_quarantine = null;
			}
		}
		$frame = [
			'segment'            => $segment,
			'offset'            => $offset,
			'attempts'       => $graceful ? 0 : $this->attempts,
			'reason'         => $graceful ? '' : $this->poison_reason,
			'first_crash_ts' => $graceful ? null : $this->first_crash_ts,
		] + $this->checkpoint_frame_extra() + $extra;
		$this->commit_offsetlog_frame( $frame );
		$this->checkpoint_segment  = $segment;
		$this->checkpoint_offset  = $offset;
		$this->last_checkpoint = Core::$now;
		$this->on_checkpoint_committed();
	}

	/**
	 * Node-specific frame fields beyond the shared {seg,off,attempts,reason,first_crash_ts}
	 * base (Consumer: name/target/…; Remote_Source: _ts). Return [] for none.
	 *
	 * @return array<array-key, mixed>
	 */
	abstract protected function checkpoint_frame_extra(): array;

	/** React to a committed frame (Consumer publishes its CHECKPOINT state). Base no-op. */
	protected function on_checkpoint_committed(): void {}

	// --- Node-specific hooks ---

	/**
	 * Reposition the read cursor to `{segment,offset}` (seek_frame's landing).
	 *
	 * @param string|array<array-key, mixed> $position Magic value or explicit {segment,offset}.
	 */
	abstract public function next_offset( $position ): void;

	/**
	 * STEP's single-tick advance: emit at most one message and return the resulting
	 * cursor + EOF flag.
	 *
	 * @return array{segment:int, offset:int, at_eof:bool}
	 */
	abstract protected function advance_one_message(): array;

	/** Re-arm the node's own poll/tick timer on PLAY. */
	abstract protected function time_travel_resume(): void;

	/** Extra halt on PAUSE beyond stopping the timer. Base no-op; override to also stop the pull. */
	protected function time_travel_on_pause(): void {}

	// --- {name}:config verb handlers + the shared verb table ---

	/**
	 * `set_snapshot_node` verb handler — set the patron's snapshot-target node.
	 *
	 * @param Command_Interpreter_Node $interpreter Verb argument.
	 * @param string                   $args        Verb argument.
	 */
	public static function cmd_set_snapshot_node( Command_Interpreter_Node $interpreter, string $args ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->set_snapshot_node( \trim( $args ) );
		return 'ok';
	}

	/**
	 * `set_line_mode` verb handler — toggle the patron's line-mode framing. Only an
	 * explicit truthy arg (`1`/`true`/`yes`/`on`) enables it; a bare/empty verb or any
	 * other value disables it, so the default is "off" and an accidental enable is reversible.
	 *
	 * @param Command_Interpreter_Node $interpreter Verb argument.
	 * @param string                   $args        Optional bool; only a truthy value enables.
	 */
	public static function cmd_set_line_mode( Command_Interpreter_Node $interpreter, string $args ): string {
		/** @var self $patron */
		$patron  = $interpreter->patron();
		$enabled = \in_array( \strtolower( \trim( $args ) ), [ '1', 'true', 'yes', 'on' ], true );
		$patron->set_line_mode( $enabled );
		return 'ok';
	}

	/**
	 * `SEEK_FRAME` verb handler — seek the patron reader to a frame.
	 *
	 * @param Command_Interpreter_Node $interpreter Verb argument.
	 * @param string                   $args        Verb argument.
	 */
	public static function cmd_seek_frame( Command_Interpreter_Node $interpreter, string $args ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		return $patron->seek_frame( (int) \trim( $args ) );
	}

	/**
	 * `PAUSE` verb handler — pause the patron reader.
	 *
	 * @param Command_Interpreter_Node $interpreter Verb argument.
	 */
	public static function cmd_pause( Command_Interpreter_Node $interpreter ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->pause();
		return 'ok';
	}

	/**
	 * `PLAY` verb handler — resume the patron reader.
	 *
	 * @param Command_Interpreter_Node $interpreter Verb argument.
	 */
	public static function cmd_play( Command_Interpreter_Node $interpreter ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->play();
		return 'ok';
	}

	/**
	 * `STEP` verb handler — single-step the patron reader.
	 *
	 * @param Command_Interpreter_Node $interpreter Verb argument.
	 */
	public static function cmd_step( Command_Interpreter_Node $interpreter ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		return (string) \wp_json_encode( $patron->step() );
	}

	/**
	 * The shared time-travel verb table, merged into a node's node_schema()['commands']
	 * so Consumer and Remote_Source register identical verbs.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public static function time_travel_verbs(): array {
		return [
			[
				'name'        => 'set_snapshot_node',
				'description' => 'Co-commit a named node\'s save_state() into the offsetlog alongside the cursor, so it resumes its in-flight state on respawn (Tachikoma snapshot cache). Lifts the offsetlog PIPE_BUF cap (single-writer).',
				'args'        => [
					[ 'name' => 'node', 'type' => 'node_name', 'required' => true ],
				],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, string $args ): string => self::cmd_set_snapshot_node( $interpreter, $args ),
			],
			[
				'name'        => 'set_line_mode',
				'description' => 'Fine-grained drain mode: emits one line per event cycle',
				'args'        => [
					[ 'name' => 'enabled', 'type' => 'bool', 'required' => false ],
				],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, string $args ): string => self::cmd_set_line_mode( $interpreter, $args ),
			],
			[
				'name'        => 'SEEK_FRAME',
				'description' => 'Time-travel: jump to the offsetlog keyframe with segment id <segment> (from dump_metadata frames[].id), restoring its co-committed snapshot state. Stays paused.',
				// Driven by the Inspector transport bar; hide the verb button.
				'hidden'      => true,
				'args'        => [
					[ 'name' => 'segment', 'type' => 'int', 'required' => true ],
				],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, string $args ): string => self::cmd_seek_frame( $interpreter, $args ),
			],
			[
				'name'        => 'PAUSE',
				'description' => 'Time-travel: stop the poll timer; the reader holds its cursor until STEP / PLAY.',
				'hidden'      => true,
				'args'        => [],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, string $args ): string => self::cmd_pause( $interpreter ),
			],
			[
				'name'        => 'PLAY',
				'description' => 'Time-travel: restore the pre-STEP line_mode and resume the poll loop.',
				'hidden'      => true,
				'args'        => [],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, string $args ): string => self::cmd_play( $interpreter ),
			],
			[
				// STEP mutates: auth-gated command path, not TM_REQUEST.
				'name'        => 'STEP',
				'description' => 'Time-travel: emit at most one message (forces line granularity, implies PAUSE) and reply with the {seg,off,at_eof} cursor as JSON.',
				'hidden'      => true,
				'args'        => [],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, string $args ): string => self::cmd_step( $interpreter ),
			],
		];
	}
}
