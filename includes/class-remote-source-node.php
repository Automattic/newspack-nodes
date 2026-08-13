<?php
/**
 * Remote_Source: a self-sufficient, topology-visible SSE-pull aggregation node.
 *
 * Extends Remote_Link (the channel layer: SSE_In + HTTP_Out patrons, heartbeat,
 * reconnect, status) and `use`s Durable_Reader (the durable message-path spine it
 * shares with Consumer). SSE_In hands each raw `msg` payload to this node's delivery
 * seam, which appends it to the pump buffer; the tick drains it exactly like Consumer.
 * The only push-specific divergences are the refill seam (an async curl valve instead
 * of a disk read) and the cursor seam (breadcrumb-derived instead of chop-derived).
 *
 * Credentials + URL come from the Vault entry resolved by `<vault-id>`; a missing
 * entry leaves the node disconnected (no mis-configured patrons created).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Remote_Source_Node extends Remote_Link_Node {
	/** Dead_Letter_Queue rides in with Durable_Reader, which drives it. */
	use Durable_Reader;

	/** Memcache TTL for the status snapshot (seconds). */
	public const STATUS_TTL = 300;
	/**
	 * SSE backpressure valve water marks: arm at 256 KB, disarm at 512 KB.
	 *
	 * The buffer drains whole each tick,
	 * so accumulation happens between ticks in on_message: disarm when it crosses
	 * HIGH, re-arm when the drain brings it back under LOW. The hysteresis keeps the
	 * valve OPEN through normal flow — the throughput fix for hub-aggregation lag
	 * (the old gate disarmed on every buffered line, stop-starting the spoke).
	 */
	private const PUMP_ARM_BYTES    = 262144;
	private const PUMP_DISARM_BYTES = 524288;

	private int $last_heartbeat_response = 0;
	private ?string $last_heartbeat_error = null;

	/**
	 * True once restore_position() has read the durable frame + seeded the cursor. Makes
	 * restore_position idempotent: ensure_patrons calls it to seed SSE_In's connect position
	 * BEFORE connect, and the Durable_Reader boot seam (init_position) calls it again on the
	 * first poll — the second call is a no-op that returns the already-seeded cursor.
	 */
	private bool $position_restored = false;

	/** Valve state mirror (buffer-driven only): true while SSE_In is armed. */
	private bool $pump_armed = true;

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

	/** Tachikoma-parity: no-arg ctor. Auto-wire the {name}:config interpreter for the time-travel verbs. */
	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	/**
	 * Per-tick work: the Remote_Link channel housekeeping (patrons, reconnect, heartbeat,
	 * status) via parent::fire(), then the Durable_Reader drain of whatever SSE_In accumulated
	 * into the buffer since last tick, plus the throttled cursor checkpoint. Defined directly
	 * so it overrides both the inherited Remote_Link::fire and the Durable_Reader pump fire —
	 * Remote_Source rides Remote_Link's recurring TICK_INTERVAL_MS timer, not the pump's
	 * self-re-arming cadence.
	 *
	 * …except for the cadence it re-arms with. That 100ms tick paces the CHANNEL, and the drain
	 * must not inherit it as its own rate: line_mode and crawl cap `drain_buffer()` at one line,
	 * so one drain per tick would trickle a backlog at 10 lines/sec however deep it is. So this
	 * borrows the pump's rule — a line still buffered runs at POLL_INTERVAL_BUSY_MS (0), an empty
	 * one returns to the channel tick — and, like the pump, only on a CHANGE, leaving a RECURRING
	 * timer armed in between. line_mode stays GRANULARITY (one line per cycle) rather than becoming
	 * a rate limit, and the loop keeps turning between lines, where draining the backlog inline
	 * would block every other node. There is one exit on purpose: a patron dropped by reload()
	 * skips the drain, and jumping straight out would leave a 0ms cadence armed over a buffer
	 * nothing is draining — spinning the loop flat until housekeeping, latched to the wall-second,
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
	 * restore_position() (ensure_patrons already ran it to seed SSE_In before connect, so this
	 * is usually a no-op that leaves the cursor / crawl-lineage / boot head-skip already armed),
	 * and ensures the deadletter sibling exists so the trait's cooperative_stop can quarantine.
	 */
	protected function init_position(): void {
		$this->restore_position();
		$this->ensure_deadletter();
	}

	/**
	 * Drain seam override: dispatch ONE buffered line the push way. Read the record's own START
	 * from its breadcrumb and pin the cursor there (advance-on-next — a push cursor is
	 * breadcrumb-derived, NOT chop-derived); then, if the boot head-skip is armed, run the
	 * 3-way crumb-vs-boot-pin compare (this is the surviving sacrifice_head — a push stream can
	 * resume PAST a GC'd suspect, so an armed head is not unconditionally the first drained
	 * line). Everything else forwards through forward_line.
	 */
	protected function drain_line( string $line, int $abs_offset ): void {
		$crumb = $this->crumb_from_line( $line );
		if ( null !== $crumb ) {
			$this->cursor_segment = $crumb['segment'];
			$this->cursor_offset  = $crumb['offset'];
		}
		if ( $this->crawl_skip_head && null !== $crumb && $this->sacrifice_boot_head( $line, $crumb ) ) {
			return; // Sacrificed / dropped — not forwarded.
		}
		$this->forward_line( $line, $abs_offset, $crumb );
	}

	/**
	 * Emit seam override: forward one raw line, PRESERVING its remote breadcrumb ID (the trait
	 * default re-stamps seg:off:len from the cursor — a push source must keep the source-partition
	 * crumb the Aggregator depends on). The cursor was already pinned from the crumb in drain_line.
	 * A downstream throw dead-letters ON SIGHT + writes an advance-on-next quarantine marker (no
	 * head-block, no fair-shot climb — that is reserved for the hard-crash lineage / crawl); a
	 * Worker_Should_Stop is control flow (record the mid-dispatch stop, escape); a null downstream
	 * FAILS LOUD; an unparseable line is quarantined (a re-delivered boot 'drop' head is dropped).
	 * A crumb-less throwing message (null $crumb) has no position of its own — the cursor still
	 * pins the prior healthy line — so it is dead-lettered but writes NO quarantine marker there.
	 *
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
			// Torn frame: no crumb; SSE_In next-read pos, quarantine on sight.
			$pos = $this->sse_in?->position() ?? [ 'segment' => $this->cursor_segment, 'offset' => $this->cursor_offset ];
			if ( $this->crawl_skip_head && 'drop' === $this->skip_head_disposition
				&& $pos['segment'] === $this->boot_cursor_segment && $pos['offset'] === $this->boot_cursor_offset ) {
				$this->crawl_skip_head = false;
				$this->print_less_often( "{$this->name} boot head-drop (unparseable) at ", "{$pos['segment']}:{$pos['offset']}", ' — already quarantined, dropping' );
				return;
			}
			$this->dead_letter( $this->poison_from_line( $line, $pos['segment'], $pos['offset'] ), 'unparseable', $e );
			$this->mark_quarantined_at( $pos['segment'], $pos['offset'] );
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
			// Remote offset + remote length; crumb-less keeps the prior cursor.
			if ( null !== $crumb ) {
				$this->sse_in?->restore_position( $this->cursor_segment, $this->cursor_offset + $crumb['length'] );
			}
			// Clear streak on forward itself (cursor at boot); not in crawl.
			if ( ! $this->crawl && $this->attempts > 1 ) {
				$this->attempts       = 1;
				$this->first_crash_ts = null;
				$this->poison_reason  = '';
				$this->write_checkpoint_frame( true, true );
			}
		} catch ( Worker_Should_Stop $e ) {
			$clean = $e instanceof Worker_Should_Stop_Clean;
			// Commit past a crumb-bearing message not in crawl; else replay.
			if ( ( $clean || $this->assume_clean_shutdown ) && null !== $crumb && ! $this->crawl ) {
				$this->cursor_offset += $crumb['length'];
				throw $clean ? $e : new Worker_Should_Stop_Clean();
			}
			// Cooperative deadline: record the mid-dispatch stop, then escape.
			if ( ! $clean ) {
				$this->stopped_in_fill = true;
			}
			throw $e;
		} catch ( \Throwable $e ) {
			$this->dead_letter( $message, 'throw', $e );
			// Crumb-bearing message pins its start; else marker hits good line.
			if ( null !== $crumb ) {
				$this->mark_quarantined_at( $this->cursor_segment, $this->cursor_offset );
			}
		}
	}

	/**
	 * Durable-commit seam: commit the node-owned cursor as an offsetlog frame. Mirrors Consumer's
	 * checkpoint() — advance-guard (skip a redundant same-cursor write), forward-progress streak
	 * reset past the boot cursor (not in crawl, where attempts stay pinned), then write the frame.
	 */
	public function checkpoint( bool $graceful = false ): void {
		if ( null === $this->offsetlog || ( ! $this->poll_initialized && ! $this->offset_set ) ) {
			return;
		}
		if ( ! $graceful && ! $this->cursor_moved_since_checkpoint( $this->cursor_segment, $this->cursor_offset ) ) {
			return;
		}
		if ( ! $graceful && ! $this->crawl && $this->cursor_advanced_since_boot() ) {
			$this->attempts       = 1;
			$this->first_crash_ts = null;
			$this->poison_reason  = '';
		}
		$this->write_checkpoint_frame( $graceful, true );
	}

	/**
	 * Crawl-entry head sacrifice (the surviving sacrifice_head 3-way compare): decide the fate of
	 * the first relayed message under an armed head-skip. An EXACT crumb-start match on the boot
	 * pin is the in-flight-at-crash suspect — dead-lettered ('crash') or dropped (already
	 * quarantined), the caller skips the forward. A start PAST the pin means the suspect was GC'd
	 * or the stream resumed beyond it — disarm without sacrificing and forward normally. Anything
	 * earlier keeps the flag armed for the real suspect. One-shot once resolved.
	 *
	 * @param array{segment:int, offset:int} $crumb The line's parsed breadcrumb (start).
	 * @return bool True when the head is condemned (sacrificed / dropped) so the caller skips the forward.
	 */
	private function sacrifice_boot_head( string $line, array $crumb ): bool {
		// Lexicographic (segment,offset) vs boot pin: 0=suspect, >0=past it.
		$cmp = [ $crumb['segment'], $crumb['offset'] ] <=> [ $this->boot_cursor_segment, $this->boot_cursor_offset ];
		if ( 0 === $cmp ) {
			$this->crawl_skip_head = false;
			if ( 'drop' === $this->skip_head_disposition ) {
				// Marker: head already in DLQ, drop silently, no second entry.
				$this->print_less_often( "{$this->name} boot head-drop: message at ", "{$this->boot_cursor_segment}:{$this->boot_cursor_offset}", ' is already quarantined — dropping' );
				return true;
			}
			// Crash suspect: dead-letter, quarantine-mark start (crash window).
			$this->dead_letter( $this->poison_from_line( $line, $crumb['segment'], $crumb['offset'] ), 'crash' );
			$this->write_checkpoint_frame( false, true, [ 'quarantined' => true ] );
			$this->sealed_quarantine = [ 'segment' => $crumb['segment'], 'offset' => $crumb['offset'] ];
			return true;
		}
		if ( 0 < $cmp ) {
			$this->crawl_skip_head = false;
			$this->print_less_often( "{$this->name} crawl head-sacrifice: suspect at ", "{$this->boot_cursor_segment}:{$this->boot_cursor_offset}", ' is gone (stream resumed past it) — not sacrificing' );
		}
		return false;
	}

	/**
	 * Seal an on-sight quarantine at `{segment,offset}` and commit a marker frame there (dead_letter
	 * must have run first). The frame PRESERVES the live attempt accounting (never graceful) so a
	 * throw during a climbing crash lineage doesn't reset the streak. The cursor still advances only
	 * on the next arrival; the marker makes any re-encounter of this position a silent drop.
	 */
	private function mark_quarantined_at( int $segment, int $offset ): void {
		$this->sealed_quarantine = [ 'segment' => $segment, 'offset' => $offset ];
		$this->cursor_segment    = $segment;
		$this->cursor_offset     = $offset;
		$this->write_checkpoint_frame( false, true, [ 'quarantined' => true ] );
	}

	/**
	 * Parse a raw line's breadcrumb into `{segment, offset, length}`, or null when the line won't
	 * unpack or its ID isn't a well-formed crumb. offset is the record's on-disk start; length is
	 * the crumb's own `segment:offset:length` third field — the spoke's authoritative byte size —
	 * falling back to the local received size for a legacy 2-field crumb. assume_clean_shutdown
	 * commits offset+length to advance PAST a durably-written message on a cooperative stop.
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
		$length = ( 3 === $count ) ? (int) $parts[2] : \strlen( $line ) + 1;
		return [ 'segment' => (int) $parts[0], 'offset' => (int) $parts[1], 'length' => $length ];
	}

	/**
	 * Read the latest committed frame, seed the node cursor + boot pin, resume the shared
	 * poison/crash accounting (attempts+1, a hard-crash lineage → crawl), and arm the boot
	 * head-skip. Idempotent: ensure_patrons calls it (to seed SSE_In's connect position before
	 * connect) and the Durable_Reader boot seam calls it again on the first poll. Empty on a
	 * fresh offsetlog.
	 *
	 * @return array{segment?:int,offset?:int}
	 */
	protected function restore_position(): array {
		if ( $this->position_restored ) {
			return [ 'segment' => $this->cursor_segment, 'offset' => $this->cursor_offset ];
		}
		if ( null === $this->ensure_offsetlog() ) {
			return [];
		}
		$this->position_restored = true;
		$value                   = $this->read_last_offsetlog_frame();
		if ( null === $value ) {
			return [];
		}
		$segment = $value['segment'] ?? 0;
		$offset  = $value['offset'] ?? 0;
		$segment = Core::as_int( $segment );
		$offset  = Core::as_int( $offset );
		// Arm head-skip from frame: marker -> DROP head, crash -> sacrifice.
		$this->arm_skip_head_from_frame( $value );
		$this->cursor_segment      = $segment;
		$this->cursor_offset       = $offset;
		$this->boot_cursor_segment = $segment;
		$this->boot_cursor_offset  = $offset;
		if ( 'drop' === $this->skip_head_disposition ) {
			// Booted onto marker: seal boot pos until drop advances past it.
			$this->sealed_quarantine = [ 'segment' => $segment, 'offset' => $offset ];
		}
		return [
			'segment' => $segment,
			'offset'  => $offset,
		];
	}

	/**
	 * Final cursor handoff at worker shutdown (bug C) — Remote_Source isn't a Consumer_Node, so
	 * the worker's checkpoint_durable_consumers() reaches it here. Healthy → a clean graceful
	 * commit (attempts=0) so progress survives the recycle; a hard-crash lineage in flight →
	 * preserve its climbing/pinned frame. The cooperative-stop fair-shot is the Durable_Reader
	 * trait's cooperative_stop() (buffer_head_line + stopped_in_fill).
	 *
	 * @api Invoked by Worker_Base::checkpoint_durable_consumers().
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
	 * @param array<array-key,mixed> $extra Per-call frame additions (the quarantine marker).
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
	 * Build the base patrons, then override SSE_In's delivery seam: each raw `msg` payload is
	 * appended (with its newline) to the Durable_Reader buffer for the tick to drain — the push
	 * source buffers rather than forwarding straight downstream (the base channel path). The
	 * valve stays OPEN through normal flow and only closes once the buffer crosses the high-water
	 * mark (An unparseable line reaches the buffer unparsed; forward_line owns its DLQ.)
	 *
	 * The arrival also takes the busy cadence itself. A push source learns of data HERE, on the
	 * curl drain, between fires — so leaving the schedule to fire() would put up to a full
	 * TICK_INTERVAL_MS on the front of every burst, since that re-arm only runs after a fire has
	 * already seen the buffer. fire() drops back to the channel tick once the buffer is dry.
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

	/** Record a heartbeat reply's round-trip into the status snapshot. */
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
	 * window; otherwise it's nulled. Live values ride the write_status merge.
	 */
	protected function publish_status(): void {
		$conn = null !== $this->sse_in
			? $this->sse_in->connection()
			: [ 'connected' => false, 'last_http_code' => null, 'last_error' => null, 'current_backoff' => SSE_In_Node::INITIAL_BACKOFF, 'last_sse_heartbeat' => null, 'last_attempt' => null, 'scheduled_reconnect_at' => null ];
		$data = [
			'last_connection_attempt' => $conn['last_attempt'],
			'connected'               => $conn['connected'],
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
	 * @param array<string,mixed> $data
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

	private function status_key(): string {
		return self::status_key_for( $this->name, $this->remote_partition );
	}

	/**
	 * Keyed by NODE NAME first so two spokes on same partition don't collide,
	 * and site-scoped so two HUBS naming a spoke alike don't either. Public
	 * because the reader (Aggregator_CI) must resolve the writer's exact key
	 * rather than rebuild it — the two used to spell it separately.
	 */
	public static function status_key_for( string $name, string $partition ): string {
		return Cache_Backend::site_key( "remote:{$name}:{$partition}" );
	}

	/**
	 * Refill seam: the async backpressure VALVE (the dual of Consumer's synchronous disk read).
	 * The valve is edge-triggered on the buffer BYTE size — pump_maybe_disarm() closes it in
	 * on_message once accumulation crosses the high-water mark; this re-opens it only once the
	 * tick's drain has brought the buffer back below low-water. So it stays OPEN through normal
	 * flow (no arm per poll, no disarm on an empty buffer — the curl multi parks an idle stream
	 * without spinning). In unit tests the register/unregister toggles are inert.
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
	 * ahead of it and the spoke re-sends it. The exception is a cursor still at
	 * {0,0} — maybe_connect() then sends no `positions` at all and the spoke
	 * tail-seeks to `end`, replaying nothing, so the buffer is the only copy of
	 * those records and clearing it would lose them rather than de-duplicate.
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

	/** One node pulls one remote partition, so its sidecars are named for it. */
	protected function offsetlog_name(): string {
		return '' !== $this->name ? "{$this->name}:{$this->remote_partition}:offsetlog" : '';
	}

	protected function deadletter_name(): string {
		return '' !== $this->name ? "{$this->name}:{$this->remote_partition}:deadletter" : '';
	}

	/**
	 * Consume-cursor advance seam: NO-OP. Consumer bumps cursor_offset by the local buffer chop;
	 * a push source pins its cursor from each line's breadcrumb in drain_line/forward_line, so the
	 * chop index (a local-buffer position) is not a remote seg:offset and must not touch the cursor.
	 */
	protected function advance_consume_cursor( int $pos ): void {}

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
	 * Teardown: tear down the offsetlog + deadletter, then the patrons + self via the base.
	 *
	 * @api Dynamic entrypoint.
	 */
	public function remove_node(): void {
		$this->offsetlog?->remove_node();
		$this->offsetlog = null;
		$this->deadletter?->remove_node();
		$this->deadletter = null;
		parent::remove_node();
	}

	/**
	 * Re-emit the shared time-travel config verbs after the base lines, so a console
	 * dump_config → replay round-trips this source's snapshot node.
	 */
	public function dump_config(): string {
		return parent::dump_config() . $this->dump_time_travel_config() . $this->dump_toggles();
	}

	public static function node_schema(): array {
		$parent = parent::node_schema();
		/** @var list<array<string,mixed>> $parent_args */
		$parent_args = $parent['arguments'];
		return \array_merge( $parent, [
			// Parent Remote_Link_Node 'Hidden'; pin droppable subclass to I/O.
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
