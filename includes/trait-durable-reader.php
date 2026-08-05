<?php
/**
 * Durable_Reader: the durable log-reader spine — offsetlog cursor, timer-driven
 * buffered pump, and the pause/step/seek time-travel debugger, in ONE unit.
 *
 * Formerly three sibling traits (Offsetlog_Cursor, Buffered_Pump, Time_Travel)
 * that were only ever consumed together, by Consumer_Node and
 * Remote_Source_Node — the split was false modularity ([159]); Time_Travel's
 * docblock literally required the other two. The genuinely reusable pieces
 * stay separate: `Sidecar` (any node building sibling Partitions),
 * `Dead_Letter_Queue` (also the write-side quarantine on Partition itself),
 * and `Deferred_Clean_Stop` (application snapshot nodes in sibling plugins).
 *
 * Section order below preserves the old files: cursor, then pump, then
 * time-travel.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

trait Durable_Reader {
	use Dead_Letter_Queue;

	use Sidecar;

	// -- Offsetlog cursor ---------------------------------------------------

	/**
	 * Offsetlog as an exact keyframe timeline for time-travel: segment_size=1 forces one
	 * checkpoint = one segment = one frame, uniformly for stateless readers (small offset
	 * records) and stateful/snapshot ones (offset + cache). Partition's do_rotate() adopts
	 * the still-empty newest segment on the first commit, then rotates to a fresh segment
	 * on every later commit (current_size ≥ 1 > the 1-byte threshold) — so segment_size=1
	 * produces no empty-segment spam.
	 *
	 * Retention is the three-rule scheme (see Partition_Node): keep at least 10 keyframes
	 * and a count target of 30, holding anything younger than 5 minutes even when over the
	 * count, pruning anything older than 15 minutes back down to the floor, and a hard cap
	 * of 60 that bounds a very hot cursor whose keyframes are all younger than 5 minutes.
	 */
	public const OFFSETLOG_SEGMENT_SIZE = 1;
	public const OFFSETLOG_MIN_SEGMENTS = 10;
	public const OFFSETLOG_NUM_SEGMENTS = 30;
	public const OFFSETLOG_MIN_LIFETIME = 300;
	public const OFFSETLOG_LIFETIME     = 900;
	public const OFFSETLOG_MAX_SEGMENTS = 60;

	/** Durable offsetlog Partition; null until built (ephemeral nodes skip it). */
	protected ?Partition_Node $offsetlog = null;

	/**
	 * Durable read-cursor dir. An ARGUMENT, not a Config read: an offsetlog is a
	 * reader's cursor, so a topology must be able to write the path — that's what
	 * lets it carry `<topology>` and keeps two fleets pulling one spoke partition
	 * off each other's cursor. Empty disables checkpointing.
	 */
	protected string $offsetlog_dir = '';

	/** Where the offsetlog lives. Override to derive an implicit dir. */
	protected function offsetlog_dir(): string {
		return $this->offsetlog_dir;
	}

	/** What it answers to. Override to qualify the name (e.g. by remote partition). */
	protected function offsetlog_name(): string {
		return '' !== $this->name ? "{$this->name}:offsetlog" : '';
	}

	/**
	 * Build + register the offsetlog Partition once (idempotent). The sidecar inherits
	 * its patron's sink, which make_node always sets to _command_interpreter — flow is
	 * steered by target(), so a sink is control-plane, and the offsetlog's belongs there.
	 */
	protected function ensure_offsetlog(): ?Partition_Node {
		if ( null !== $this->offsetlog ) {
			return $this->offsetlog;
		}
		$dir = $this->offsetlog_dir();
		if ( '' === $dir ) {
			return null;
		}
		$this->offsetlog = $this->make_sidecar( $dir, $this->offsetlog_name(), [
			self::OFFSETLOG_SEGMENT_SIZE,
			self::OFFSETLOG_MIN_SEGMENTS,
			self::OFFSETLOG_NUM_SEGMENTS,
			self::OFFSETLOG_MAX_SEGMENTS,
			self::OFFSETLOG_MIN_LIFETIME,
			self::OFFSETLOG_LIFETIME,
		] );
		return $this->offsetlog;
	}

	/**
	 * Read the newest committed frame's VALUE, or null when there's nothing to
	 * resume from. Reads the last segment; when its tail is empty (a
	 * rotated-but-unwritten newest segment) it falls back to the prior segment,
	 * then unpacks the last parseable line. Returns the raw VALUE array — each
	 * caller reads its own fields out of it.
	 *
	 * @return array<array-key, mixed>|null
	 */
	protected function read_last_offsetlog_frame(): ?array {
		if ( null === $this->offsetlog ) {
			return null;
		}
		$segments = $this->offsetlog->get_segments( true );
		if ( empty( $segments ) ) {
			return null;
		}
		$last    = \end( $segments );
		$content = $this->offsetlog->read_at( $last['id'], 0, $last['size'] );
		if ( '' === $content && \count( $segments ) > 1 ) {
			$prev    = $segments[ \count( $segments ) - 2 ];
			$content = $this->offsetlog->read_at( $prev['id'], 0, $prev['size'] );
		}
		if ( '' === $content ) {
			return null;
		}
		$lines = \array_filter( \explode( "\n", $content ), static fn ( $l ) => '' !== $l );
		if ( empty( $lines ) ) {
			return null;
		}
		try {
			$message = Message::unpacked( \end( $lines ) );
		} catch ( \InvalidArgumentException $e ) {
			$this->print_less_often( 'ignoring unparseable offsetlog entry: ', $e->getMessage() );
			return null;
		}
		$value = $message[ Message::VALUE ];
		return \is_array( $value ) ? $value : null;
	}

	/**
	 * Commit one frame: mint a TM_STRUCT Message stamped FROM this node, carry the
	 * caller's VALUE, fill the offsetlog and flush synchronously (don't wait on the
	 * Partition's PIPE_BUF threshold — a cursor frame must be durable now).
	 *
	 * @param array<array-key, mixed> $value The caller-owned frame schema.
	 */
	protected function commit_offsetlog_frame( array $value ): void {
		if ( null === $this->offsetlog ) {
			return;
		}
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_STRUCT;
		$message[ Message::TIMESTAMP ] = Core::$now;
		$message[ Message::FROM ]      = $this->name;
		$message[ Message::VALUE ]     = $value;
		$this->offsetlog->fill( $message );
		$this->offsetlog->flush();
	}

	// -- Buffered pump ------------------------------------------------------


	public const MAX_LINE_BUFFER_SIZE = 33554432;

	/** 0 = next event-loop iteration. */
	public const POLL_INTERVAL_BUSY_MS = 0;

	public const POLL_INTERVAL_EOF_MS = 100;

	protected bool $at_eof = true;
	protected int $boot_cursor_offset = 0;

	/**
	 * The cursor this process booted on (seeded by load_offsetlog). Advancing past it
	 * is "forward progress" — the poison region is behind us, so attempts resets to the
	 * healthy baseline. Also the fair-shot proxy for cooperative-stop strikes ([42]).
	 */
	protected int $boot_cursor_segment = 0;

	/** Bytes read past cursor_offset but not yet emitted (read-ahead + trailing partial). Tachikoma's buffer. */
	protected string $buffer = '';

	/** Durable read offset for cursor_segment; always a line boundary (last fully-emitted line). */
	protected int $cursor_offset = 0;

	/** Cursor segment. cursor_offset + buffer length is the next read position. */
	protected int $cursor_segment = 0;

	/**
	 * Per-tick dispatch (Tachikoma's `$self->{fill}` function pointer). arguments()
	 * points this at poll_init; the first poll loads the durable cursor + restores
	 * the snapshot — by which time the whole topology is built — then swaps to
	 * poll_active. Keeps construction free of I/O and forward-reference order.
	 */
	protected ?\Closure $poll_cb = null;

	/**
	 * True once poll_init has seeded the durable cursor. A shutdown handoff before this
	 * (worker stopped on its first should_continue, before the first poll) must NOT write
	 * the 0:0 construction-default cursor — it would clobber the real durable position.
	 */
	protected bool $poll_initialized = false;

	/** True once next_offset() was called explicitly — suppresses the default_offset() seek. */
	protected bool $offset_set = false;

	/** FROM-stamp override read by forward_line(); defaults to $this->name. The IPC input-Consumer stamps as `_repl`. */
	protected string $stamp_override = '';

	/**
	 * True once a downstream fill() raised Worker_Should_Stop through forward_line — the
	 * worker was actively DISPATCHING a message when the cooperative stop hit. The
	 * fair-shot strike requires this: a merely-buffered (never-dispatched) head is a
	 * message that just arrived, not one that consumed a lifetime ([42]).
	 */
	protected bool $stopped_in_fill = false;

	/**
	 * Opt-in for a chain whose sink writes the message DURABLY before the stop and has no
	 * snapshot node to raise Worker_Should_Stop_Clean (a plain Consumer→Partition: the
	 * aggregator, a Job_Router → jobs.log, replication). When set, a plain
	 * Worker_Should_Stop is treated like Clean — the in-flight message is committed past
	 * instead of replayed — so a recycle doesn't duplicate the already-written message.
	 *
	 * Do NOT set this on a Consumer whose sink RUNS work that can stop mid-flight with no
	 * durable write (a Job_Worker handler that pumps mid-job): committing past would drop
	 * a half-run job. Default off keeps at-least-once replay for those ([ADR-8]).
	 */
	protected bool $assume_clean_shutdown = false;

	/** Verb-backed toggle for assume_clean_shutdown (durable-before-stop chains commit past). */
	public function set_assume_clean_shutdown( bool $flag ): void {
		$this->assume_clean_shutdown = $flag;
	}

	/**
	 * Config-verb fragment; the using node splices this into its node_schema commands.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public static function pump_verbs(): array {
		return [
			[
				'name'        => 'assume_clean_shutdown',
				'description' => 'Treat a plain Worker_Should_Stop like Worker_Should_Stop_Clean — commit PAST the in-flight message on a cooperative stop instead of replaying it. For a durable-before-stop chain with no snapshot node (aggregator, Consumer→Partition, job-router). Only a truthy arg enables.',
				'args'        => [
					[ 'name' => 'enabled', 'type' => 'bool', 'required' => false, 'description' => 'A truthy value (1/true/yes/on) enables; anything else disables.' ],
				],
				'toggle'      => 'assume_clean_shutdown',
			],
		];
	}

	/** Timer-driven: poll, periodically checkpoint the cursor, then re-arm (busy/EOF cadence). */
	protected function fire(): void {
		$this->poll();
		// poll() moves the cursor in memory; checkpoint() makes it durable.
		if ( null !== $this->offsetlog && $this->checkpoint_due() ) {
			$this->checkpoint();
			// Skip paths let an idle cursor re-throttle each interval.
			$this->last_checkpoint = Core::$now;
		}
		$next_ms = $this->at_eof ? self::POLL_INTERVAL_EOF_MS : self::POLL_INTERVAL_BUSY_MS;
		$this->set_timer( $next_ms, true ); // oneshot — fire() re-arms.
	}

	/** One tick. Dispatches through poll_cb: poll_init on the first call, poll_active after. */
	public function poll(): void {
		( $this->poll_cb ?? ( $this->poll_cb = $this->poll_init( ... ) ) )();
	}

	/**
	 * INIT phase (Tachikoma's status INIT → ACTIVE): boot the durable position via the
	 * source-specific init_position() seam. Runs on the first poll — inside the drain
	 * loop, after the whole topology is built — so a snapshot node the seam restores
	 * exists no matter what order the topology declared it. Then freeze the boot cursor,
	 * become the steady-state poller, and fall through to it so this tick still does work.
	 */
	protected function poll_init(): void {
		$this->init_position();
		// Freeze the boot cursor so cursor_advanced_since_boot() stays honest.
		$this->boot_cursor_segment = $this->cursor_segment;
		$this->boot_cursor_offset  = $this->cursor_offset;
		$this->poll_initialized    = true;
		$this->set_state( 'READY', $this->name );
		// crawl set once at boot (hard-crash lineage), never re-entered.
		$this->poll_cb = $this->crawl ? $this->poll_crawl( ... ) : $this->poll_active( ... );
		( $this->poll_cb )();
	}

	/**
	 * One ACTIVE-phase tick: drain the buffer, then top it up. Batch pipelines (read a block
	 * every tick — this tick's read drains next tick), so it stays at full throughput and
	 * reaches EOF promptly. Line mode reads only once the buffer is dry of complete lines, so
	 * it never reads ahead and the one-line-per-tick pacing holds.
	 */
	protected function poll_active(): void {
		$this->refill( $this->drain_buffer() );
	}

	/**
	 * One CRAWL-phase tick (hard-crash lineage): drain one line, checkpoint per message so an
	 * uncatchable crash pins the exact in-flight offset, then refill. On surviving a full
	 * interval crash-free, exit crawl and swap dispatch back to poll_active for the next tick.
	 */
	protected function poll_crawl(): void {
		$drained = $this->drain_buffer();
		// Exit crawl only once head sacrificed; else crash loop re-arms.
		if ( ! $this->crawl_skip_head && $this->crawl_interval_elapsed() ) {
			// Force-write reset even at unchanged cursor; else attempts pin.
			$this->exit_crawl();
			$this->poll_cb = $this->poll_active( ... );
			$this->write_checkpoint_frame( false, true );
		} elseif ( $drained > 0 ) {
			// Per-message checkpoint (drain_buffer caps crawl at one line).
			$this->checkpoint();
		}
		$this->refill( $drained );
	}

	/** Top the buffer up from the source, unless line-mode is pacing one line per tick. */
	private function refill( int $drained ): void {
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
	 * pass (no substr-per-line) and an empty line is consumed cleanly. Advancing cursor_offset in lockstep with
	 * the chop is load-bearing: get_batch reads at `cursor_offset + strlen(buffer)`, so a chop
	 * without the matching cursor bump re-reads the gap and mis-aligns the next line into
	 * unparseable garbage. The cursor advances past skipped (unparseable / over-long-FROM)
	 * lines too, so a single bad record can't wedge the stream.
	 */
	private function drain_buffer(): int {
		// Crawl forces one line per drain so poll_crawl checkpoints each msg.
		$max     = ( $this->line_mode || $this->crawl ) ? 1 : \PHP_INT_MAX;
		$emitted = 0;
		$pos     = 0;
		// finally: a propagated Worker_Should_Stop still advances the cursor.
		try {
			while ( $emitted < $max ) {
				$nl = \strpos( $this->buffer, "\n", $pos );
				if ( false === $nl ) {
					break;
				}
				$line = \substr( $this->buffer, $pos, $nl - $pos );
				try {
					$this->drain_line( $line, $this->cursor_offset + $pos );
				} catch ( Worker_Should_Stop_Clean $e ) {
					// Fully processed: commit past it; plain stop replays.
					$pos = $nl + 1;
					throw $e;
				}
				$pos = $nl + 1; // past the consumed \n.
				++$emitted;
			}
		} finally {
			if ( $pos > 0 ) {
				$this->buffer = \substr( $this->buffer, $pos );
				$this->advance_consume_cursor( $pos );
			}
		}
		// Buffer dry of lines: the remainder is a partial — guard its growth.
		if ( $emitted < $max ) {
			$this->discard_oversized_partial();
		}
		return $emitted;
	}

	/**
	 * Per-line drain seam: dispatch ONE complete line. The default handles the one-shot boot
	 * head-skip (crash-crawl sacrifice / quarantine-marker drop) then delegates to forward_line
	 * — so a forward_line-overriding subclass (Tail) still
	 * inherits the skip-head handling. A push source (Remote_Source) overrides this to run the
	 * crumb-vs-boot-pin 3-way compare (its stream can resume PAST a GC'd suspect, so an armed head
	 * is not unconditionally the first drained line).
	 */
	protected function drain_line( string $line, int $abs_offset ): void {
		if ( $this->crawl_skip_head ) {
			// One-shot boot head-skip; $abs_offset is the head start.
			$this->crawl_skip_head = false;
			if ( 'drop' === $this->skip_head_disposition ) {
				// Marker: head already in the DLQ — drop, no second entry.
				$this->print_less_often( "DROP [quarantined] {$this->name} at ", "{$this->cursor_segment}:{$this->cursor_offset}", ' — already dead-lettered' );
			} else {
				// Sacrifice head to DLQ, then quarantine-mark its start.
				$this->dead_letter( $this->poison_from_line( $line, $this->cursor_segment, $abs_offset ), 'crash' );
				$this->write_checkpoint_frame( false, true, [ 'quarantined' => true ] );
			}
			return;
		}
		$this->forward_line( $line, $abs_offset );
	}

	/**
	 * Consume-cursor advance seam: after drain_buffer chops the emitted lines off the buffer,
	 * advance the durable read offset by the chopped byte count. Consumer's cursor IS the disk
	 * read position, so it bumps by the chop; a push source (Remote_Source) derives its cursor
	 * from each line's own breadcrumb in forward_line, so it overrides this to a no-op (the local
	 * buffer chop index is not a remote seg:offset).
	 */
	protected function advance_consume_cursor( int $pos ): void {
		$this->cursor_offset += $pos;
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
			// Won't unpack, never will: quarantine; cursor advances.
			$this->dead_letter( $this->poison_from_line( $line, $this->cursor_segment, $abs_offset ), 'unparseable', $e );
			return;
		}
		$stamp = '' !== $this->stamp_override ? $this->stamp_override : $this->name;
		if ( '' !== $stamp && ! $this->stamp_message( $message, $stamp ) ) {
			return; // FROM exceeded MAX_FROM_SIZE; drop_message handled.
		}
		// ID breadcrumb = seg:offset:length (length for SSE_In's reconnect).
		$message[ Message::ID ] = "{$this->cursor_segment}:{$abs_offset}:{$line_size}";
		if ( \is_string( $this->target ) && '' !== $this->target ) {
			$message[ Message::TO ] = $this->target;
		}
		try {
			$this->sink?->fill( $message );
			// Count only a successful forward, not a re-delivered stop/throw.
			++$this->counter;
		} catch ( Worker_Should_Stop_Clean $e ) {
			// Forwarded before the stop (count it); not poison.
			++$this->counter;
			throw $e;
		} catch ( Worker_Should_Stop $e ) {
			// Not in crawl: its pin isolates a crash suspect, no commit-past.
			if ( $this->assume_clean_shutdown && ! $this->crawl ) {
				// Durable chain, no snapshot: commit past like a clean stop.
				++$this->counter;
				throw new Worker_Should_Stop_Clean();
			}
			// Control flow, not poison: record mid-dispatch stop, then escape.
			$this->stopped_in_fill = true;
			throw $e;
		} catch ( \Throwable $e ) {
			$this->dead_letter( $message, 'throw', $e );
		}
	}

	/** First complete (newline-terminated) line buffered at the cursor, or null when none is in flight. */
	private function buffer_head_line(): ?string {
		$nl = \strpos( $this->buffer, "\n" );
		return false === $nl ? null : \substr( $this->buffer, 0, $nl );
	}

	/** True when $buffer holds at least one complete (newline-terminated) line still to drain. */
	private function buffer_has_line(): bool {
		return false !== \strpos( $this->buffer, "\n" );
	}

	/** DoS guard for a partial line that never terminates: discard once it can't fit a real line. */
	private function discard_oversized_partial(): void {
		if ( \strlen( $this->buffer ) <= self::MAX_LINE_BUFFER_SIZE ) {
			return;
		}
		$this->print_less_often(
			\sprintf( 'WARNING: line buffer exceeded %d bytes at seg ', self::MAX_LINE_BUFFER_SIZE ),
			(string) $this->cursor_segment,
			' - discarding'
		);
		$this->set_state( 'OVERFLOW', \implode( ' ', [ 'SEGMENT', $this->cursor_segment, 'OFFSET', $this->cursor_offset, 'LIMIT', self::MAX_LINE_BUFFER_SIZE ] ) );
		$this->cursor_offset += \strlen( $this->buffer ); // Don't re-read it.
		$this->buffer      = '';
	}

	/**
	 * Cooperative-stop checkpoint ([42]): the fair-shot rule for a timeout / memory
	 * stop. Called at worker shutdown INSTEAD of the graceful checkpoint() when the
	 * stop was cooperative — it decides whether the in-flight message earned a strike.
	 *
	 * Fair-shot proxy: a strike counts ONLY when the worker stopped on the message it
	 * BOOTED on (the cursor never advanced this lifetime) with that message still
	 * buffered (un-forwarded). An advanced cursor is a late "sliver" / a normal
	 * memory-recycle, and an empty buffer is an idle worker — neither is poison, so
	 * both hand off cleanly (attempts=0). At COOP_MAX_ATTEMPTS strikes the message is
	 * quarantined and the cursor advances past it, handing off at the virgin baseline.
	 *
	 * @param string $reason                 'timeout' | 'memory'.
	 * @param bool   $baseline_near_watermark Memory-only: the fresh post-reset baseline
	 *                                        was already near the watermark, so a leak /
	 *                                        undersized memory_limit — not this message —
	 *                                        is to blame. Alert, do not strike.
	 */
	public function cooperative_stop( string $reason, bool $baseline_near_watermark ): void {
		if ( null === $this->offsetlog || ( ! $this->poll_initialized && ! $this->offset_set ) ) {
			return; // Ephemeral / unestablished 0:0 cursor — nothing to strike.
		}
		// Strike only a still-buffered boot-cursor msg stopped mid-dispatch.
		$head = $this->buffer_head_line();
		if ( null === $head || ! $this->stopped_in_fill || $this->cursor_advanced_since_boot() ) {
			$this->checkpoint( true );
			return;
		}
		if ( 'memory' === $reason && $baseline_near_watermark ) {
			$this->print_less_often( "WARNING: {$this->name} baseline memory near the watermark at a cooperative stop — raise memory_limit or investigate a leak; not striking the in-flight message" );
			$this->checkpoint( true );
			return;
		}
		// Boot-cursor message got a full lifetime; we stopped on it: strike.
		if ( $this->record_poison_strike( $reason ) ) {
			// Quarantine head; hand off a MARKER; the successor drops it.
			$this->dead_letter( $this->poison_from_line( $head, $this->cursor_segment, $this->cursor_offset ), $reason );
			$this->write_checkpoint_frame( true, true, [ 'quarantined' => true ] );
			return;
		}
		// Record the strike at the unchanged cursor; the respawn climbs it.
		$this->write_checkpoint_frame( false, true );
	}

	/** True once the read cursor has moved past the cursor this process booted on. */
	private function cursor_advanced_since_boot(): bool {
		return $this->cursor_segment > $this->boot_cursor_segment
			|| ( $this->cursor_segment === $this->boot_cursor_segment && $this->cursor_offset > $this->boot_cursor_offset );
	}

	/**
	 * Refill seam: ensure the buffer is topped up from the source. Consumer_Node
	 * implements it as a synchronous READ_BLOCK_BYTES disk read; a push node
	 * (Remote_Source_Node) implements it as an async "arm the curl valve" — bytes
	 * arrive later via the drain loop. The pump already tolerates an empty buffer
	 * this tick (the at_eof cadence), so "armed, nothing arrived yet" needs no case.
	 */
	abstract protected function get_batch(): void;

	/**
	 * Boot seam: seed the durable read position on the first poll — Consumer seeds from
	 * the offsetlog + a default seek; a push source (Remote_Source) restores its position
	 * and arms its valve. poll_init freezes the boot cursor at whatever this leaves.
	 */
	abstract protected function init_position(): void;

	/** Durable-commit seam: commit the current cursor as an offsetlog checkpoint frame. */
	abstract protected function checkpoint( bool $graceful = false ): void;

	/** Durable-commit seam: write one offsetlog frame at the current cursor (unconditional; no advance-guard). */
	abstract protected function write_checkpoint_frame( bool $graceful, bool $with_state, array $extra = [] ): void;

	// -- Time travel --------------------------------------------------------


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
	 * Names of nodes whose state rides in the offsetlog alongside the cursor
	 * (Tachikoma's snapshot cache), keyed into the frame's `cache` map by name.
	 * Empty = offset-only. Appended via add_snapshot_node. A node with no
	 * snapshot concern (Remote_Source) leaves it [] and the restore branches no-op.
	 *
	 * @var list<string>
	 */
	private array $snapshot_nodes = [];

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
		$cache = \is_array( $entry['cache'] ?? null ) ? $entry['cache'] : [];
		foreach ( $this->snapshot_nodes as $snapshot_name ) {
			$node  = Core::node( $snapshot_name );
			$state = $cache[ $snapshot_name ] ?? null;
			if ( \is_array( $state ) && null !== $node && \method_exists( $node, 'restore_state' ) ) {
				$node->restore_state( $state );
			}
		}
		$this->next_offset( [ 'segment' => $entry['segment'], 'offset' => $entry['offset'] ] );
		// Record the rewind point: PLAY truncates after it to stay monotonic.
		$this->rewound_to         = $segment;
		$this->stepped_since_seek = false; // A fresh seek sits ON the keyframe.
		return "ok\n";
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
	 * Add a node whose state is snapshotted into the offsetlog alongside the
	 * cursor (Tachikoma's `connect_edge` + cache_type=snapshot); states commit as
	 * one `cache` map keyed by node name, all at the same cursor. Recording the
	 * name is all this does — the restore is deferred so topology declaration
	 * order can't forward-reference a node that doesn't exist yet. Lifts the
	 * offsetlog's PIPE_BUF cap (void_warranty): the worker holding the topology
	 * lock is the offsetlog's sole writer, so no per-write lock is needed.
	 */
	public function add_snapshot_node( string $name ): void {
		if ( '' === $name || \in_array( $name, $this->snapshot_nodes, true ) ) {
			return;
		}
		$this->snapshot_nodes[] = $name;
		$this->offsetlog?->void_warranty();
	}

	public function set_line_mode( bool $flag ): void {
		$this->line_mode = $flag;
	}

	/**
	 * Round-trippable `command_node {name}:config <verb>` lines for the PERSISTENT time-travel
	 * config the trait owns — so a `dump_config()` serialize/replay restores them
	 * (without it, a console-serialized topology loses its snapshot node and the
	 * downstream stateful node's save_state() stops co-committing). Only the durable
	 * settings round-trip: `snapshot_nodes` and `line_mode` (the production value —
	 * `saved_line_mode` holds it while a transient STEP session forces line_mode on).
	 * The imperative verbs (SEEK_FRAME/PAUSE/PLAY/STEP) are runtime, not config.
	 *
	 * @param string $name Node name the verbs address.
	 * @return string Zero or more trailing-newline-terminated `cmd` lines.
	 */
	protected function dump_time_travel_config( string $name ): string {
		$out = '';
		foreach ( $this->snapshot_nodes as $snapshot_name ) {
			$out .= "command_node {$name}:config add_snapshot_node {$snapshot_name}\n";
		}
		if ( $this->saved_line_mode ?? $this->line_mode ) {
			$out .= "command_node {$name}:config set_line_mode 1\n";
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
	 * `add_snapshot_node` verb handler — append a snapshot-target node.
	 *
	 * @param Command_Interpreter_Node $interpreter Verb argument.
	 * @param array<array-key, mixed>  $args        Verb argument.
	 */
	public static function cmd_add_snapshot_node( Command_Interpreter_Node $interpreter, array $args ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->add_snapshot_node( Core::as_string( $args[0] ?? '' ) );
		return "ok\n";
	}

	/**
	 * `SEEK_FRAME` verb handler — seek the patron reader to a frame.
	 *
	 * @param Command_Interpreter_Node $interpreter Verb argument.
	 * @param array<array-key, mixed>  $args        Verb argument.
	 */
	public static function cmd_seek_frame( Command_Interpreter_Node $interpreter, array $args ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		return $patron->seek_frame( Core::as_int( $args[0] ?? '' ) );
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
		return "ok\n";
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
		return "ok\n";
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
				'name'        => 'add_snapshot_node',
				'description' => 'Co-commit a named node\'s save_state() into the offsetlog alongside the cursor (keyed by name; repeatable), so each resumes its in-flight state on respawn (Tachikoma snapshot cache). Lifts the offsetlog PIPE_BUF cap (single-writer).',
				'args'        => [
					[ 'name' => 'node', 'type' => 'node_name', 'required' => true ],
				],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_add_snapshot_node( $interpreter, $args ),
			],
			[
				'name'        => 'set_line_mode',
				'description' => 'Fine-grained drain mode: emits one line per event cycle',
				'args'        => [
					[ 'name' => 'enabled', 'type' => 'bool', 'required' => false ],
				],
				'toggle'      => 'line_mode',
				// dump_time_travel_config owns the dump (PAUSE parks it).
				'dump'        => false,
			],
			[
				'name'        => 'SEEK_FRAME',
				'description' => 'Time-travel: jump to the offsetlog keyframe with segment id <segment> (from dump_metadata frames[].id), restoring its co-committed snapshot state. Stays paused.',
				// Driven by the Inspector transport bar; hide the verb button.
				'hidden'      => true,
				'args'        => [
					[ 'name' => 'segment', 'type' => 'int', 'required' => true ],
				],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_seek_frame( $interpreter, $args ),
			],
			[
				'name'        => 'PAUSE',
				'description' => 'Time-travel: stop the poll timer; the reader holds its cursor until STEP / PLAY.',
				'hidden'      => true,
				'args'        => [],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_pause( $interpreter ),
			],
			[
				'name'        => 'PLAY',
				'description' => 'Time-travel: restore the pre-STEP line_mode and resume the poll loop.',
				'hidden'      => true,
				'args'        => [],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_play( $interpreter ),
			],
			[
				// STEP mutates: auth-gated command path, not TM_REQUEST.
				'name'        => 'STEP',
				'description' => 'Time-travel: emit at most one message (forces line granularity, implies PAUSE) and reply with the {seg,off,at_eof} cursor as JSON.',
				'hidden'      => true,
				'args'        => [],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_step( $interpreter ),
			],
		];
	}
}
