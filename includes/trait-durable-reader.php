<?php
/**
 * Durable_Reader: the durable log-reader spine — offsetlog cursor, timer-driven
 * buffered pump, and the pause/step/seek time-travel debugger, in ONE unit.
 *
 * The three are one trait because they are one mechanism ([159]): the pump advances
 * the cursor, the offsetlog commits it as a keyframe, and the debugger seeks by
 * repositioning it. Consumer_Node and Remote_Source_Node take all three together.
 *
 * The pieces a node reuses on their own stay separate — `Sidecar` (any node building
 * a sibling Partition), `Dead_Letter_Queue` (also the write-side quarantine on
 * Partition itself) and `Deferred_Clean_Stop` (application snapshot nodes in sibling
 * plugins).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Durable-reader mixin: what a using class owes, and what it gets back.
 *
 * The class must be a `Timer_Node`: the pump is timer-driven, and `fire()` here is the
 * tick that drains and re-arms the busy/EOF cadence (Remote_Source overrides it to
 * service its channel on the same rule). It must fill seven seams: where the
 * bytes come from (`get_batch`), where a fresh reader starts (`init_position`), how
 * one frame reaches disk (`write_checkpoint_frame`) and what that frame carries
 * beyond the shared base (`checkpoint_frame_extra`), and how the debugger moves the
 * cursor (`next_offset`, `advance_one_message`, `time_travel_resume`). In return it
 * gets the durable cursor, the drain loop, the poison lifecycle and the debugger
 * verbs.
 *
 * `Dead_Letter_Queue` and `Sidecar` ride in with it. The cursor decides WHEN a record
 * is quarantined and where the reader resumes afterwards, so the trait owning the
 * cursor owns the quarantine too.
 */
trait Durable_Reader {
	use Dead_Letter_Queue;

	use Sidecar;

	/**
	 * One-shot crawl-entry flag: on the first crawled drain, dead-letter the boot-cursor head —
	 * the message the reader was on when the uncatchable death struck (the crash suspect) — with
	 * reason 'crash' and advance past it. Lineage accounting, not read-loop machinery, so it lives
	 * here and both readers arm it on crawl entry: Consumer sacrifices its buffered head line
	 * (per-line drain), Remote_Source the relayed message whose crumb START matches the boot pin.
	 */
	protected bool $crawl_skip_head = false;

	/**
	 * The record currently being drained, as crumb_for_line() placed it. Read by
	 * advance_consume_cursor after the dispatch, and stamped into the forwarded message's ID.
	 *
	 * @var array{segment:int, offset:int, length:int}
	 */
	protected array $crumb = [ 'segment' => 0, 'offset' => 0, 'length' => 0 ];

	/**
	 * Set by a drain that DISPOSED of its record — dead-lettered or dropped it rather than
	 * forwarding it. The drain loop consumes the flag after advancing past the record: the
	 * position is now clean, so it commits there gracefully, which both stops a crash from
	 * re-dead-lettering the same record and keeps the disposal from reading as a crash lineage
	 * the next boot would sacrifice an innocent head for.
	 */
	protected bool $disposed_record = false;

	/**
	 * Arm the boot-time head skip from a restored frame: a hard-crash lineage (via
	 * resume_attempts_from_frame) arms the DLQ 'crash' sacrifice of the resumed head, which
	 * the crawl pre-dispatch pin makes the message that was in flight when the death struck.
	 * A disposal commits gracefully past its record, so a poison position never arms this.
	 * Shared by Consumer (load_offsetlog) and Remote_Source (restore_position).
	 *
	 * @param array<array-key,mixed> $entry The restored frame VALUE.
	 * @return bool True when the head skip is armed.
	 */
	protected function arm_skip_head_from_frame( array $entry ): bool {
		if ( $this->resume_attempts_from_frame( $entry ) ) {
			$this->crawl_skip_head = true;
		}
		return $this->crawl_skip_head;
	}

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

	/**
	 * Build the offsetlog Partition for the CONFIGURED dir, then publish it into
	 * its `offsetlog` slot. The sidecar inherits its patron's sink, which
	 * make_node always sets to _command_interpreter — flow is steered by target(), so
	 * a sink is control-plane, and the offsetlog's belongs there.
	 *
	 * Idempotent on the dir, not on the property: `arguments()` is a replay
	 * setter, so an incumbent built for a dir the args have since superseded
	 * goes on committing the cursor where nothing reads it. Retracting here is
	 * what covers every reader — the two that build their sidecars from
	 * `arguments()` and the one that builds them lazily — without any of them
	 * spelling the rule again.
	 *
	 * @return Partition_Node|null The offsetlog, or null when the configured dir is empty.
	 */
	protected function ensure_offsetlog(): ?Partition_Node {
		$dir = \rtrim( $this->offsetlog_dir(), '/' );
		if ( null !== $this->offsetlog && $dir === $this->offsetlog->partition_dir() ) {
			return $this->offsetlog;
		}
		$this->retract_sibling( 'offsetlog' );
		$this->offsetlog = null;
		if ( '' === $dir ) {
			return null;
		}
		$offsetlog = $this->make_sidecar( $dir, [
			self::OFFSETLOG_SEGMENT_SIZE,
			self::OFFSETLOG_MIN_SEGMENTS,
			self::OFFSETLOG_NUM_SEGMENTS,
			self::OFFSETLOG_MAX_SEGMENTS,
			self::OFFSETLOG_MIN_LIFETIME,
			self::OFFSETLOG_LIFETIME,
		] );
		$this->publish_sibling( 'offsetlog', $offsetlog );
		$this->offsetlog = $offsetlog;
		return $offsetlog;
	}

	/**
	 * Read the newest committed frame's VALUE, or null when there's nothing to
	 * resume from. Reads the last segment; when its tail is empty (a
	 * rotated-but-unwritten newest segment) it falls back to the prior segment,
	 * then unpacks the last parseable line. Returns the raw VALUE array — each
	 * caller reads its own fields out of it.
	 *
	 * @return array<array-key,mixed>|null
	 */
	protected function read_last_offsetlog_frame(): ?array {
		return self::last_frame_of( $this->offsetlog );
	}

	/**
	 * `read_last_offsetlog_frame()` over an offsetlog this process does not own —
	 * the off-process half of the same read, so a caller holding only a directory
	 * resolves a cursor the way a live reader does. One implementation: the
	 * instance method is this, bound to its own offsetlog.
	 *
	 * @param Partition_Node|null $offsetlog Offsetlog partition, or null.
	 * @return array<array-key,mixed>|null
	 */
	public static function last_frame_of( ?Partition_Node $offsetlog ): ?array {
		return Partition_Node::last_frame_of( $offsetlog );
	}

	/**
	 * Commit one frame: mint a TM_STRUCT Message stamped FROM this node, carry the
	 * caller's VALUE, fill the offsetlog and flush synchronously (don't wait on the
	 * Partition's PIPE_BUF threshold — a cursor frame must be durable now).
	 *
	 * @param array<array-key,mixed> $value The caller-owned frame schema.
	 */
	protected function commit_offsetlog_frame( array $value ): void {
		if ( null === $this->offsetlog ) {
			return;
		}
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::FROM ]  = $this->name;
		$message[ Message::VALUE ] = $value;
		$this->offsetlog->fill( $message );
		$this->offsetlog->flush();
	}

	/**
	 * Ceiling on an unterminated partial line, 32 MiB. A producer that stops mid-line —
	 * a torn write, a truncated stream — would otherwise grow the buffer until the worker
	 * crosses its memory watermark, so past this the partial is discarded and the cursor
	 * skips those bytes.
	 */
	public const MAX_LINE_BUFFER_SIZE = 33554432;

	/** Re-arm delay while bytes are still arriving; 0 = the next event-loop iteration. */
	public const POLL_INTERVAL_BUSY_MS = 0;

	/** Re-arm delay once the source is drained: a caught-up reader wakes ten times a second. */
	public const POLL_INTERVAL_EOF_MS = 100;

	/** True when the last refill found nothing more to read; fire() picks its cadence off it. */
	protected bool $at_eof = true;

	/** Offset half of the cursor this process booted on. See $boot_cursor_segment. */
	protected int $boot_cursor_offset = 0;

	/**
	 * The cursor this process booted on, frozen by poll_init once init_position() has
	 * seeded it. Advancing past it is "forward progress" — the poison region is behind
	 * the reader, so attempts resets to the healthy baseline. Also the fair-shot proxy
	 * for cooperative-stop strikes ([42]).
	 */
	protected int $boot_cursor_segment = 0;

	/** Bytes read past cursor_offset but not yet emitted (read-ahead + trailing partial). Tachikoma's buffer. */
	protected string $buffer = '';

	/**
	 * Durable read offset within cursor_segment, always a line boundary: the start of the
	 * next UNREAD record, since each drained record advances past itself (ADR-12).
	 */
	protected int $cursor_offset = 0;

	/** Cursor segment. cursor_offset + buffer length is the next read position. */
	protected int $cursor_segment = 0;

	/**
	 * Per-tick dispatch (Tachikoma's `$self->{fill}` function pointer). The disk readers
	 * point this at poll_init from arguments(); poll() defaults it there lazily for one
	 * that does not. The first poll loads the durable cursor and restores the snapshot —
	 * by which time the whole topology is built — then swaps to poll_active. Keeps
	 * construction free of I/O and of forward-reference order.
	 */
	protected ?\Closure $poll_cb = null;

	/**
	 * True once poll_init has seeded the durable cursor. A shutdown handoff before this
	 * (worker stopped on its first should_continue, before the first poll) must NOT write
	 * the 0:0 construction-default cursor — it would clobber the real durable position.
	 */
	protected bool $poll_initialized = false;

	/**
	 * True once next_offset() was called explicitly. It suppresses the default_offset()
	 * seek, and it is the second half of the established-cursor test in checkpoint() and
	 * cooperative_stop(): a SEEK taken while paused establishes a real position before the
	 * first poll runs, and that position has to survive the shutdown.
	 */
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
	 * @return array<int,array<string,mixed>>
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
		// Recurring, re-armed on a CHANGE: a missed oneshot is a dead node.
		$next_ms = $this->at_eof ? self::POLL_INTERVAL_EOF_MS : self::POLL_INTERVAL_BUSY_MS;
		if ( $this->interval_ms !== $next_ms ) {
			$this->set_timer( $next_ms );
		}
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

	/**
	 * Top the buffer up from the source, unless line-mode is pacing one line per tick.
	 *
	 * @param int $drained Lines the drain just consumed.
	 */
	private function refill( int $drained ): void {
		if ( ! $this->line_mode || 0 === $drained ) {
			$this->get_batch();
		}
	}

	/**
	 * Forward complete lines from $buffer to the sink, returning how many were consumed.
	 * Batch (cap = PHP_INT_MAX) and one-at-a-time (cap = 1, under line mode or crawl) are the
	 * same scan with a different cap — no second code path to keep in sync.
	 *
	 * Scans by offset and chops the buffer ONCE at the end, so batch stays a single O(n) pass
	 * (no substr-per-line) and an empty line is consumed cleanly. The bytes chopped must equal
	 * the bytes the cursor moved: get_batch reads at `cursor_offset + strlen(buffer)`, so a chop
	 * the cursor did not match re-reads the gap and mis-aligns the next line into unparseable
	 * garbage. advance_consume_cursor() pays that per record; the chop settles the whole run at
	 * once. The cursor advances past skipped (unparseable / over-long-FROM) lines too, so a
	 * single bad record can't wedge the stream.
	 *
	 * @return int Lines forwarded this call.
	 */
	private function drain_buffer(): int {
		// Crawl forces one line per drain so poll_crawl checkpoints each msg.
		$max     = ( $this->line_mode || $this->crawl ) ? 1 : \PHP_INT_MAX;
		$emitted = 0;
		$pos     = 0;
		// finally: the buffer chop survives a propagated Worker_Should_Stop.
		try {
			while ( $emitted < $max ) {
				$nl = \strpos( $this->buffer, "\n", $pos );
				if ( false === $nl ) {
					break;
				}
				$line = \substr( $this->buffer, $pos, $nl - $pos );
				$this->crumb = $this->crumb_for_line( $line );
				try {
					$this->drain_line( $line, $this->cursor_offset );
				} catch ( Worker_Should_Stop_Clean $e ) {
					// Fully processed: commit past it; a plain stop replays.
					$pos = $nl + 1;
					$this->advance_consume_cursor();
					throw $e;
				}
				$pos = $nl + 1; // past the consumed \n.
				$this->advance_consume_cursor();
				$this->commit_disposed_record();
				++$emitted;
			}
		} finally {
			// Buffer bookkeeping only: the cursor already moved, per record.
			if ( $pos > 0 ) {
				$this->buffer = \substr( $this->buffer, $pos );
			}
		}
		// Buffer dry of lines: the remainder is a partial — guard its growth.
		if ( $emitted < $max ) {
			$this->discard_oversized_partial();
		}
		return $emitted;
	}

	/**
	 * Per-line drain seam: dispatch ONE complete line. The default sacrifices the boot head
	 * when the one-shot crash skip is armed, then delegates to forward_line — so a
	 * forward_line-overriding subclass (Tail) still inherits the skip-head handling. A push
	 * source (Remote_Source) overrides this to run the crumb-vs-boot-pin 3-way compare: its
	 * stream can resume PAST a GC'd suspect, so an armed head is not unconditionally the first
	 * drained line.
	 *
	 * @param string $line       One complete line, without its trailing newline.
	 * @param int    $abs_offset The line's start offset within the current segment.
	 */
	protected function drain_line( string $line, int $abs_offset ): void {
		if ( $this->crawl_skip_head ) {
			// One-shot boot head-skip; $abs_offset is the head start.
			$this->crawl_skip_head = false;
			$this->dead_letter( $this->poison_from_line( $line, $this->cursor_segment, $abs_offset ), 'crash' );
			$this->disposed_record = true;
			return;
		}
		$this->forward_line( $line, $abs_offset );
	}

	/**
	 * Place one raw line in the source's own bytes, as `{segment, offset, length}` — the crumb
	 * that goes into its ID and the amount advance_consume_cursor moves past it. A tailing
	 * reader is addressed by what it reads: the cursor IS this record's start, because the
	 * previous record advanced exactly past itself, and the line's own bytes are its length.
	 * A pull source, addressed by the spoke that sent it, overrides this to read the crumb.
	 *
	 * @param string $line One complete line, without its trailing newline.
	 * @return array{segment:int, offset:int, length:int}
	 */
	protected function crumb_for_line( string $line ): array {
		return [
			'segment' => $this->cursor_segment,
			'offset'  => $this->cursor_offset,
			'length'  => \strlen( $line ) + 1,
		];
	}

	/**
	 * Durably resolve a record this drain DISPOSED of, if disposing of it ended a poison or
	 * crash lineage. Left climbing, that lineage would arm a head sacrifice on the next boot at
	 * a position the disposal already made clean — condemning whichever innocent record arrived
	 * there. A lineage-free disposal writes nothing: its record is in the DLQ either way, and a
	 * frame per bad record would burn the whole time-travel keyframe history on a poison burst.
	 */
	private function commit_disposed_record(): void {
		if ( ! $this->disposed_record ) {
			return;
		}
		$this->disposed_record = false;
		// Crawl pins its own accounting until it survives a clean interval.
		if ( $this->crawl || ( 1 >= $this->attempts && null === $this->first_crash_ts ) ) {
			return;
		}
		$this->reset_poison_streak();
		$this->write_checkpoint_frame( true, true );
	}

	/**
	 * Consume-cursor advance: move the durable read offset PAST the record just drained, by the
	 * length in its own crumb. Called once per record from the drain loop — the one place that
	 * owns it, so no forward_line override can forget it — after the record was forwarded and
	 * its ID stamped from the pre-advance cursor.
	 *
	 * The cursor therefore always names the next UNREAD position, and it means that for every
	 * reader. Pinned at the last-forwarded record's start instead, every resume re-delivers that
	 * record: one duplicate per resume, adjacent, carrying the same crumb.
	 */
	protected function advance_consume_cursor(): void {
		$this->cursor_offset += $this->crumb['length'];
	}

	/**
	 * Unpack one packed line and forward it to the sink: stamp FROM (breadcrumb), record the
	 * seg:offset:length breadcrumb in ID, force TO when a target is set. An unparseable line is
	 * quarantined to the `:deadletter` sibling; an over-long FROM stamp is logged and dropped.
	 * The drain loop owns the cursor and advances past either, so a single bad record can't
	 * wedge the stream.
	 *
	 * The per-line emit seam: Tail overrides this to emit raw bytes instead of unpacking a
	 * Message, reusing the trait's buffer/cursor scan in drain_buffer().
	 *
	 * @param string $line       One complete line, without its trailing newline.
	 * @param int    $abs_offset The line's start offset within the current segment.
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
			$this->disposed_record = true;
			return;
		}
		$stamp = '' !== $this->stamp_override ? $this->stamp_override : $this->name;
		if ( '' !== $stamp && ! $this->stamp_message( $message, $stamp ) ) {
			return; // FROM exceeded MAX_FROM_SIZE; stamp_message logged it.
		}
		// ID breadcrumb = seg:offset:length (length for SSE_In's reconnect).
		$this->crumb            = [ 'segment' => $this->cursor_segment, 'offset' => $abs_offset, 'length' => $line_size ];
		$message[ Message::ID ] = "{$this->crumb['segment']}:{$this->crumb['offset']}:{$this->crumb['length']}";
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

	/**
	 * True when $buffer holds at least one complete (newline-terminated) line still to drain.
	 * Both readers pick their re-arm cadence off it. PRIVATE, so it flattens into the using
	 * class and a subclass of that class cannot reach it.
	 */
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
			// Hand off PAST the head: it is already in the DLQ.
			$this->dead_letter( $this->poison_from_line( $head, $this->cursor_segment, $this->cursor_offset ), $reason );
			$this->crumb          = $this->crumb_for_line( $head );
			$this->cursor_segment = $this->crumb['segment'];
			$this->cursor_offset  = $this->crumb['offset'];
			$this->advance_consume_cursor();
			$this->write_checkpoint_frame( true, true );
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

	/**
	 * Commit the current cursor as an offsetlog checkpoint frame: skip an
	 * unestablished cursor (a 0:0 commit clobbers the durable position), skip a
	 * redundant same-cursor write, clear the crash streak on forward progress
	 * past the boot cursor (never while crawling, where attempts stay pinned),
	 * then write the frame. The redundant-write skip and the streak reset are
	 * healthy-commit only; a graceful shutdown frame writes whatever the cursor says.
	 *
	 * @param bool $graceful Final checkpoint of a clean shutdown — stamps attempts=0
	 *                       (the cursor sits at an un-attempted message), so a respawn
	 *                       resumes at a virgin first attempt rather than counting a strike.
	 */
	public function checkpoint( bool $graceful = false ): void {
		if ( null === $this->offsetlog || ( ! $this->poll_initialized && ! $this->offset_set ) ) {
			return;
		}
		if ( ! $graceful && ! $this->cursor_moved_since_checkpoint( $this->cursor_segment, $this->cursor_offset ) ) {
			return;
		}
		if ( ! $graceful && ! $this->crawl && $this->cursor_advanced_since_boot() ) {
			$this->reset_poison_streak();
		}
		$this->write_checkpoint_frame( $graceful, true );
	}

	/**
	 * Durable-commit seam: write one offsetlog frame at the current cursor, unconditionally —
	 * no advance-guard, because the boot and crawl sequences re-commit the same cursor on
	 * purpose.
	 *
	 * @param bool                   $graceful   Stamp attempts=0 instead of the live count.
	 * @param bool                   $with_state Co-commit the snapshot nodes' state as `cache`;
	 *                                           a reader with no snapshot concern ignores it.
	 * @param array<array-key,mixed> $extra      Per-call frame additions.
	 */
	abstract protected function write_checkpoint_frame( bool $graceful, bool $with_state, array $extra = [] ): void;

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

	/**
	 * Drain one line per tick instead of the whole buffer. GRANULARITY, not a rate limit:
	 * a sink doing heavy per-message work would otherwise process a whole read block (Consumer's
	 * 64 KB) inside one fire(), freezing the worker's heartbeat through the burst. The stock
	 * job-worker topology runs its Consumer on it, so this is a production setting — STEP
	 * forces it on for a debugger session and PLAY restores whatever the topology chose.
	 */
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
	 * @param int $segment Offsetlog segment id, from dump_metadata's frames[].id.
	 * @return string `"ok\n"`, or an error string when the offsetlog or the segment is absent.
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
	 * @param int $segment Offsetlog segment id to read.
	 * @return array<array-key,mixed>|null
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
	 * @param string $line One packed offsetlog line, without its trailing newline.
	 * @return array<array-key,mixed>|null
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
	 *
	 * @param string $name Node whose save_state() co-commits; a repeat is ignored.
	 */
	public function add_snapshot_node( string $name ): void {
		if ( '' === $name || \in_array( $name, $this->snapshot_nodes, true ) ) {
			return;
		}
		$this->snapshot_nodes[] = $name;
		$this->offsetlog?->void_warranty();
	}

	/**
	 * Verb-backed toggle for line_mode (one line per tick instead of the whole buffer).
	 *
	 * @param bool $flag True drains one line per tick; false drains the whole buffer.
	 */
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
	 * @return string Zero or more trailing-newline-terminated `command_node` lines.
	 */
	protected function dump_time_travel_config(): string {
		$out = '';
		foreach ( $this->snapshot_nodes as $snapshot_name ) {
			$out .= $this->config_line( 'add_snapshot_node', $snapshot_name );
		}
		if ( $this->saved_line_mode ?? $this->line_mode ) {
			$out .= $this->config_line( 'set_line_mode', '1' );
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
	 * @return array{frames: array<int,array{id:int,size:int}>, cursor: array{segment:int, offset:int}, polling: string, at_frame: int|null, on_frame: bool}
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
	 *
	 * @param int $segment Cursor segment to test.
	 * @param int $offset  Cursor offset to test.
	 * @return bool True when a frame written now would say something new.
	 */
	protected function cursor_moved_since_checkpoint( int $segment, int $offset ): bool {
		return $segment !== $this->checkpoint_segment || $offset !== $this->checkpoint_offset;
	}

	/**
	 * Commit ONE offsetlog frame at `{segment,offset}`. A graceful frame is a clean handoff
	 * (attempts=0 → a respawn resumes at the virgin baseline); a non-graceful frame
	 * carries the live attempt accounting (a climbing poison lineage / pinned crawl).
	 * Records the committed position and the wall-clock, then lets the node react
	 * (on_checkpoint_committed — Consumer publishes its CHECKPOINT state).
	 *
	 * @param int                    $segment  Cursor segment to commit.
	 * @param int                    $offset   Cursor offset to commit.
	 * @param bool                   $graceful Stamp attempts=0 instead of the live count.
	 * @param array<array-key,mixed> $extra    Per-call frame additions — the snapshot cache.
	 */
	protected function commit_checkpoint_frame( int $segment, int $offset, bool $graceful, array $extra = [] ): void {
		if ( null === $this->offsetlog ) {
			return;
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
	 * @return array<array-key,mixed>
	 */
	abstract protected function checkpoint_frame_extra(): array;

	/** React to a committed frame (Consumer publishes its CHECKPOINT state). Base no-op. */
	protected function on_checkpoint_committed(): void {}

	/**
	 * Reposition the read cursor to `{segment,offset}` (seek_frame's landing).
	 *
	 * @param string|int|array<array-key,mixed> $position Seek sentinel, alias word, or explicit {segment,offset}.
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

	/**
	 * `add_snapshot_node` verb handler — append a snapshot-target node.
	 *
	 * @param Command_Interpreter_Node $interpreter Owning interpreter; its patron is the reader.
	 * @param array<array-key,mixed>   $args        Positional args; [0] is the node name.
	 * @return string `"ok\n"`.
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
	 * @param Command_Interpreter_Node $interpreter Owning interpreter; its patron is the reader.
	 * @param array<array-key,mixed>   $args        Positional args; [0] is the offsetlog segment id.
	 * @return string seek_frame()'s reply — `"ok\n"`, or an error string.
	 */
	public static function cmd_seek_frame( Command_Interpreter_Node $interpreter, array $args ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		return $patron->seek_frame( Core::as_int( $args[0] ?? '' ) );
	}

	/**
	 * `PAUSE` verb handler — pause the patron reader.
	 *
	 * @param Command_Interpreter_Node $interpreter Owning interpreter; its patron is the reader.
	 * @return string `"ok\n"`.
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
	 * @param Command_Interpreter_Node $interpreter Owning interpreter; its patron is the reader.
	 * @return string `"ok\n"`.
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
	 * @param Command_Interpreter_Node $interpreter Owning interpreter; its patron is the reader.
	 * @return string The resulting {segment, offset, at_eof} cursor as JSON.
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
	 * @return array<int,array<string,mixed>>
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
