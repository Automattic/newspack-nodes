<?php
/**
 * Consumer: partition-aware reader with offsetlog checkpointing.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

class Consumer_Node extends Timer_Node {
	use Schema_Reflection;

	// Offsetlog as an exact keyframe timeline for time-travel: segment_size=1 forces
	// one checkpoint = one segment = one frame, uniformly for stateless consumers
	// (small offset records) and stateful/snapshot ones (offset + cache). Partition's
	// do_rotate() adopts the still-empty newest segment on the first commit, then
	// rotates to a fresh segment on every later commit (current_size ≥ 1 > the
	// 1-byte threshold) — so segment_size=1 produces no empty-segment spam.
	public const OFFSETLOG_SEGMENT_SIZE = 1;
	// Retain the last 10 keyframes (time-travel history depth); load_offsetlog()
	// crash-resume reads the newest segment, now exactly one record.
	public const OFFSETLOG_NUM_SEGMENTS = 10;
	public const MAX_LINE_BUFFER_SIZE = 33554432;

	/**
	 * Bytes read per poll — one block, then yield the event loop (Tachikoma's
	 * BUFSIZ in Partition::process_get). A poll drains the buffer it already
	 * holds, reads ONE more block, and returns so other nodes get a turn.
	 */
	public const READ_BLOCK_BYTES = 65536;

	public const POLL_INTERVAL_EOF_MS = 100;

	/** 0 = next event-loop iteration. */
	public const POLL_INTERVAL_BUSY_MS = 0;

	// Offsetlog is crash-resume only (TopicProbe, not the offsetlog, is the position
	// source now), so checkpoint coarsely — losing <30s of cursor on a crash just
	// re-delivers those messages on respawn (at-least-once). Cheaper offsetlog I/O.
	public const CHECKPOINT_INTERVAL_S = 30;

	protected float $last_checkpoint = 0.0;

	/**
	 * Per-tick dispatch (Tachikoma's `$self->{fill}` function pointer). arguments()
	 * points this at poll_init; the first poll loads the durable cursor + restores
	 * the snapshot — by which time the whole topology is built — then swaps to
	 * poll_active. Keeps construction free of I/O and forward-reference order.
	 */
	protected ?\Closure $poll_cb = null;

	/** Last (seg, off) committed; skip checkpoint if cursor hasn't advanced. */
	protected int $checkpoint_seg = -1;
	protected int $checkpoint_off = -1;

	/**
	 * Times the message at the boot cursor has been attempted without advancing past
	 * it (dead-letter [42]). 1 = healthy baseline (a running checkpoint); 0 = a
	 * graceful-shutdown handoff at a genuinely un-attempted cursor. A respawn reads
	 * the frame's value and resumes at attempts+1, so a stuck/poison cursor climbs.
	 */
	protected int $attempts = 1;

	/**
	 * The cursor this process booted on (seeded by load_offsetlog). Advancing past it
	 * is "forward progress" — the poison region is behind us, so attempts resets to the
	 * healthy baseline. Also the fair-shot proxy for cooperative-stop strikes ([42]).
	 */
	protected int $boot_cursor_seg = 0;
	protected int $boot_cursor_off = 0;

	/**
	 * Why the prior process stopped at this cursor — '' = none / hard crash (the
	 * signature that drives crawl-mode isolation), else a cooperative-stop reason
	 * (`timeout`/`memory`, stamped at shutdown). A respawn reads it to classify.
	 */
	protected string $poison_reason = '';

	/**
	 * Wall-clock of the first crash in the current stuck streak (null when healthy),
	 * carried forward across respawns. Once it's older than STATE_WIPE_AFTER_S the
	 * boot discards the snapshot cache — a state that keeps killing us, not a poison
	 * message. Cleared on forward progress / graceful handoff.
	 */
	protected ?float $first_crash_ts = null;

	/** Discard the resumable snapshot cache after this many seconds of an unbroken crash streak. */
	public const STATE_WIPE_AFTER_S = 900;

	protected string $source_dir = '';
	/**
	 * Raw token assigned by parse_schema_args() — the override normalizes it
	 * (rtrim '/') into the derived $offsetlog_dir below.
	 */
	protected string $offsetlog_dir      = '';
	protected ?Partition_Node $source    = null;
	/** Null when constructed with empty $offsetlog_dir (ephemeral readers skip durable cursors). */
	protected ?Partition_Node $offsetlog = null;

	/** FROM-stamp override; defaults to $this->name. The IPC input-Consumer stamps as `_repl`. */
	protected string $stamp_override = '';

	/**
	 * Name of a node whose state rides in the offsetlog alongside the cursor
	 * (Tachikoma's snapshot cache). Empty = offset-only. Set via set_snapshot_node.
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
	 * Offsetlog segment id the consumer was last rewound to by seek_frame() while
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
	 * Cache read from the offsetlog at construction but not yet restored — the
	 * snapshot node usually doesn't exist yet when load_offsetlog() runs, so we
	 * stash it and restore once set_snapshot_node() names the (now-built) node.
	 *
	 * @var array<array-key, mixed>|null
	 */
	private ?array $loaded_cache = null;

	/** Cursor segment. cursor_off + buffer length is the next read position. */
	protected int $cursor_seg = 0;

	/** Durable read offset for cursor_seg; always a line boundary (last fully-emitted line). */
	protected int $cursor_off = 0;

	/** Bytes read past cursor_off but not yet emitted (read-ahead + trailing partial). Tachikoma's buffer. */
	protected string $buffer = '';

	protected bool $at_eof = true;

	/** True once next_offset() was called explicitly — suppresses the default_offset() seek. */
	protected bool $offset_set = false;

	/** Tachikoma-parity: no-arg ctor. Positional config arrives via arguments(). */
	public function __construct() {
		parent::__construct();
		// Build the {name}:config interpreter from the schema commands, so the
		// set_snapshot_node verb is dispatchable; handlers read the patron lazily.
		$this->auto_wire_interpreter();
	}

	/**
	 * Store the raw string, parse positional tokens via parse_schema_args()
	 * (source_dir / offsetlog_dir), then normalize, materialize the source / offsetlog
	 * Partitions (the offsetlog is a flat segmented-log dir) and seed the in-memory
	 * cursor from any existing offsetlog entries.
	 *
	 * @param string|null $args
	 * @return string
	 */
	public function arguments( ?string $args = null ): string {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		[ $source_path, $offsetlog_path ] = $this->resolve_args();
		$this->source_dir    = \rtrim( $source_path, '/' );
		$this->offsetlog_dir = \rtrim( $offsetlog_path, '/' );

		$this->source = $this->make_source();
		if ( '' !== $this->name ) {
			$this->source->name( "{$this->name}:source" );
		}
		$this->source->arguments( $this->source_dir );
		$this->source->sink( $this->sink );
		$this->source->patron( $this );

		if ( '' !== $this->offsetlog_dir ) {
			$this->offsetlog = new Partition_Node();
			if ( '' !== $this->name ) {
				$this->offsetlog->name( "{$this->name}:offsetlog" );
			}
			$this->offsetlog->arguments( implode( ' ', [ "{$this->offsetlog_dir}", self::OFFSETLOG_SEGMENT_SIZE, self::OFFSETLOG_NUM_SEGMENTS ] ) );
			$this->offsetlog->sink( $this->sink );
			$this->offsetlog->patron( $this );
		} else {
			$this->offsetlog = null;
		}

		// No I/O at construction: the first poll loads the durable cursor and
		// restores the snapshot, once the whole topology graph exists.
		$this->poll_cb = $this->poll_init( ... );
		$this->set_timer( self::POLL_INTERVAL_EOF_MS, true );
		$this->set_state( 'POLLING', 'ACTIVE' );

		return $args;
	}

	/**
	 * Handle TM_REQUEST introspection verbs (reply TO=FROM); else defer to Timer.
	 */
	public function fill( array &$message ): void {
		$type_raw = $message[ Message::TYPE ];
		$type     = \is_numeric( $type_raw ) ? (int) $type_raw : 0;
		if ( $type & Message::TM_REQUEST ) {
			$this->handle_request( $message );
			return;
		}
		parent::fill( $message );
	}

	/** Timer-driven: poll, periodically checkpoint the cursor, then re-arm (busy/EOF cadence). */
	protected function fire(): void {
		$this->poll();
		// poll() updates the in-memory cursor every read; checkpoint() makes it durable.
		if (
			null !== $this->offsetlog
			&& ( Core::$now - $this->last_checkpoint ) >= self::CHECKPOINT_INTERVAL_S
		) {
			$this->checkpoint();
			$this->last_checkpoint = Core::$now;
		}
		$next_ms = $this->at_eof ? self::POLL_INTERVAL_EOF_MS : self::POLL_INTERVAL_BUSY_MS;
		$this->set_timer( $next_ms, true ); // oneshot — fire() re-arms.
	}

	/** @param array<int, mixed> $message Incoming request Message. */
	private function handle_request( array $message ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'fill requires a wired sink' );
		}
		$value_raw = $message[ Message::VALUE ];
		$value     = Core::as_string( $value_raw );
		$verb      = \strtoupper( \explode( ' ', \trim( $value ), 2 )[0] );

		$payload = match ( $verb ) {
			'GET_LAG' => $this->compute_lag(),
			default   => [ 'error' => "unknown request verb: {$verb}" ],
		};

		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_STRUCT | Message::TM_RESPONSE;
		$reply[ Message::FROM ]  = '' !== $this->stamp_override ? $this->stamp_override : $this->name;
		$reply[ Message::TO ]    = $message[ Message::FROM ];
		$reply[ Message::ID ]    = $message[ Message::ID ];
		$reply[ Message::KEY ]   = $message[ Message::KEY ];
		$reply[ Message::VALUE ] = [ 'verb' => $verb, 'data' => $payload ];
		$this->sink->fill( $reply );
	}

	/**
	 * @param bool $graceful Final checkpoint of a clean shutdown — stamps attempts=0
	 *                       (the cursor sits at an un-attempted message), so a respawn
	 *                       resumes at a virgin first attempt rather than counting a strike.
	 */
	public function checkpoint( bool $graceful = false ): void {
		if ( null === $this->offsetlog ) {
			return;
		}
		// Advance-guard: skip a redundant same-cursor write (graceful is exempt — its
		// attempts=0 is new content; boot frames bypass via write_checkpoint_frame).
		$first_checkpoint = -1 === $this->checkpoint_seg && -1 === $this->checkpoint_off;
		if (
			! $graceful
			&& ! $first_checkpoint
			&& $this->cursor_seg === $this->checkpoint_seg
			&& $this->cursor_off === $this->checkpoint_off
		) {
			return;
		}
		// Forward progress past the boot cursor ends the crash streak: clear the strikes.
		if ( ! $graceful && $this->cursor_advanced_since_boot() ) {
			$this->attempts       = 1;
			$this->first_crash_ts = null;
			$this->poison_reason  = '';
		}
		$this->write_checkpoint_frame( $graceful, true );
	}

	/** True once the read cursor has moved past the cursor this process booted on. */
	private function cursor_advanced_since_boot(): bool {
		return $this->cursor_seg > $this->boot_cursor_seg
			|| ( $this->cursor_seg === $this->boot_cursor_seg && $this->cursor_off > $this->boot_cursor_off );
	}

	/**
	 * Commit one offsetlog frame at the current cursor — UNCONDITIONALLY (no
	 * advance-guard; the boot sequence re-commits the same cursor on purpose).
	 *
	 * @param bool $graceful   Stamp attempts=0 (clean handoff) instead of the live count.
	 * @param bool $with_state Co-commit the snapshot node's save_state(). False for the
	 *                         stateless boot frame written BEFORE restore — reading the
	 *                         un-restored node there would clobber the good cache.
	 */
	private function write_checkpoint_frame( bool $graceful, bool $with_state ): void {
		if ( null === $this->offsetlog ) {
			return;
		}
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_STRUCT;
		$message[ Message::TIMESTAMP ] = Core::$now;
		$message[ Message::FROM ]      = $this->name;
		$value = [
			'seg'            => $this->cursor_seg,
			'off'            => $this->cursor_off,
			'attempts'       => $graceful ? 0 : $this->attempts,
			'reason'         => $graceful ? '' : $this->poison_reason,
			'first_crash_ts' => $graceful ? null : $this->first_crash_ts,
			'ts'             => Core::$now,
			'name'           => $this->name,
			'target'         => \is_string( $this->target ) ? $this->target : '',
			'targets'        => $this->resolve_downstream_targets(),
			'worker_type'    => self::worker_type_env(),
			// Real source log basename. Two readers can tail the same log under
			// distinct offset-dir names (firehose vs firehose.job-router); the
			// dashboard labels by this, not the disambiguated offset dir.
			'source_log'     => \basename( $this->source_dir ),
		];
		// Co-commit the snapshot node's state with the offset, as ONE record, so a
		// respawn restores the cache and resumes the cursor in lockstep.
		if ( $with_state && '' !== $this->snapshot_node ) {
			$node = Core::node( $this->snapshot_node );
			if ( null !== $node && \method_exists( $node, 'save_state' ) ) {
				$value['cache'] = $node->save_state();
			}
		}
		$message[ Message::VALUE ]     = $value;
		$this->offsetlog->fill( $message );
		// Persist synchronously — don't wait for the offsetlog Partition's PIPE_BUF threshold.
		$this->offsetlog->flush();
		$this->checkpoint_seg = $this->cursor_seg;
		$this->checkpoint_off = $this->cursor_off;

		$this->set_state( 'CHECKPOINT', \implode( ' ', [ 'SEGMENT', $this->cursor_seg, 'OFFSET', $this->cursor_off ] ) );
	}

	/**
	 * Resolve the Consumer's immediate downstream processor(s) to `{name, class}` entries.
	 *
	 * A Tee target is expanded to its targets so the dashboard shows the real processors.
	 *
	 * @return array<int,array{name:string,class:string}>
	 */
	private function resolve_downstream_targets(): array {
		if ( ! \is_string( $this->target ) || '' === $this->target ) {
			return [];
		}
		$node = Core::node( $this->target );
		if ( null === $node ) {
			// Not yet registered or removed; surface the name without a class.
			return [ [ 'name' => $this->target, 'class' => '' ] ];
		}
		$class = Command_Interpreter_Node::shell_name_for( $node );
		// instanceof, not an exact name match, so a Tee subclass (Tap) expands too.
		if ( ! $node instanceof Tee_Node ) {
			return [ [ 'name' => $this->target, 'class' => $class ] ];
		}
		$tee_targets = $node->target;
		if ( ! \is_array( $tee_targets ) ) {
			return [ [ 'name' => $this->target, 'class' => $class ] ];
		}
		$out = [];
		foreach ( $tee_targets as $t ) {
			if ( '' === $t ) {
				continue;
			}
			$tn = Core::node( $t );
			$tc = null === $tn ? '' : Command_Interpreter_Node::shell_name_for( $tn );
			$out[] = [ 'name' => $t, 'class' => $tc ];
		}
		return $out;
	}

	/** Worker-type env tag (set by SpawnController after HMAC auth); '' when unset. */
	private static function worker_type_env(): string {
		// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- env var is set by SpawnController after HMAC auth.
		return Core::as_string( $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ?? '' );
	}

	/** Seam (Tail overrides → Log): the source segmented-log node to read. Consumer reads a Partition. */
	protected function make_source(): Partition_Node {
		return new Partition_Node();
	}

	/**
	 * Seam (Tail overrides): [source_path, offsetlog_path] from the parsed schema args.
	 * Consumer's schema args are source_dir + offsetlog_dir.
	 *
	 * @return array{0:string,1:string}
	 */
	protected function resolve_args(): array {
		return [ $this->source_dir, $this->offsetlog_dir ];
	}

	/**
	 * Probe seam: the raw snapshot `TopicProbe` reads from outside this Consumer,
	 * as the POSITIONAL `Probe_Record` array (kept tiny for 24h SSE replay). Just
	 * the state at this instant — `SOURCE` (partition tailed) + `READER` (offsetlog
	 * dir basename, the durable per-reader id) + the consumer cursor + the partition
	 * END (newest segment + size, so the topologies tab trims its live list back to
	 * here) + `DISTANCE` (bytes behind, for the overview graph) + `MSGS`. Rates and
	 * totals are NOT logged — readers derive them from consecutive records.
	 *
	 * @return array<int,int|string> A `Probe_Record`-indexed positional array.
	 */
	public function probe_stats(): array {
		$lag                                = $this->compute_lag();
		$record                             = [];
		$record[ Probe_Record::SOURCE ]     = '' !== $this->source_dir ? \basename( $this->source_dir ) : '';
		$record[ Probe_Record::READER ]     = '' !== $this->offsetlog_dir ? \basename( $this->offsetlog_dir ) : '';
		$record[ Probe_Record::CURSOR_SEG ] = $this->cursor_seg;
		$record[ Probe_Record::CURSOR_OFF ] = $this->cursor_off;
		$record[ Probe_Record::END_SEG ]    = $lag['end_seg'];
		$record[ Probe_Record::END_SIZE ]   = $lag['end_size'];
		$record[ Probe_Record::DISTANCE ]   = $lag['bytes_behind'];
		$record[ Probe_Record::MSGS ]       = $this->counter;
		$record[ Probe_Record::END_BYTES ]  = $lag['end_bytes'];
		$record[ Probe_Record::CACHE_SIZE ] = $this->offsetlog_cache_size();
		return $record;
	}

	/**
	 * Byte size of the consumer's newest offsetlog segment — the position-cache
	 * footprint the overview graphs. 0 for an ephemeral reader (no offsetlog) or
	 * before the first checkpoint writes a segment.
	 */
	private function offsetlog_cache_size(): int {
		if ( null === $this->offsetlog ) {
			return 0;
		}
		$segments = $this->offsetlog->get_segments( true );
		if ( [] === $segments ) {
			return 0;
		}
		$last = \end( $segments );
		return $last['size'];
	}

	/** @return array{bytes_behind: int, segments_behind: int, caught_up: bool, end_seg: int, end_size: int, end_bytes: int} */
	private function compute_lag(): array {
		\clearstatcache( true, $this->source()->partition_dir() );
		$segments = $this->source()->get_segments( true );
		if ( empty( $segments ) ) {
			return [ 'bytes_behind' => 0, 'segments_behind' => 0, 'caught_up' => true, 'end_seg' => 0, 'end_size' => 0, 'end_bytes' => 0 ];
		}
		// Recover a deleted/recreated cursor segment first so lag reflects the
		// replay poll() will actually do (a stale cursor otherwise reads as caught up).
		$this->normalize_cursor( $segments );
		$bytes_behind     = 0;
		$segments_behind  = 0;
		$end_bytes        = 0;
		foreach ( $segments as $s ) {
			$id   = $s['id'];
			$size = $s['size'];
			// Absolute partition byte position (Σ all live segment sizes) — the
			// browser derives the byte THROUGHPUT from its delta (Δ end_bytes/Δt),
			// the only way it can: the lean record carries no per-segment sizes.
			$end_bytes += $size;
			if ( $id < $this->cursor_seg ) {
				continue;
			}
			if ( $id === $this->cursor_seg ) {
				$bytes_behind += \max( 0, $size - $this->cursor_off );
			} else {
				$bytes_behind += $size;
				++$segments_behind;
			}
		}
		// Count buffered (already-read) bytes as consumed so lag reflects bytes-still-to-emit.
		$bytes_behind = \max( 0, $bytes_behind - \strlen( $this->buffer ) );
		// Partition END (newest segment + its size) captured in the SAME read as
		// the cursor — the topologies tab trims its live segment list back to here.
		$last = \end( $segments );
		return [
			'bytes_behind'    => $bytes_behind,
			'segments_behind' => $segments_behind,
			'caught_up'       => 0 === $bytes_behind,
			'end_seg'         => $last['id'],
			'end_size'        => $last['size'],
			'end_bytes'       => $end_bytes,
		];
	}

	// ============================================================================
	// Time-travel transport (debugger UI): pause / step / play / seek a consumer.
	// The read surface (frames + cursor) rides dump_metadata(); STEP returns
	// the resulting cursor.
	// ============================================================================

	/**
	 * Jump to a known (cursor, state) keyframe identified by its OFFSETLOG SEGMENT
	 * ID (from dump_metadata's frames[].id): read that one offsetlog segment, take
	 * its (single) record to recover the co-committed cache, restore_state() it
	 * into the snapshot node (when one is set), then reposition the read cursor to
	 * the record's SOURCE {seg,off}. Does NOT resume the timer — a paused consumer
	 * stays paused after seeking.
	 *
	 * @api Consumed over the wire by the debugger UI (SEEK_FRAME command).
	 * @return string 'ok', or an error string when the offsetlog/segment is absent.
	 */
	public function seek_frame( int $segment_id ): string {
		if ( null === $this->offsetlog ) {
			return 'error: no offsetlog to seek';
		}
		$entry = $this->read_frame_record( $segment_id );
		if ( null === $entry ) {
			return "error: no frame at segment {$segment_id}";
		}
		if ( '' !== $this->snapshot_node ) {
			$node  = Core::node( $this->snapshot_node );
			$cache = \is_array( $entry['cache'] ?? null ) ? $entry['cache'] : null;
			if ( null !== $cache && null !== $node && \method_exists( $node, 'restore_state' ) ) {
				$node->restore_state( $cache );
			}
		}
		$this->next_offset( [ 'seg' => $entry['seg'], 'off' => $entry['off'] ] );
		// Record the rewind point: PLAY truncates the offsetlog after it before
		// re-arming, so the re-written forward timeline stays monotonic.
		$this->rewound_to         = $segment_id;
		$this->stepped_since_seek = false; // A fresh seek sits ON the keyframe.
		return 'ok';
	}

	/**
	 * Read ONE offsetlog segment and return its keyframe record VALUE (`{seg, off,
	 * ...cache}`), or null when the segment is absent / empty / unparseable. There's
	 * exactly one record per offsetlog segment (segment_size=1), but be defensive
	 * and take the last parseable line.
	 *
	 * @return array<array-key, mixed>|null
	 */
	private function read_frame_record( int $segment_id ): ?array {
		if ( null === $this->offsetlog ) {
			return null;
		}
		$sizes = \array_column( $this->offsetlog->get_segments( true ), 'size', 'id' );
		if ( ! isset( $sizes[ $segment_id ] ) ) {
			return null;
		}
		$bytes = $this->offsetlog->read_at( $segment_id, 0, $sizes[ $segment_id ] );
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
	 * Single-step one message. Forces one-message granularity (capturing the
	 * production line_mode on the first step of a session so PLAY can restore it),
	 * then drives ticks until exactly one message is emitted or EOF is reached.
	 *
	 * @api Consumed over the wire by the debugger UI (auth-gated STEP command).
	 * @return array{seg:int, off:int, at_eof:bool} The resulting cursor + EOF flag.
	 */
	public function step(): array {
		// Stepping always leaves the consumer paused: an un-paused self-rearming
		// fire() loop would interleave full-batch polls between steps (leaping the
		// cursor past messages) and an abandoned session would stay in line_mode.
		// PLAY re-arms. Idempotent — PAUSE-then-STEP makes this a no-op.
		$this->stop_timer();
		$this->set_state( 'POLLING', 'PAUSED' );
		if ( null === $this->saved_line_mode ) {
			$this->saved_line_mode = $this->line_mode;
		}
		$this->line_mode          = true;
		$this->stepped_since_seek = true; // Cursor advances off the seeked frame.
		$before                   = $this->counter;
		// poll_init's first tick only loads the buffer (emits nothing in line
		// mode), so always tick at least once, then keep going until one message
		// lands or a poll leaves us genuinely at EOF with nothing buffered.
		do {
			$this->poll();
		} while ( $this->counter === $before && ! $this->at_eof );
		return [ 'seg' => $this->cursor_seg, 'off' => $this->cursor_off, 'at_eof' => $this->at_eof ];
	}

	/** One tick. Dispatches through poll_cb: poll_init on the first call, poll_active after. */
	public function poll(): void {
		( $this->poll_cb ?? ( $this->poll_cb = $this->poll_init( ... ) ) )();
	}

	/**
	 * INIT phase (Tachikoma's status INIT → ACTIVE): seed the durable cursor from
	 * the offsetlog and restore the snapshot node's state. Runs on the first poll —
	 * inside the drain loop, after the whole topology is built — so the snapshot
	 * node exists no matter what order the topology declared it. A durable
	 * checkpoint OVERRIDES any pre-poll next_offset() the caller set (resume wins);
	 * with no checkpoint, that seek stands. Then become the steady-state poller and
	 * fall through to it so this tick still does work.
	 */
	protected function poll_init(): void {
		$this->load_offsetlog();
		if ( null !== $this->loaded_cache && '' !== $this->snapshot_node ) {
			$node = Core::node( $this->snapshot_node );
			if ( null !== $node && \method_exists( $node, 'restore_state' ) ) {
				$node->restore_state( $this->loaded_cache );
				// Restore survived: re-commit the cache statefully (the boot frame was stateless).
				$this->write_checkpoint_frame( false, true );
			} else {
				$this->print_less_often( "WARNING: snapshot node '{$this->snapshot_node}' missing or has no restore_state(); discarding restored cache" );
			}
		}
		$this->loaded_cache = null;
		if ( ! $this->has_checkpoint() && ! $this->offset_set ) {
			$default = $this->default_offset();
			if ( null !== $default ) {
				$this->next_offset( $default );
			}
		}
		$this->poll_cb = $this->poll_active( ... );
		( $this->poll_cb )();
	}

	/**
	 * Seed the cursor from the newest offsetlog entry and stash any co-committed
	 * snapshot cache. When a durable checkpoint is found it resumes the cursor from
	 * it — overriding any pre-poll next_offset() seek (resume wins); otherwise the
	 * cursor is left as-is (offsetlog disabled, empty, or corrupt).
	 */
	protected function load_offsetlog(): void {
		if ( null === $this->offsetlog ) {
			return;
		}
		$segments = $this->offsetlog->get_segments( true );
		if ( empty( $segments ) ) {
			return;
		}
		$newest = \end( $segments );
		$bytes  = $this->offsetlog->read_at( $newest['id'], 0, $newest['size'] );
		$lines  = \array_filter( \explode( "\n", $bytes ), static fn ( $l ) => '' !== $l );
		if ( empty( $lines ) ) {
			return;
		}
		try {
			$message = Message::unpacked( \end( $lines ) );
		} catch ( \InvalidArgumentException $e ) {
			// Unparseable entry: keep the current position rather than resuming.
			$this->print_less_often( "WARNING: ignoring unparseable offsetlog entry while seeding cursor: {$e->getMessage()}" );
			return;
		}
		$entry = $message[ Message::VALUE ];
		if ( ! \is_array( $entry ) || ! isset( $entry['seg'], $entry['off'] ) ) {
			return;
		}
		$seg              = $entry['seg'];
		$off              = $entry['off'];
		$this->cursor_seg      = \is_numeric( $seg ) ? (int) $seg : 0;
		$this->cursor_off      = \is_numeric( $off ) ? (int) $off : 0;
		$this->boot_cursor_seg = $this->cursor_seg;
		$this->boot_cursor_off = $this->cursor_off;
		// Resume at attempts+1 — a clean handoff wrote 0 → 1 (virgin); a crash left ≥1 → climbs.
		$prior          = $entry['attempts'] ?? 0;
		$this->attempts = ( \is_numeric( $prior ) ? (int) $prior : 0 ) + 1;
		// Recovering: stamp when the streak began, carrying an existing mark forward.
		if ( $this->attempts > 1 ) {
			$prior_ts             = $entry['first_crash_ts'] ?? null;
			$this->first_crash_ts = \is_numeric( $prior_ts ) ? (float) $prior_ts : Core::$now;
		}
		// Offset + cache come from ONE record, so the resumed cursor and the
		// restored state are always aligned.
		$this->loaded_cache = \is_array( $entry['cache'] ?? null ) ? $entry['cache'] : null;
		// Crash streak past the wipe window: discard the corrupt resumable state (no message-skip can fix it).
		if (
			null !== $this->loaded_cache
			&& null !== $this->first_crash_ts
			&& ( Core::$now - $this->first_crash_ts ) > self::STATE_WIPE_AFTER_S
		) {
			$this->print_less_often( 'WARNING: snapshot cache exceeded ' . self::STATE_WIPE_AFTER_S . 's crash streak; discarding (suspected corrupt state, not a poison message)' );
			$this->loaded_cache = null;
		}
		// Stateless boot frame BEFORE restore: a restore crash still advances the durable counter.
		$this->write_checkpoint_frame( false, false );
	}

	/**
	 * True if this Consumer resumed from a durable offsetlog checkpoint (seg/off
	 * default to -1; poll_init's load_offsetlog seeds them ≥0). Only meaningful
	 * after the first poll — construction does no I/O. To pick a first-spawn start
	 * position, call next_offset() at build; poll_init resumes from the checkpoint
	 * when one exists (overriding that seek) and keeps it otherwise.
	 */
	public function has_checkpoint(): bool {
		return -1 !== $this->checkpoint_seg || -1 !== $this->checkpoint_off;
	}

	/**
	 * Seam (Tail overrides → 'end'): first-spawn cursor when there's no durable
	 * checkpoint AND no explicit next_offset(). null = leave at the constructed
	 * default (0:0 = start), which is Consumer's behavior.
	 */
	protected function default_offset(): ?string {
		return null;
	}

	/**
	 * Set next read position: 'start' | 'recent' | 'end' | array{seg,off}.
	 *
	 * @param string|array<array-key, mixed> $position Magic value or explicit position (reads 'seg'/'off').
	 */
	public function next_offset( $position ): void {
		$this->offset_set = true;
		$this->buffer     = '';
		$this->at_eof     = false;

		if ( \is_array( $position ) ) {
			$seg              = $position['seg'] ?? 0;
			$off              = $position['off'] ?? 0;
			$this->cursor_seg = \is_numeric( $seg ) ? (int) $seg : 0;
			$this->cursor_off = \max( 0, \is_numeric( $off ) ? (int) $off : 0 );
			return;
		}

		$segments = $this->source()->get_segments( true );

		switch ( $position ) {
			case 'end':
				if ( ! empty( $segments ) ) {
					$newest           = \end( $segments );
					$this->cursor_seg = $newest['id'];
					$this->cursor_off = $newest['size'];
				}
				break;

			case 'recent':
				if ( ! empty( $segments ) ) {
					$count = \count( $segments );
					if ( $count >= 2 ) {
						$this->cursor_seg = $segments[ $count - 2 ]['id'];
					} else {
						$this->cursor_seg = $segments[0]['id'];
					}
					$this->cursor_off = 0;
				}
				break;

			case 'start':
			default:
				$this->cursor_seg = 0;
				$this->cursor_off = 0;
				break;
		}
	}

	/**
	 * One ACTIVE-phase tick: drain the buffer, then top it up. Batch pipelines (read a block
	 * every tick — this tick's read drains next tick), so it stays at full throughput and
	 * reaches EOF promptly. Line mode reads only once the buffer is dry of complete lines, so
	 * it never reads ahead and the one-line-per-tick pacing holds.
	 */
	protected function poll_active(): void {
		$drained = $this->drain_buffer();
		if ( ! $this->line_mode || 0 === $drained ) {
			$this->get_batch();
		}
	}

	/**
	 * Forward up to $max complete lines from $buffer to the sink, returning how many were
	 * consumed. Batch (max = PHP_INT_MAX) and line mode (max = 1) are the same scan with a
	 * different cap — no second code path to keep in sync.
	 *
	 * Scans by offset and chops the buffer ONCE at the end, so batch stays a single O(n)
	 * pass (no substr-per-line) and an empty line is consumed cleanly (the old rtrim+explode
	 * silently dropped a trailing empty line's byte). Advancing cursor_off in lockstep with
	 * the chop is load-bearing: get_batch reads at `cursor_off + strlen(buffer)`, so a chop
	 * without the matching cursor bump re-reads the gap and mis-aligns the next line into
	 * unparseable garbage. The cursor advances past skipped (unparseable / over-long-FROM)
	 * lines too, so a single bad record can't wedge the stream.
	 */
	private function drain_buffer(): int {
		$max     = $this->line_mode ? 1 : \PHP_INT_MAX;
		$emitted = 0;
		$pos     = 0;
		while ( $emitted < $max ) {
			$nl = \strpos( $this->buffer, "\n", $pos );
			if ( false === $nl ) {
				break;
			}
			$this->forward_line( \substr( $this->buffer, $pos, $nl - $pos ), $this->cursor_off + $pos );
			$pos = $nl + 1; // past the consumed \n.
			++$emitted;
		}
		if ( $pos > 0 ) {
			$this->buffer      = \substr( $this->buffer, $pos );
			$this->cursor_off += $pos;
		}
		// Ran the buffer dry of complete lines (not just hit the cap) — the remainder is a
		// trailing partial; guard it against unbounded growth.
		if ( $emitted < $max ) {
			$this->discard_oversized_partial();
		}
		return $emitted;
	}

	/**
	 * Unpack one packed line and forward it to the sink: stamp FROM (breadcrumb), record the
	 * seg:offset breadcrumb in ID, force TO when a target is set. An unparseable line or an
	 * over-long FROM is logged and dropped — the callers own the cursor and advance past it
	 * regardless, so a single bad record can't wedge the stream.
	 *
	 * The per-line emit seam: Tail overrides this to emit raw bytes instead of unpacking a
	 * Message, reusing this class's buffer/cursor scan in drain_buffer().
	 */
	protected function forward_line( string $line, int $abs_offset ): void {
		$line_size = \strlen( $line ) + 1; // +1 for the consumed \n.
		if ( $line_size > $this->largest_msg_sent ) {
			$this->largest_msg_sent = $line_size;
		}
		try {
			$message = Message::unpacked( $line );
		} catch ( \InvalidArgumentException $e ) {
			$this->print_less_often( "WARNING: skipping unparseable line: {$e->getMessage()}" );
			return;
		}
		$stamp = '' !== $this->stamp_override ? $this->stamp_override : $this->name;
		if ( '' !== $stamp && ! $this->stamp_message( $message, $stamp ) ) {
			return; // FROM exceeded MAX_FROM_SIZE; drop_message handled.
		}
		// Position breadcrumb goes in ID; KEY must stay the producer's routing key.
		$message[ Message::ID ] = "{$this->cursor_seg}:{$abs_offset}";
		if ( \is_string( $this->target ) && '' !== $this->target ) {
			$message[ Message::TO ] = $this->target;
		}
		++$this->counter;
		$this->sink?->fill( $message );
	}

	/** DoS guard for a partial line that never terminates: discard once it can't fit a real line. */
	private function discard_oversized_partial(): void {
		if ( \strlen( $this->buffer ) <= self::MAX_LINE_BUFFER_SIZE ) {
			return;
		}
		$this->print_less_often(
			\sprintf( 'WARNING: line buffer exceeded %d bytes at seg %d - discarding', self::MAX_LINE_BUFFER_SIZE, $this->cursor_seg )
		);
		$this->set_state( 'OVERFLOW', \implode( ' ', [ 'SEGMENT', $this->cursor_seg, 'OFFSET', $this->cursor_off, 'LIMIT', self::MAX_LINE_BUFFER_SIZE ] ) );
		$this->cursor_off += \strlen( $this->buffer ); // Skip the garbage so polls don't re-read it.
		$this->buffer      = '';
	}

	/**
	 * Read at most one READ_BLOCK_BYTES block into $buffer (Tachikoma get_batch +
	 * Partition::process_get). Rolls to the next segment when the current one is
	 * drained, sets at_eof when caught up, and bounds a single oversized line.
	 */
	private function get_batch(): void {
		// Defeat the stat cache so growth from another process's writer is visible.
		\clearstatcache( true, $this->source()->partition_dir() );
		$segments = $this->source()->get_segments( true );
		if ( empty( $segments ) ) {
			$this->at_eof = true;
			return;
		}
		$this->normalize_cursor( $segments );

		$sizes       = \array_column( $segments, 'size', 'id' );
		$newest_id   = \end( $segments )['id'];
		$newest_size = \end( $segments )['size'];

		$seg_size = $sizes[ $this->cursor_seg ] ?? 0;
		$read_at  = $this->cursor_off + \strlen( $this->buffer );

		// Current segment fully read: step to the next live segment (one per poll) or rest at EOF.
		if ( $read_at >= $seg_size ) {
			$next = $this->next_segment_id( $segments, $this->cursor_seg );
			if ( null !== $next ) {
				$this->cursor_seg = $next;
				$this->cursor_off = 0;
				$this->buffer     = '';
				$this->at_eof     = false;
				$this->set_state( 'SEGMENT', (string) $this->cursor_seg );
				return;
			}
			// Nothing more on disk. drain_buffer ran first this tick, so the buffer
			// holds at most a trailing partial (never a complete line) here.
			$this->at_eof = true;
			return;
		}

		$len   = \min( self::READ_BLOCK_BYTES, $seg_size - $read_at );
		$bytes = $this->source()->read_at( $this->cursor_seg, $read_at, $len );
		// Consumers are the user-facing read nodes, so surface bytes_read here too.
		$this->bytes_read += \strlen( $bytes );
		$this->buffer     .= $bytes;

		// at_eof means "nothing left to do": caught up on disk AND no buffered line
		// still to drain. Leaving a pending line would back off to the EOF cadence
		// and stall the burst's trailing record ~100ms.
		$tail            = $this->cursor_off + \strlen( $this->buffer );
		$disk_caught_up  = ( $this->cursor_seg >= $newest_id ) && ( $tail >= $newest_size );
		$this->at_eof    = $disk_caught_up && ! $this->buffer_has_line();
	}

	/**
	 * Smallest live segment id greater than $after, or null when $after is the newest.
	 *
	 * @param array<int, array{id: int, size: int}> $segments Live segment list.
	 */
	private function next_segment_id( array $segments, int $after ): ?int {
		$next = null;
		foreach ( $segments as $s ) {
			if ( $s['id'] > $after && ( null === $next || $s['id'] < $next ) ) {
				$next = $s['id'];
			}
		}
		return $next;
	}

	/** True when $buffer holds at least one complete (newline-terminated) line still to drain. */
	private function buffer_has_line(): bool {
		return false !== \strpos( $this->buffer, "\n" );
	}

	/** Source Partition, materialized by arguments(). Throws if a read runs before configuration. */
	private function source(): Partition_Node {
		if ( null === $this->source ) {
			throw new \RuntimeException( 'Consumer source partition not initialized; call arguments() first' );
		}
		return $this->source;
	}

	/**
	 * Clamp the cursor against the live (non-empty) segment list.
	 *
	 * Two recoveries: the cursor segment was deleted by cleanup (rewind to the
	 * oldest segment), or it was wiped and recreated smaller — a full sweep
	 * restarts ids at 0, so a durable checkpoint can sit past EOF (rewind to
	 * the segment start instead of waiting forever for the file to grow back).
	 * Shared by poll() and compute_lag() so reads and lag agree on position.
	 *
	 * @param array<int, array{id: int, size: int}> $segments Live segment list.
	 */
	protected function normalize_cursor( array $segments ): void {
		$sizes = \array_column( $segments, 'size', 'id' );
		if ( ! isset( $sizes[ $this->cursor_seg ] ) ) {
			$this->cursor_seg = $segments[0]['id'];
			$this->cursor_off = 0;
			$this->buffer     = '';
		} elseif ( $sizes[ $this->cursor_seg ] < $this->cursor_off + \strlen( $this->buffer ) ) {
			$this->cursor_off = 0;
			$this->buffer     = '';
		}
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
		if ( ! \is_array( $entry ) || ! isset( $entry['seg'], $entry['off'] ) ) {
			return null;
		}
		return $entry;
	}

	/** Override the FROM-stamp used when emitting messages; '' falls back to $this->name. */
	public function set_stamp_as( string $stamp ): void {
		$this->stamp_override = $stamp;
	}

	/**
	 * Name the node whose state is snapshotted into the offsetlog alongside the
	 * cursor (Tachikoma's `connect_edge` + cache_type=snapshot). On checkpoint the
	 * named node's save_state() rides in the committed record; the first poll
	 * (poll_init) restores it into the by-then-built node. Recording the name is
	 * all this does — the restore is deferred so topology declaration order can't
	 * forward-reference a node that doesn't exist yet. Lifts the offsetlog's
	 * PIPE_BUF cap (void_warranty): the worker holding the topology lock is the
	 * offsetlog's sole writer, so no per-write lock is needed.
	 */
	public function set_snapshot_node( string $name ): void {
		$this->snapshot_node = $name;
		$this->offsetlog?->void_warranty();
	}

	public function set_line_mode( bool $flag ): void {
		$this->line_mode = $flag;
	}

	/**
	 * Generic dump_metadata hook: fold the consumer's time-travel READ surface into
	 * the canvas-poll payload the inspector already round-trips. CHEAP — the warm
	 * segments cache only (no record reads, no scandir on the poll path):
	 *   - `frames`: the offsetlog segment list `[{id,size}]` — one checkpoint = one
	 *     segment = one keyframe (the debugger ruler identifies a frame by its
	 *     segment id). Empty when the offsetlog is disabled (ephemeral consumers).
	 *   - `cursor`: the live source read position `{seg,off}`.
	 *   - `polling`: the current polling state (`INIT`, `ACTIVE`, `PAUSED`).
	 *   - `at_frame`: the offsetlog keyframe the cursor is at-or-just-past — its
	 *     current checkpoint. `rewound_to` when seeked, else the newest frame id when
	 *     live (the cursor reads forward from its last checkpoint), null only when
	 *     there are no frames yet. Used for BOTH live status and time-travel position.
	 *   - `on_frame`: the cursor is exactly on `at_frame`'s committed position vs
	 *     advanced past it. Seeked: `! stepped_since_seek`. Live: cursor == checkpoint
	 *     (a quiet consumer sits ON its last checkpoint; an actively-reading one is
	 *     past it). Reported so the panel's position survives a remount.
	 *
	 * @return array{frames: array<int, array{id:int,size:int}>, cursor: array{seg:int, off:int}, polling: string, at_frame: int|null, on_frame: bool}
	 */
	public function dump_metadata(): array {
		$frames    = $this->offsetlog?->get_segments() ?? [];
		$newest_id = empty( $frames ) ? null : \end( $frames )['id'];
		$at_frame  = $this->rewound_to ?? $newest_id;
		$on_frame  = null === $this->rewound_to
			? ( $this->cursor_seg === $this->checkpoint_seg && $this->cursor_off === $this->checkpoint_off )
			: ! $this->stepped_since_seek;
		return [
			'frames'   => $frames,
			'cursor'   => [ 'seg' => $this->cursor_seg, 'off' => $this->cursor_off ],
			'polling'  => Core::as_string( $this->set_state['POLLING'] ?? 'INIT' ),
			'at_frame' => $at_frame,
			'on_frame' => $on_frame,
		];
	}

	/** Hold the cursor and emit nothing until STEP / PLAY. */
	public function pause(): void {
		$this->stop_timer();
		$this->set_state( 'POLLING', 'PAUSED' );
	}

	/**
	 * Resume normal polling: restore the line_mode STEP captured (NOT hardcoded
	 * false — line_mode is a legitimate production setting), clear the saved field,
	 * and re-arm the fire() loop.
	 */
	public function play(): void {
		// If the consumer was rewound while paused, this is the commit-to-this-branch
		// moment: drop the now-stale forward keyframes so the re-written timeline stays
		// monotonic. The OFFSETLOG only — never the source log.
		if ( null !== $this->rewound_to ) {
			$this->offsetlog?->truncate_after( $this->rewound_to );
			$this->rewound_to = null;
		}
		$this->stepped_since_seek = false; // Going live: no longer off a seeked frame.
		if ( null !== $this->saved_line_mode ) {
			$this->line_mode      = $this->saved_line_mode;
			$this->saved_line_mode = null;
		}
		$this->set_timer( self::POLL_INTERVAL_BUSY_MS, true );
		$this->set_state( 'POLLING', 'ACTIVE' );
	}

	protected function check_name_availability( string $name ): void {
		parent::check_name_availability( $name );
		if ( null !== $this->source && null !== Core::node( "{$name}:source" ) ) {
			throw new \RuntimeException( \esc_html( "node name collision: {$name}:source already registered" ) );
		}
		if ( null !== $this->offsetlog && null !== Core::node( "{$name}:offsetlog" ) ) {
			throw new \RuntimeException( \esc_html( "node name collision: {$name}:offsetlog already registered" ) );
		}
	}

	protected function set_sibling_names( ?string $name = null ): void {
		$this->source?->name( "{$name}:source" );
		$this->offsetlog?->name( "{$name}:offsetlog" );
		parent::set_sibling_names( $name );
	}

	public function sink( ?Node $node = null ): ?Node {
		if ( \func_num_args() > 0 ) {
			if ( null !== $this->source ) {
				$this->source->sink( $node );
			}
			if ( null !== $this->offsetlog ) {
				$this->offsetlog->sink( $node );
			}
			return parent::sink( $node );
		}
		return parent::sink();
	}

	public function remove_node(): void {
		if ( null !== $this->source ) {
			$this->source->remove_node();
		}
		if ( null !== $this->offsetlog ) {
			$this->offsetlog->remove_node();
		}
		parent::remove_node();
	}
	/**
	 * `set_snapshot_node` verb handler — set the patron's snapshot-target node.
	 *
	 * @param Command_Interpreter_Node $interpreter Verb argument.
	 * @param string $args Verb argument.
	 *
	 * @return string
	 */
	public static function cmd_set_snapshot_node( Command_Interpreter_Node $interpreter, string $args ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->set_snapshot_node( \trim( $args ) );
		return 'ok';
	}

	/**
	 * `set_line_mode` verb handler — toggle the patron's line-mode framing.
	 *
	 * @param Command_Interpreter_Node $interpreter Verb argument.
	 *
	 * @return string
	 */
	public static function cmd_set_line_mode( Command_Interpreter_Node $interpreter ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->set_line_mode( true );
		return 'ok';
	}

	/**
	 * `SEEK_FRAME` verb handler — seek the patron consumer to a frame.
	 *
	 * @param Command_Interpreter_Node $interpreter Verb argument.
	 * @param string $args Verb argument.
	 *
	 * @return string
	 */
	public static function cmd_seek_frame( Command_Interpreter_Node $interpreter, string $args ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		return $patron->seek_frame( (int) \trim( $args ) );
	}

	/**
	 * `PAUSE` verb handler — pause the patron consumer.
	 *
	 * @param Command_Interpreter_Node $interpreter Verb argument.
	 *
	 * @return string
	 */
	public static function cmd_pause( Command_Interpreter_Node $interpreter ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->pause();
		return 'ok';
	}

	/**
	 * `PLAY` verb handler — resume the patron consumer.
	 *
	 * @param Command_Interpreter_Node $interpreter Verb argument.
	 *
	 * @return string
	 */
	public static function cmd_play( Command_Interpreter_Node $interpreter ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->play();
		return 'ok';
	}

	/**
	 * `STEP` verb handler — single-step the patron consumer.
	 *
	 * @param Command_Interpreter_Node $interpreter Verb argument.
	 *
	 * @return string
	 */
	public static function cmd_step( Command_Interpreter_Node $interpreter ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		return (string) \wp_json_encode( $patron->step() );
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'I/O',
			'description' => 'Tails a Partition; emits each appended message to its sink.',
			'arguments'        => [
				[ 'name' => 'source_dir',    'type' => 'string', 'required' => true ],
				[ 'name' => 'offsetlog_dir', 'type' => 'string', 'default' => '' ],
			],
			'commands'    => [
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
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $interpreter, string $args ): string => self::cmd_set_line_mode( $interpreter ),
				],
				[
					'name'        => 'SEEK_FRAME',
					'description' => 'Time-travel: jump to the offsetlog keyframe with segment id <segment_id> (from dump_metadata frames[].id), restoring its co-committed snapshot state. Stays paused.',
					// Driven by the Inspector's Time Travel transport bar; hide the
					// redundant standalone verb button.
					'hidden'      => true,
					'args'        => [
						[ 'name' => 'segment_id', 'type' => 'int', 'required' => true ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $interpreter, string $args ): string => self::cmd_seek_frame( $interpreter, $args ),
				],
				[
					'name'        => 'PAUSE',
					'description' => 'Time-travel: stop the poll timer; the consumer holds its cursor until STEP / PLAY.',
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
					// A COMMAND, not a request: STEP mutates (emits a message + advances the
					// durable cursor), so it must ride the auth-gated interpreter path —
					// handle_request() (the TM_REQUEST path) bypasses interpret()'s auth gate.
					'name'        => 'STEP',
					'description' => 'Time-travel: emit at most one message (forces line granularity, implies PAUSE) and reply with the {seg,off,at_eof} cursor as JSON.',
					'hidden'      => true,
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $interpreter, string $args ): string => self::cmd_step( $interpreter ),
				],
			],
			'requests'    => [
				[
					'name'        => 'GET_LAG',
					'description' => 'Bytes/messages behind the source partition tail.',
					'reply_shape' => '{ bytes_behind, segments_behind, caught_up }',
				],
			],
			'accepts_fill' => false,
		] );
	}

}
