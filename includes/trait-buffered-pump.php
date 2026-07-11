<?php
/**
 * Buffered_Pump: the timer-driven message-path spine of a durable reader.
 *
 * Owns the buffer + read cursor, the `poll_cb` INIT→ACTIVE/CRAWL function-pointer
 * state machine (Tachikoma's `$self->{fill}`), the `drain_buffer` scan, the
 * `forward_line` emit, crawl-as-a-swapped-state, and the `fire()` tick. Once a block
 * of bytes is in the buffer, the drain → forward → crawl → checkpoint path is one
 * shared spine.
 *
 * The declared seam surface (the trait's whole contract with its using class):
 *   - `get_batch()` — the REFILL seam (abstract). Consumer: a synchronous disk-block
 *     read; a push source (Remote_Source): an async "arm the curl valve," bytes
 *     arriving later via the drain loop.
 *   - `init_position()` — the BOOT seam (abstract). The source-specific "where do I
 *     start": Consumer seeds from the offsetlog + a default seek; a push source
 *     (Remote_Source) restores its position + arms its valve (no seek).
 *   - `forward_line()` — the EMIT seam (concrete default; Tail already overrides it).
 *   - `checkpoint()` / `write_checkpoint_frame()` — the DURABLE-COMMIT seams (abstract).
 *     Consumer commits an offsetlog frame; a push source overrides to commit its cursor.
 *
 * Poison/offsetlog machinery is read from the sibling traits (Offsetlog_Cursor,
 * Dead_Letter_Queue, Time_Travel) — same `$this`, composed at runtime.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

trait Buffered_Pump {

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
				$this->print_less_often( "DROP [quarantined] {$this->name} at {$this->cursor_segment}:{$this->cursor_offset} — already dead-lettered" );
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
			\sprintf( 'WARNING: line buffer exceeded %d bytes at seg %d - discarding', self::MAX_LINE_BUFFER_SIZE, $this->cursor_segment )
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
}
