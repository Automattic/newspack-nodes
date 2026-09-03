<?php
/**
 * Remote_Source: pulls one spoke partition over SSE and relays it under a durable cursor.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * A self-sufficient, topology-visible SSE-pull aggregation source.
 *
 * The channel comes from `Remote_Link_Node`: the `SSE_In` and `HTTP_Out` patrons,
 * the heartbeat, the reconnect and the status snapshot. The message path comes
 * from `Durable_Reader`, the same spine `Consumer_Node` reads a disk partition
 * through — offsetlog cursor, buffered pump, dead-letter lifecycle and the
 * pause/step/seek debugger. `SSE_In` hands each raw `msg` payload to the delivery
 * seam this class installs in `ensure_patrons()`, which appends it to the pump
 * buffer, and the tick drains that buffer exactly as a Consumer drains a block it
 * read off disk.
 *
 * Two seams diverge from a disk reader. `get_batch()` arms an async cURL valve
 * instead of reading a block, and `crumb_for_line()` takes each record's position
 * from the breadcrumb it arrived with instead of measuring the local buffer chop.
 * A pull source is addressed in the SPOKE's byte space, and no local measurement
 * reaches that.
 *
 * Credentials and URL come from the Vault entry the `<vault-id>` argument names; a
 * missing entry leaves the node disconnected rather than building mis-configured
 * patrons.
 */
class Remote_Source_Node extends Remote_Link_Node {
	/** Dead_Letter_Queue and Sidecar ride in with Durable_Reader, which drives both. */
	use Durable_Reader;

	/** Memcache TTL for the status snapshot (seconds). */
	public const STATUS_TTL = 300;

	/**
	 * SSE backpressure valve water marks: re-arm at 256 KB, disarm at 512 KB.
	 *
	 * The buffer drains whole each tick, so it accumulates between ticks, in
	 * on_message(): disarm once it crosses the high mark, re-arm once the drain
	 * brings it back under the low one. The hysteresis is what keeps the valve OPEN
	 * through normal flow. A single threshold closes it on every buffered line and
	 * stop-starts the spoke, which is what makes a hub-aggregation pull lag.
	 */
	private const PUMP_ARM_BYTES    = 262144;
	private const PUMP_DISARM_BYTES = 524288;

	/** Wall-second of the last heartbeat reply; 0 while none has come back. */
	private int $last_heartbeat_response = 0;

	/** Reason the last heartbeat failed, published as `last_error`; null on success. */
	private ?string $last_heartbeat_error = null;

	/**
	 * The offsetlog restore_position() read its durable frame from and seeded the
	 * cursor with.
	 *
	 * This is what makes restore_position() idempotent: ensure_patrons() calls it to
	 * seed SSE_In's connect position BEFORE connect, and the Durable_Reader boot seam
	 * (init_position) calls it again on the first poll, where it returns the
	 * already-seeded cursor untouched. Latching the sidecar rather than a bare `true`
	 * is what stops the latch outliving the offsetlog it describes: a replayed
	 * `arguments()` naming a new offsetlog_dir builds a new Partition, and a bool
	 * would leave the cursor seeded from the dir those arguments superseded.
	 */
	private ?Partition_Node $position_restored_from = null;

	/** Mirror of the SSE_In valve state: true while armed. Only the buffer's size flips it. */
	private bool $pump_armed = true;

	/**
	 * The breadcrumb crumb_for_line() last read off the wire, null when that line
	 * carried none — the distinction the placeholder crumb erases, and what
	 * drain_line() and forward_line() steer on.
	 *
	 * @var array{segment:int, offset:int, length:int}|null
	 */
	private ?array $parsed_crumb = null;

	/**
	 * Whether the spoke partition this pulls is appended by more than one process
	 * (the firehose is, from every request). Unlike Consumer's flag of the same
	 * name it configures the reader on the OTHER end — a pull source has no
	 * segments of its own — because that is where the read happens. The spoke
	 * cannot decide for itself: which of its logs are shared lives in a topology
	 * line, and the SSE endpoint opens Consumers with no topology in the picture.
	 *
	 * Protected, like Consumer's: the inherited `dump_toggles()` reads it.
	 */
	protected bool $multi_writer = false;

	/** Tachikoma-parity: no-arg ctor. Auto-wire the `{name}:config` interpreter for the verb table. */
	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	/**
	 * Per-tick work: the Remote_Link channel housekeeping (patrons, reconnect, heartbeat,
	 * status) via parent::fire(), then the Durable_Reader drain of whatever SSE_In accumulated
	 * into the buffer since the last tick, plus the throttled cursor checkpoint. Defined directly
	 * so it overrides both the inherited Remote_Link::fire and the Durable_Reader pump fire —
	 * Remote_Source rides Remote_Link's recurring TICK_INTERVAL_MS timer, not the pump's
	 * self-re-arming cadence.
	 *
	 * The cadence it RE-ARMS with is the pump's, though. That 100ms tick paces the CHANNEL,
	 * and the drain must not inherit it as its own rate: line_mode and crawl cap
	 * `drain_buffer()` at one line, so one drain per tick would trickle a backlog at 10 lines
	 * a second however deep it is. So this borrows the pump's rule — a line still buffered
	 * runs at POLL_INTERVAL_BUSY_MS (0), an empty buffer returns to the channel tick — and
	 * re-arms only on a CHANGE, leaving a RECURRING timer armed in between. line_mode then
	 * stays GRANULARITY (one line per cycle) instead of becoming a rate limit, and the loop
	 * keeps turning between lines, where draining the backlog inline would block every other
	 * node.
	 *
	 * The method has a single exit on purpose. A patron dropped by reload() skips the drain,
	 * and returning early there would leave a 0ms cadence armed over a buffer nothing is
	 * draining — spinning the loop flat until housekeeping, latched to the wall-second,
	 * rebuilds the patron.
	 *
	 * @api Dynamic entrypoint (Timer_Node::fire_cb).
	 */
	public function fire(): void {
		parent::fire();
		// No patron, no drain, no reason to hold the busy cadence.
		$next_ms = self::TICK_INTERVAL_MS;
		if ( $this->should_connect() && null !== $this->sse_in ) {
			$this->poll();
			// One position, not two — unless an unresolved seek outranks it.
			$sse = $this->sse_in;
			if ( null !== $sse && ! $sse->has_pending_seek() ) {
				$sse->restore_position( $this->cursor_segment, $this->cursor_offset );
			}
			// poll() moves the cursor; checkpoint() makes it durable.
			if ( null !== $this->offsetlog && $this->checkpoint_due() ) {
				$this->checkpoint();
				$this->last_checkpoint = Core::$now;
			}
			$next_ms = $this->buffer_has_line() ? self::POLL_INTERVAL_BUSY_MS : self::TICK_INTERVAL_MS;
		}
		if ( $this->interval_ms !== $next_ms ) {
			$this->set_timer( $next_ms );
		}
	}

	/**
	 * Boot seam: seed the durable read position on the first poll. Delegates to the idempotent
	 * restore_position(). ensure_patrons() has usually already run it to seed SSE_In before
	 * connect, in which case this second call leaves the cursor, the crawl lineage and the boot
	 * head-skip exactly as that one set them. Then make sure the deadletter sibling exists, so
	 * the trait's cooperative_stop() has somewhere to quarantine to.
	 */
	protected function init_position(): void {
		$this->restore_position();
		$this->ensure_deadletter();
	}

	/**
	 * Crumb seam override: a pull source is addressed by the spoke that sent it, so the record's
	 * position and size are the breadcrumb it arrived with, never the local line's bytes. A line
	 * carrying no crumb cannot be placed in the spoke's byte space at all — it keeps the cursor
	 * where it stands and moves it by nothing.
	 *
	 * @return array{segment:int, offset:int, length:int}
	 */
	protected function crumb_for_line( string $line ): array {
		$this->parsed_crumb = $this->crumb_from_line( $line );
		return $this->parsed_crumb ?? [
			'segment' => $this->cursor_segment,
			'offset'  => $this->cursor_offset,
			'length'  => 0,
		];
	}

	/**
	 * Drain seam override: dispatch ONE buffered line the push way. Pin the cursor to the
	 * record's own START, taken from its breadcrumb; then, if the boot head-skip is armed,
	 * run the 3-way crumb-vs-boot-pin compare. A push stream can resume PAST a GC'd suspect,
	 * so an armed head is not unconditionally the first drained line — which is why the
	 * trait's unconditional sacrifice cannot serve here. Everything else forwards through
	 * forward_line().
	 */
	protected function drain_line( string $line, int $abs_offset ): void {
		$crumb = $this->parsed_crumb;
		if ( null !== $crumb ) {
			$this->cursor_segment = $crumb['segment'];
			$this->cursor_offset  = $crumb['offset'];
		}
		if ( $this->crawl_skip_head && null !== $crumb && $this->sacrifice_boot_head( $line, $crumb ) ) {
			return; // Sacrificed — not forwarded.
		}
		$this->forward_line( $line, $abs_offset, $crumb );
	}

	/**
	 * Emit seam override: forward one raw line, PRESERVING both the FROM trail and the
	 * breadcrumb ID the spoke stamped. The trait default re-stamps FROM with this node's name
	 * and rewrites ID as seg:off:len from the LOCAL cursor; a relay has to keep the source
	 * partition's own crumb, which is what the Aggregator reads a record's origin from.
	 * drain_line() has already pinned the cursor from that crumb.
	 *
	 * Four dispositions. A null sink FAILS LOUD, because a relay with nowhere to relay is a
	 * topology error. An unparseable line carries no crumb, so it is quarantined where the
	 * cursor stands — the next unread position, the one place it can be put — and moves the
	 * cursor by nothing. A downstream throw dead-letters the message ON SIGHT and marks the
	 * record disposed, so the drain loop advances past it with no head-block and no fair-shot
	 * climb; that climb is reserved for the hard-crash lineage and its crawl. A
	 * Worker_Should_Stop is control flow rather than poison: a clean one, or a plain one under
	 * assume_clean_shutdown, re-raises as clean on a crumb-carrying record outside crawl so the
	 * drain commits PAST it, while a record with no crumb cannot be placed and crawl's pin
	 * exists to isolate a crash suspect, so both replay — and a plain stop records the
	 * mid-dispatch strike on its way out.
	 *
	 * @param string $line       One complete line off the pump buffer.
	 * @param int    $abs_offset Local drain offset, carried for the trait's signature; a push
	 *                           source places records from the crumb instead.
	 * @param array{segment:int, offset:int, length:int}|null $crumb The line's parsed breadcrumb.
	 */
	protected function forward_line( string $line, int $abs_offset, ?array $crumb = null ): void {
		$sink = $this->sink;
		if ( null === $sink ) {
			throw new \RuntimeException( 'Remote_Source relay requires a wired sink' );
		}
		try {
			$message = Message::unpacked( $line );
		} catch ( \InvalidArgumentException $e ) {
			// No crumb: place it at the cursor (SSE_In's copy is a tick old).
			$this->dead_letter( $this->poison_from_line( $line, $this->cursor_segment, $this->cursor_offset ), 'unparseable', $e );
			$this->disposed_record = true;
			return;
		}
		if ( \is_string( $this->target ) && '' !== $this->target ) {
			$message[ Message::TO ] = $this->target;
		}
		if ( $this->crawl ) {
			// Pre-dispatch pin: commit start before fill (crash resumes here).
			$this->write_checkpoint_frame( false, true );
		}
		try {
			$sink->fill( $message );
			// Clear streak on forward itself (cursor at boot); not in crawl.
			if ( ! $this->crawl && $this->attempts > 1 ) {
				$this->reset_poison_streak();
				$this->write_checkpoint_frame( true, true );
			}
		} catch ( Worker_Should_Stop $e ) {
			$clean = $e instanceof Worker_Should_Stop_Clean;
			// Commit past a placeable message not in crawl; else replay.
			if ( ( $clean || $this->assume_clean_shutdown ) && null !== $crumb && ! $this->crawl ) {
				throw $clean ? $e : new Worker_Should_Stop_Clean();
			}
			// Cooperative deadline: record the mid-dispatch stop, then escape.
			if ( ! $clean ) {
				$this->stopped_in_fill = true;
			}
			throw $e;
		} catch ( \Throwable $e ) {
			$this->dead_letter( $message, 'throw', $e );
			$this->disposed_record = true;
		}
	}

	/**
	 * Crawl-entry head sacrifice: the 3-way compare deciding the fate of the first relayed
	 * message while the boot head-skip is armed. An EXACT crumb-start match on the boot pin is
	 * the suspect that was in flight when the death struck — dead-lettered under reason
	 * 'crash', or dropped when no quarantine is configured, and the caller skips the forward.
	 * A start PAST the pin means the suspect was GC'd or the stream resumed beyond it, so
	 * disarm without sacrificing and forward normally. Anything earlier leaves the flag armed
	 * for the real suspect. One-shot either way, once resolved.
	 *
	 * @param string $line The raw line under judgment.
	 * @param array{segment:int, offset:int} $crumb The line's parsed breadcrumb (its start).
	 * @return bool True when the head is condemned, so the caller skips the forward.
	 */
	private function sacrifice_boot_head( string $line, array $crumb ): bool {
		// Lexicographic (segment,offset) vs boot pin: 0=suspect, >0=past it.
		$cmp = [ $crumb['segment'], $crumb['offset'] ] <=> [ $this->boot_cursor_segment, $this->boot_cursor_offset ];
		if ( 0 === $cmp ) {
			$this->crawl_skip_head = false;
			$this->dead_letter( $this->poison_from_line( $line, $crumb['segment'], $crumb['offset'] ), 'crash' );
			$this->disposed_record = true;
			return true;
		}
		if ( 0 < $cmp ) {
			$this->crawl_skip_head = false;
			$this->print_less_often( "{$this->name} crawl head-sacrifice: suspect at ", "{$this->boot_cursor_segment}:{$this->boot_cursor_offset}", ' is gone (stream resumed past it) — not sacrificing' );
		}
		return false;
	}

	/**
	 * Parse a raw line's breadcrumb into `{segment, offset, length}`, or null when the line won't
	 * unpack or its ID isn't a well-formed crumb. offset is the record's on-disk start; length is
	 * the crumb's own `segment:offset:length` third field — the spoke's authoritative byte size,
	 * and what the drain loop advances past the record by. A two-field crumb carries no length,
	 * so it places the record and moves the cursor by nothing rather than by a local size
	 * measured in the wrong byte space.
	 *
	 * @return array{segment:int, offset:int, length:int}|null
	 */
	private function crumb_from_line( string $line ): ?array {
		try {
			$message = Message::unpacked( $line );
		} catch ( \InvalidArgumentException $e ) {
			return null;
		}
		$id    = Core::as_string( $message[ Message::ID ] ?? '' );
		$parts = \explode( ':', $id );
		$count = \count( $parts );
		if ( ( 2 !== $count && 3 !== $count ) || ! \ctype_digit( $parts[0] ) || ! \ctype_digit( $parts[1] ) ) {
			return null;
		}
		if ( 3 === $count && ! \ctype_digit( $parts[2] ) ) {
			return null;
		}
		// No length on the wire: a local one is the wrong byte space.
		$length = ( 3 === $count ) ? (int) $parts[2] : 0;
		return [ 'segment' => (int) $parts[0], 'offset' => (int) $parts[1], 'length' => $length ];
	}

	/**
	 * Read the latest committed frame, seed the node cursor and the boot pin, resume the shared
	 * poison and crash accounting (attempts+1, and a hard-crash lineage enters crawl), then arm
	 * the boot head-skip. Idempotent: ensure_patrons() calls it to seed SSE_In's connect
	 * position before connect, and the Durable_Reader boot seam calls it again on the first
	 * poll. Returns empty on a fresh offsetlog.
	 *
	 * @return array{segment?:int,offset?:int}
	 */
	protected function restore_position(): array {
		$offsetlog = $this->ensure_offsetlog();
		if ( null === $offsetlog ) {
			return [];
		}
		if ( $offsetlog === $this->position_restored_from ) {
			return [ 'segment' => $this->cursor_segment, 'offset' => $this->cursor_offset ];
		}
		$this->position_restored_from = $offsetlog;
		$value                        = $this->read_last_offsetlog_frame();
		if ( null === $value ) {
			return [];
		}
		$segment = $value['segment'] ?? 0;
		$offset  = $value['offset'] ?? 0;
		$segment = Core::as_int( $segment );
		$offset  = Core::as_int( $offset );
		$this->arm_skip_head_from_frame( $value );
		$this->cursor_segment      = $segment;
		$this->cursor_offset       = $offset;
		$this->boot_cursor_segment = $segment;
		$this->boot_cursor_offset  = $offset;
		return [
			'segment' => $segment,
			'offset'  => $offset,
		];
	}

	/**
	 * Final cursor handoff at worker shutdown. Remote_Source is not a Consumer_Node, so the
	 * worker's shutdown sweep reaches it through its own branch rather than the Consumer one.
	 * A healthy reader commits gracefully (attempts=0), so progress survives the recycle; a
	 * hard-crash lineage still in flight keeps its climbing, pinned frame instead. The
	 * cooperative-stop fair-shot lives elsewhere, in Durable_Reader's cooperative_stop(),
	 * gated on buffer_head_line() and stopped_in_fill.
	 *
	 * @api Invoked by Worker_Base::handoff_remote_source() on an operational stop.
	 */
	public function checkpoint_shutdown(): void {
		// Paused SEEK sets offset_set w/o poll_initialized; survives shutdown.
		if ( null === $this->ensure_offsetlog() || ( ! $this->poll_initialized && ! $this->offset_set ) ) {
			return;
		}
		$graceful = $this->attempts <= 1 && ! $this->crawl;
		$this->write_checkpoint_frame( $graceful, true );
	}

	/**
	 * Durable-commit seam: write one frame at the current cursor UNCONDITIONALLY (no advance-guard;
	 * the boot/crawl sequences re-commit the same cursor on purpose). Ensures the lazy per-node
	 * offsetlog exists first. Remote_Source has no snapshot cache to co-commit, so $with_state is
	 * unused; the _ts wall-clock rides via checkpoint_frame_extra().
	 *
	 * @param array<array-key,mixed> $extra Per-call frame additions.
	 */
	protected function write_checkpoint_frame( bool $graceful, bool $with_state, array $extra = [] ): void {
		if ( null === $this->ensure_offsetlog() ) {
			return;
		}
		$this->commit_checkpoint_frame( $this->cursor_segment, $this->cursor_offset, $graceful, $extra );
	}

	/**
	 * SEEK_FRAME landing: reseed SSE_In from the frame's {segment,offset} and drop the current
	 * stream. Seeking only ever happens while paused, so the reconnect is deferred to PLAY's tick.
	 *
	 * A bare SEEK sentinel is FORWARDED rather than resolved: this node holds no segments, so
	 * `end` and `recent` mean nothing locally — the spoke owns the log and answers them. Either
	 * way the in-flight buffer goes, since it belongs to the position being left behind.
	 *
	 * @param string|int|array<array-key,mixed> $position Explicit {segment,offset} from seek_frame(), or a seek sentinel / alias word.
	 */
	public function next_offset( $position ): void {
		if ( ! \is_array( $position ) ) {
			$sse = $this->ensure_patrons();
			if ( null === $sse ) {
				return;
			}
			$sse->disconnect();
			$sse->seek( Consumer_Node::seek_sentinel( $position ) );
			$this->offset_set = true;
			$this->buffer     = '';
			return;
		}
		$segment = \is_numeric( $position['segment'] ?? null ) ? (int) $position['segment'] : 0;
		$offset  = \is_numeric( $position['offset'] ?? null ) ? (int) $position['offset'] : 0;
		$sse     = $this->ensure_patrons();
		if ( null === $sse ) {
			return;
		}
		$sse->disconnect();
		$sse->restore_position( $segment, $offset );
		$this->cursor_segment = $segment;
		$this->cursor_offset  = $offset;
		$this->offset_set     = true;
		$this->buffer         = '';
	}

	/**
	 * Build the base patrons, seed the seal-grace flag onto SSE_In (an aggregator configures its
	 * spokes before anything connects, so a patron built after the verb still has to carry it),
	 * then override SSE_In's delivery seam: each raw `msg` payload is appended, with its
	 * newline, to the Durable_Reader buffer for the tick to drain. The push source buffers where
	 * the base channel path forwards straight downstream. An unparseable line reaches the buffer
	 * unparsed; forward_line() owns the quarantine. pump_maybe_disarm() closes the valve here
	 * once the buffer crosses the high-water mark.
	 *
	 * The arrival also takes the busy cadence itself. A push source learns of data HERE, on the
	 * cURL drain, between fires, so leaving the schedule to fire() would put up to a full
	 * TICK_INTERVAL_MS on the front of every burst — that re-arm runs only after a fire has
	 * already seen the buffer. fire() drops back to the channel tick once the buffer is dry.
	 *
	 * @return SSE_In_Node|null The SSE_In patron once configured, else null.
	 */
	protected function ensure_patrons(): ?SSE_In_Node {
		$sse = parent::ensure_patrons();
		if ( null !== $sse ) {
			$sse->set_multi_writer( $this->multi_writer );
			$sse->on_message = function ( string $raw ): void {
				$this->buffer .= $raw . "\n";
				$this->pump_maybe_disarm();
				// Drain on the next cycle, not up to a channel tick from now.
				if ( self::POLL_INTERVAL_BUSY_MS !== $this->interval_ms ) {
					$this->set_timer( self::POLL_INTERVAL_BUSY_MS );
				}
			};
		}
		return $sse;
	}

	/** Stamp the heartbeat send-time so record_heartbeat_reply() can compute the round-trip. */
	protected function record_heartbeat_sent( int $now ): void {
		$this->write_status( [ 'last_heartbeat_sent' => $now ] );
	}

	/**
	 * Record a heartbeat reply's round-trip into the status snapshot and clear the stored
	 * failure. `last_error` is republished from SSE_In's connection rather than blanked,
	 * because the stream can be down while the command channel still answers, and the
	 * dashboard badge has to say so.
	 */
	protected function record_heartbeat_reply(): void {
		if ( 0 === $this->last_heartbeat_sent ) {
			return;
		}
		$now                           = (int) Core::$now;
		$this->last_heartbeat_response = $now;
		$this->last_heartbeat_error    = null;
		$connection_error = null !== $this->sse_in
			? $this->sse_in->connection()['last_error']
			: null;
		$this->write_status( [
			'last_heartbeat_response' => $now,
			'last_heartbeat_rtt'      => $now - $this->last_heartbeat_sent,
			'last_error'              => $connection_error,
		] );
	}

	/** Clear a prior success immediately and retain the spoke's safe failure reason. */
	protected function record_heartbeat_failure( string $reason ): void {
		$this->last_heartbeat_response = 0;
		$this->last_heartbeat_error    = 'Client heartbeat failed: ' . $reason;
		$this->write_status( [
			'last_heartbeat_response' => null,
			'last_heartbeat_rtt'      => null,
			'last_error'              => $this->last_heartbeat_error,
		] );
	}

	/**
	 * Publish the connection-state snapshot from SSE_In::connection(). Ages out the heartbeat
	 * round-trip so the dashboard's Status badge can't latch 'success' on a stale timestamp: the
	 * response is "live" only while connected AND seen within the node's HEARTBEAT_INTERVAL*4
	 * window, and is nulled otherwise. While it IS live the two keys are left out of the
	 * write, so what record_heartbeat_reply() merged stands.
	 */
	protected function publish_status(): void {
		$conn = null !== $this->sse_in
			? $this->sse_in->connection()
			: [ 'connected' => false, 'connecting' => false, 'last_http_code' => null, 'last_error' => null, 'current_backoff' => SSE_In_Node::INITIAL_BACKOFF, 'last_sse_heartbeat' => null, 'last_attempt' => null, 'scheduled_reconnect_at' => null ];
		$data = [
			'last_connection_attempt' => $conn['last_attempt'],
			'connected'               => $conn['connected'],
			// A socket mid-open: neither up nor a failure to rail red.
			'connecting'              => $conn['connecting'],
			'last_http_code'          => $conn['last_http_code'],
			'last_error'              => $conn['last_error'] ?? $this->last_heartbeat_error,
			'current_backoff'         => $conn['current_backoff'],
			'last_sse_heartbeat'      => $conn['last_sse_heartbeat'],
			// The dashboard's idle reading: closed on purpose, back at T.
			'scheduled_reconnect_at'  => $conn['scheduled_reconnect_at'],
		];
		// Live only while connected AND the response is within slot-TTL window.
		$hb_live = $conn['connected']
			&& $this->last_heartbeat_response > 0
			&& ( (int) Core::$now - $this->last_heartbeat_response ) <= self::HEARTBEAT_INTERVAL * 4;
		if ( ! $hb_live ) {
			$data['last_heartbeat_response'] = null;
			$data['last_heartbeat_rtt']      = null;
		}
		$this->write_status( $data );
	}

	/**
	 * Merge $data into the status snapshot under the per-node key.
	 *
	 * @param array<string,mixed> $data Fields to merge over whatever the snapshot holds.
	 */
	private function write_status( array $data ): void {
		$cache = Cache_Backend::shared_first();
		if ( null === $cache ) {
			return;
		}
		$key      = $this->status_key();
		$existing = $cache->get( $key );
		if ( ! \is_array( $existing ) ) {
			$existing = [];
		}
		$cache->set( $key, \array_merge( $existing, $data ), self::STATUS_TTL );
	}

	/** This node's own status-snapshot key. */
	private function status_key(): string {
		return self::status_key_for( $this->name, $this->remote_partition );
	}

	/**
	 * The cache key one Remote_Source publishes its status snapshot under.
	 *
	 * Keyed by NODE NAME first, so two spokes on the same partition do not collide, and
	 * site-scoped, so two HUBS naming a spoke alike do not either. Public because the reader
	 * (Aggregator_CI) resolves the writer's exact key through this method rather than
	 * spelling the shape a second time.
	 *
	 * @param string $name      The publishing node's name.
	 * @param string $partition The spoke partition it pulls.
	 */
	public static function status_key_for( string $name, string $partition ): string {
		return Cache_Backend::site_key( "remote:{$name}:{$partition}" );
	}

	/**
	 * Refill seam: the async backpressure VALVE, dual to Consumer's synchronous disk read. The
	 * valve is edge-triggered on the buffer's BYTE size — pump_maybe_disarm() closes it in
	 * on_message once accumulation crosses the high-water mark; this re-opens it only once the
	 * tick's drain has brought the buffer back below low-water. So it stays OPEN through normal
	 * flow: no arm per poll, no disarm on an empty buffer, and the cURL multi parks an idle
	 * stream without spinning. With no patron there is nothing to arm, so it records EOF and
	 * returns.
	 */
	protected function get_batch(): void {
		if ( null === $this->sse_in ) {
			$this->at_eof = true;
			return;
		}
		$this->pump_maybe_arm();
		$this->at_eof = '' === $this->buffer;
	}

	/** Re-open the valve once the buffer has drained back below the low-water mark (from get_batch). */
	private function pump_maybe_arm(): void {
		if ( ! $this->pump_armed && \strlen( $this->buffer ) <= self::PUMP_ARM_BYTES ) {
			$this->sse_in?->arm();
			$this->pump_armed = true;
		}
	}

	/**
	 * Ask the spoke to read this partition with the multi-writer seal-grace
	 * (`Consumer_Node::SEAL_GRACE_SECONDS`): a peer there can keep appending to
	 * segment N for `Partition_Node::DRIFT_RESCAN_INTERVAL_SECONDS` after N+1
	 * appears, and a reader that advances on sight orphans that straggler —
	 * for the firehose, typically a request's terminal `process (complete)`,
	 * which then never finalizes here.
	 *
	 * The grace rides a connect-time query parameter, so a CHANGE drops the live
	 * stream and the tick reconnects from the committed cursor. The undrained
	 * buffer usually goes with it, as in next_offset(): SSE_In's resume position
	 * only advances on a successful forward, so whatever is still buffered sits
	 * ahead of it and the spoke re-sends it. The exception is a resume position
	 * still at {0,0}. Nothing has been forwarded there, so the reconnect can
	 * resolve to the spoke's tail and replay nothing, which leaves the buffer the
	 * only copy of those records: keeping it costs a duplicate, clearing it loses
	 * them outright.
	 *
	 * @param bool $flag Whether the spoke should apply the seal-grace.
	 */
	public function set_multi_writer( bool $flag ): void {
		$changed            = $flag !== $this->multi_writer;
		$this->multi_writer = $flag;
		if ( null === $this->sse_in || ! $changed ) {
			return;
		}
		$this->sse_in->set_multi_writer( $flag );
		$position = $this->sse_in->position();
		$this->sse_in->disconnect();
		// Only when the reconnect will replay it; see the docblock on {0,0}.
		if ( $position['segment'] > 0 || $position['offset'] > 0 ) {
			$this->buffer = '';
		}
	}

	/** Close the valve once the buffer has accumulated past the high-water mark (from on_message). */
	private function pump_maybe_disarm(): void {
		if ( $this->pump_armed && \strlen( $this->buffer ) >= self::PUMP_DISARM_BYTES ) {
			$this->sse_in?->disarm();
			$this->pump_armed = false;
		}
	}

	/**
	 * Drop the slots the base cascade just tore down, so a later `ensure_offsetlog()`, which
	 * `init_position()` reaches, rebuilds them instead of handing back a Partition whose name,
	 * sink and patron that cascade already cleared.
	 */
	public function remove_node(): void {
		parent::remove_node();
		$this->offsetlog  = null;
		$this->deadletter = null;
	}

	/**
	 * Put the remote partition into each SIDECAR's suffix: one node pulls one remote
	 * partition, so its offsetlog and its quarantine are named for that partition. Only those
	 * two are re-keyed. The transports inherited from the link keep their plain suffixes,
	 * because `<name>:sse-in` and `<name>:http-out` are the spelling the link publishes and
	 * the JS RemoteLinkNode mirrors, and a blanket rewrite would move them out from under it.
	 */
	protected function sibling_suffix( string $kind ): string {
		return \in_array( $kind, [ 'offsetlog', 'deadletter' ], true )
			? "{$this->remote_partition}:{$kind}"
			: parent::sibling_suffix( $kind );
	}

	/**
	 * Remote_Source's frame extra beyond the shared base: the commit wall-clock, carried on
	 * every frame so an idle-vs-fresh cursor is distinguishable in the durable record.
	 *
	 * @return array<array-key,mixed>
	 */
	protected function checkpoint_frame_extra(): array {
		return [ '_ts' => (int) Core::$now ];
	}

	/**
	 * Fold the time-travel READ surface (frames + cursor) into the canvas-poll payload. The
	 * reported cursor is the node-owned after-forward cursor (the single source of truth), so
	 * no SSE_In sync is needed.
	 *
	 * @api Dynamic entrypoint.
	 * @return array{frames: array<int,array{id:int,size:int}>, cursor: array{segment:int, offset:int}, polling: string, at_frame: int|null, on_frame: bool, deadletter_segments: int}
	 */
	public function dump_metadata(): array {
		return $this->time_travel_metadata() + $this->deadletter_metadata();
	}

	/**
	 * STEP is a no-op for a push-driven source: SSE_In is fed by the event loop, not pulled one
	 * message at a time, so there is nothing to single-step. Report the current position.
	 *
	 * @return array{segment:int, offset:int, at_eof:bool}
	 */
	protected function advance_one_message(): array {
		return [ 'segment' => $this->cursor_segment, 'offset' => $this->cursor_offset, 'at_eof' => true ];
	}

	/** PLAY re-arm: resume the recurring tick, which reconnects from the current position. */
	protected function time_travel_resume(): void {
		$this->set_timer( self::TICK_INTERVAL_MS );
	}

	/** PAUSE also stops the pull: drop the live SSE stream so no data flows while paused. */
	protected function time_travel_on_pause(): void {
		$this->sse_in?->disconnect();
	}

	/**
	 * Append the shared time-travel config lines and the schema-declared toggles
	 * (`multi_writer`, `assume_clean_shutdown`) after the base `make_node` line, so a console
	 * dump_config and replay round-trips this source's snapshot node and its settings rather
	 * than rebuilding a bare one.
	 */
	public function dump_config(): string {
		return parent::dump_config() . $this->dump_time_travel_config() . $this->dump_toggles();
	}

	/**
	 * Palette entry and configuration form: the link's two arguments plus the durable
	 * reader's two directories, and the DLQ, time-travel, pump and seal-grace verbs.
	 *
	 * @api Dynamic entrypoint.
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		$parent = parent::node_schema();
		/** @var list<array<string,mixed>> $parent_args */
		$parent_args = $parent['arguments'];
		return \array_merge( $parent, [
			// The parent hides itself; this subclass belongs in the palette.
			'category'    => 'I/O',
			'description' => 'Self-sufficient SSE-pull aggregation source for one spoke partition (Vault-resolved).',
			// Read like a Consumer: it IS one, over the wire.
			'arguments'   => \array_merge(
				$parent_args,
				[
					[ 'name' => 'offsetlog_dir',  'type' => 'string', 'default' => '', 'description' => 'Directory for the durable read-cursor offsetlog (resume-after-restart); empty disables checkpointing. Carry `<topology>` so two fleets pulling one spoke partition keep separate cursors.' ],
					[ 'name' => 'deadletter_dir', 'type' => 'string', 'default' => '', 'description' => 'Directory where poison/dead-letter records are quarantined; empty disables the dead-letter queue.' ],
				]
			),
			// DLQ triage + time-travel + pump verbs, shared with Consumer.
			'commands'    => \array_merge(
				self::deadletter_verbs(),
				self::time_travel_verbs(),
				self::pump_verbs(),
				[
					[
						'name'        => 'set_multi_writer',
						'description' => 'Ask the spoke to read this partition with the multi-writer seal-grace (shared logs, e.g. the firehose).',
						'args'        => [
							[ 'name' => 'enabled', 'type' => 'bool', 'required' => false, 'description' => 'A truthy value (1/true/yes/on) enables; anything else disables.' ],
						],
						'toggle'      => 'multi_writer',
					],
				]
			),
		] );
	}
}
