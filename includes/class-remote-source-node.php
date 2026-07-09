<?php
/**
 * Remote_Source: a self-sufficient, topology-visible SSE-pull aggregation node.
 *
 * Extends Remote_Link with the one concern that distinguishes durable aggregation
 * from a transient channel: a per-node offsetlog (`<offsets_dir>/<name>.<remote_partition>`,
 * keyed by NODE NAME). It restores the committed `{segment,offset}` cursor into SSE_In
 * before connect (the `restore_position` seam) and commits the live cursor every
 * ~COMMIT_INTERVAL seconds (the `persist_cursor` seam). Everything else — the
 * SSE_In + HTTP_Out patrons, the heartbeat, the status snapshot, the tick — is the
 * Remote_Link base.
 *
 * Credentials + URL come from the Vault entry resolved by `<vault-id>`; a missing
 * entry leaves the node disconnected (no mis-configured patrons created).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Remote_Source_Node extends Remote_Link_Node {
	use Offsetlog_Cursor;
	use Dead_Letter_Queue;
	use Time_Travel;

	/** Memcache TTL for the status snapshot (seconds). */
	public const STATUS_TTL = 300;
	protected int $boot_cursor_offset = 0;

	/**
	 * The cursor this process booted on (seeded by restore_position). Advancing past it is
	 * "forward progress" — the fair-shot proxy for a cooperative-stop strike ([42]), EXACTLY
	 * like Consumer's boot_cursor.
	 */
	protected int $boot_cursor_segment = 0;

	/**
	 * True once restore_position has run (the cursor is real, not the 0:0 construction default).
	 * A shutdown handoff before this must NOT commit — it would clobber the durable position.
	 * Mirrors Consumer's poll_initialized.
	 */
	protected bool $cursor_established = false;
	protected int $cursor_offset = 0;

	/**
	 * The node-owned durable read cursor: the start of the next unforwarded message (=
	 * the last forwarded message's END, or the restored boot position). Advanced AFTER a
	 * successful downstream forward — the offsetlog commits THIS, never SSE_In's eager
	 * connection position. The Time_Travel trait reads it; the committed {segment,offset} it
	 * compares against is the trait's checkpoint_*.
	 */
	protected int $cursor_segment = 0;
	private int $last_heartbeat_response = 0;

	private int $last_heartbeat_sent     = 0;

	/**
	 * The message in flight when the cooperative stop hit (null = none — an idle worker, not
	 * poison), plus its source start {segment,offset} (from its ID breadcrumb) and its exclusive
	 * next-read {segment,offset} — captured at the throw because, unlike Consumer's buffered
	 * head, a push source holds no line to re-read at cooperative_stop time.
	 *
	 * @var array<int, mixed>|null
	 */
	private ?array $stopped_message = null;
	/** @var array{segment:int,offset:int}|null */
	private ?array $stopped_message_end = null;
	/** @var array{segment:int,offset:int}|null */
	private ?array $stopped_message_start = null;

	/** Tachikoma-parity: no-arg ctor. Auto-wire the {name}:config interpreter for the time-travel verbs. */
	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	/**
	 * Stream data relayed from our own SSE_In patron — quarantine-guarded — vs the base
	 * channel's traffic. SSE_In's sink is pointed at THIS node (see ensure_patrons) so
	 * each parsed stream message passes through here; a heartbeat reply or an outbound
	 * command is the base channel's (record-reply vs send). Discriminate by TYPE, not by
	 * a FROM-prefix match: an over-MAX_FROM_SIZE message that lost its stamp must still
	 * route by what it IS (TM_BYTESTREAM/TM_STRUCT = stream data), not by its FROM.
	 *
	 * @api Dynamic entrypoint.
	 * @param array<int, mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		$type       = \is_int( $message[ Message::TYPE ] ) ? $message[ Message::TYPE ] : 0;
		$is_command = 0 !== ( $type & Message::TM_COMMAND );
		if ( ! $is_command && 0 !== ( $type & ( Message::TM_BYTESTREAM | Message::TM_STRUCT ) ) ) {
			$this->relay_stream_message( $message );
			return;
		}
		parent::fill( $message );
	}

	/**
	 * Relay one stream message downstream, Consumer's model all the way down ([42]): a
	 * Worker_Should_Stop is control flow and escapes; any other Throwable is a won't-forward
	 * poison → dead-lettered ON SIGHT (no head-block, no fair-shot climb) and the cursor
	 * advances PAST it, exactly like Consumer's forward_line. The fair-shot climb is reserved
	 * for the hard-crash lineage (crawl, seeded by restore_position). A null downstream FAILS
	 * LOUD (bug D) rather than silently dropping while the stream is consumed.
	 *
	 * @param array<int, mixed> $message The 7-field positional message array.
	 */
	private function relay_stream_message( array $message ): void {
		$sink = $this->sink;
		if ( null === $sink ) {
			throw new \RuntimeException( 'Remote_Source relay requires a wired sink' );
		}
		$crumb = $this->parse_breadcrumb( $message );
		if ( ! ( $this->crawl_skip_head && null !== $crumb && $this->sacrifice_head( $message, $crumb ) ) ) {
			try {
				$sink->fill( $message );
			} catch ( Worker_Should_Stop $e ) {
				// Cooperative deadline mid-forward of THIS message: record it for the fair-shot rule, then escape.
				$this->stopped_message       = $message;
				$this->stopped_message_start = null === $crumb ? null : [ 'segment' => $crumb['segment'], 'offset' => $crumb['offset'] ];
				$this->stopped_message_end   = null === $crumb ? null : [ 'segment' => $crumb['segment'], 'offset' => $crumb['offset'] + $crumb['length'] ];
				throw $e;
			} catch ( \Throwable $e ) {
				// Consumer's model: a downstream throw dead-letters on sight (no block, no climb); the cursor advances below.
				$this->ensure_deadletter_sibling();
				$this->dead_letter( $message, 'throw', $e );
			}
		}
		// Advance to this message's exclusive next-read (offset+length) from its own breadcrumb — the remote stamped the on-disk length.
		if ( null !== $crumb ) {
			$this->cursor_segment = $crumb['segment'];
			$this->cursor_offset = $crumb['offset'] + $crumb['length'];
		}
		$this->after_forward();
	}

	/**
	 * Crawl-entry head sacrifice (Consumer-parity [42]): decide the fate of the first relayed
	 * message under an armed head-sacrifice. Only an EXACT crumb-start match on the boot pin is
	 * the in-flight-at-crash suspect — dead-lettered with reason 'crash' (return true → skip the
	 * forward; the caller still advances the cursor past it via the crumb). A start PAST the pin
	 * means the suspect was GC'd or the stream resumed beyond it — disarm without sacrificing and
	 * forward normally (return false). Anything earlier keeps the flag armed for the real suspect.
	 * One-shot either way once resolved.
	 *
	 * @param array<int, mixed>                       $message The relayed stream message.
	 * @param array{segment:int, offset:int, length:int} $crumb Its parsed ID breadcrumb.
	 * @return bool True when the message was dead-lettered as the suspect (skip the forward).
	 */
	private function sacrifice_head( array $message, array $crumb ): bool {
		// Lexicographic (segment, offset) compare against the boot pin: 0 = the suspect, >0 = past it.
		$cmp = [ $crumb['segment'], $crumb['offset'] ] <=> [ $this->boot_cursor_segment, $this->boot_cursor_offset ];
		if ( 0 === $cmp ) {
			$this->crawl_skip_head = false;
			$this->ensure_deadletter_sibling();
			$this->dead_letter( $message, 'crash' );
			return true;
		}
		if ( 0 < $cmp ) {
			$this->crawl_skip_head = false;
			$this->print_less_often( "{$this->name} crawl head-sacrifice: suspect at {$this->boot_cursor_segment}:{$this->boot_cursor_offset} is gone (stream resumed past it) — not sacrificing" );
		}
		return false;
	}

	/**
	 * Post-forward bookkeeping ([42]): the crawl per-message checkpoint (+ exit), or a
	 * forward-progress streak reset after a hard-crash lineage cleared. The healthy steady
	 * state commits via the throttled persist_cursor, not here (matching Consumer).
	 */
	private function after_forward(): void {
		$segment = $this->cursor_segment;
		$offset = $this->cursor_offset;
		if ( $this->crawl ) {
			// Survived a full interval crash-free → drop back to the baseline; either way
			// checkpoint per message (pinned attempts while crawling, baseline once exited)
			// so an uncatchable re-crash pins the exact culprit. Don't exit while the head
			// sacrifice is still armed (mirrors Consumer): an un-sacrificed suspect would
			// re-arm the crash loop next boot.
			if ( ! $this->crawl_skip_head && $this->crawl_interval_elapsed() ) {
				$this->exit_crawl();
			}
			$this->commit_position( $segment, $offset, false );
			return;
		}
		if ( $this->attempts > 1 ) {
			// Forward progress past a poison lineage: the poison was transient → clear the streak.
			$this->attempts       = 1;
			$this->first_crash_ts = null;
			$this->poison_reason  = '';
			$this->commit_position( $segment, $offset, true );
		}
	}

	/**
	 * Read the latest committed frame into the position seeding SSE_In before connect,
	 * and resume the shared poison/crash accounting from it (attempts+1, a hard-crash
	 * lineage → crawl). Empty on a fresh offsetlog.
	 *
	 * @return array{segment?:int,offset?:int}
	 */
	protected function restore_position(): array {
		if ( null === $this->ensure_offsetlog_partition() ) {
			return [];
		}
		// The cursor is now real (this ran) — a shutdown before it must not clobber it. Mirrors
		// Consumer's poll_initialized; set even on a fresh offsetlog (like poll_init runs).
		$this->cursor_established = true;
		$value = $this->read_last_offsetlog_frame();
		if ( null === $value ) {
			return [];
		}
		$segment = $value['segment'] ?? 0;
		$offset = $value['offset'] ?? 0;
		$segment = \is_scalar( $segment ) ? (int) $segment : 0;
		$offset = \is_scalar( $offset ) ? (int) $offset : 0;
		// Resume the shared attempt accounting (climb at attempts+1, carry the streak, detect a
		// hard-crash lineage → crawl). A cooperative-stop lineage climbs here too. On crawl entry
		// arm the head sacrifice: the boot pin (frozen just below) is the crash suspect's start —
		// the first relayed message matching it is dead-lettered instead of forwarded.
		if ( $this->resume_attempts_from_frame( $value ) ) {
			$this->crawl_skip_head = true;
		}
		// Seed the node-owned cursor + freeze the boot cursor at the restored position (so
		// cursor_advanced_since_boot() is honest); forwards advance the cursor past boot.
		$this->cursor_segment      = $segment;
		$this->cursor_offset      = $offset;
		$this->boot_cursor_segment = $segment;
		$this->boot_cursor_offset = $offset;
		return [
			'segment' => $segment,
			'offset'     => $offset,
		];
	}

	/**
	 * Throttled healthy cursor commit (the base channel's per-tick seam). Skipped while a
	 * hard-crash lineage is in flight (crawling / climbing) — that commits per message on the
	 * relay path (after_forward) so the throttle can't overwrite the per-message frame.
	 */
	protected function persist_cursor(): void {
		if ( $this->crawl || $this->attempts > 1 ) {
			return;
		}
		if ( ! $this->checkpoint_due() || null === $this->sse_in ) {
			return;
		}
		$segment = $this->cursor_segment;
		$offset = $this->cursor_offset;
		// Advance-guard (matches Consumer): skip a redundant same-cursor write so an idle
		// stream doesn't spam identical keyframes, one per interval.
		if ( ! $this->cursor_moved_since_checkpoint( $segment, $offset ) ) {
			return;
		}
		$this->commit_position( $segment, $offset, true );
	}

	/**
	 * Cooperative-stop fair-shot ([42]) — EXACTLY Consumer's rule, adapted to the push arrival
	 * seam. Called at worker shutdown INSTEAD of checkpoint_shutdown when the stop was
	 * cooperative (timeout/memory). A strike counts ONLY when the worker stopped mid-forward on
	 * the message it BOOTED on (the cursor never advanced this lifetime). An advanced cursor is
	 * a normal recycle and a not-stopped-in-fill worker is idle — both hand off cleanly
	 * (attempts=0). At COOP_MAX strikes the in-flight message is quarantined and the cursor
	 * advances past it; below it, the strike is recorded at the message's own start so the
	 * respawn re-pulls it and climbs.
	 *
	 * @api Invoked by Worker_Base::checkpoint_durable_consumers() on a cooperative stop.
	 * @param string $reason                  'timeout' | 'memory'.
	 * @param bool   $baseline_near_watermark Memory-only: the fresh post-reset baseline was
	 *                                        already near the watermark, so a leak / undersized
	 *                                        memory_limit — not this message — is to blame.
	 */
	public function cooperative_stop( string $reason, bool $baseline_near_watermark ): void {
		if ( null === $this->ensure_offsetlog_partition() || ! $this->cursor_established ) {
			return; // Ephemeral, or an unestablished cursor — nothing to strike.
		}
		// Strike only a boot-cursor message the worker stopped mid-forward; else clean handoff.
		if ( null === $this->stopped_message || $this->cursor_advanced_since_boot() ) {
			$this->checkpoint_shutdown();
			return;
		}
		if ( 'memory' === $reason && $baseline_near_watermark ) {
			$this->print_less_often( "WARNING: {$this->name} baseline memory near the watermark at a cooperative stop — raise memory_limit or investigate a leak; not striking the in-flight message" );
			$this->checkpoint_shutdown();
			return;
		}
		// The boot-cursor message got a full worker lifetime and we stopped on it: a strike.
		if ( $this->record_poison_strike( $reason ) ) {
			// Fair shots exhausted: quarantine, advance PAST it (its exclusive next-read), hand
			// off at the virgin baseline.
			$this->ensure_deadletter_sibling();
			$this->dead_letter( $this->stopped_message, $reason );
			$end = $this->stopped_message_end ?? [ 'segment' => $this->cursor_segment, 'offset' => $this->cursor_offset ];
			$this->commit_position( $end['segment'], $end['offset'], true );
			return;
		}
		// Below threshold: record the strike at the message's OWN start with the climbing
		// attempts/reason so the respawn re-pulls exactly it and climbs.
		$start = $this->stopped_message_start ?? [ 'segment' => $this->cursor_segment, 'offset' => $this->cursor_offset ];
		$this->commit_position( $start['segment'], $start['offset'], false );
	}

	/**
	 * Final cursor handoff at worker shutdown (bug C) — Remote_Source isn't a
	 * Consumer_Node, so the worker's checkpoint_durable_consumers() reaches it here.
	 * Healthy → a clean graceful commit (attempts=0) so progress survives the recycle;
	 * a hard-crash lineage in flight → preserve its climbing/pinned frame.
	 *
	 * @api Invoked by Worker_Base::checkpoint_durable_consumers().
	 */
	public function checkpoint_shutdown(): void {
		if ( null === $this->ensure_offsetlog_partition() || ! $this->cursor_established ) {
			return;
		}
		$graceful = $this->attempts <= 1 && ! $this->crawl;
		$this->commit_position( $this->cursor_segment, $this->cursor_offset, $graceful );
	}

	/** True once the read cursor has moved past the cursor this process booted on (Consumer-parallel). */
	private function cursor_advanced_since_boot(): bool {
		return $this->cursor_segment > $this->boot_cursor_segment
			|| ( $this->cursor_segment === $this->boot_cursor_segment && $this->cursor_offset > $this->boot_cursor_offset );
	}

	/**
	 * Parse the record's ID breadcrumb "segment:offset:length" into its parts, or null when the
	 * ID isn't a well-formed breadcrumb. offset is the record's own on-disk start; offset+length
	 * is its exclusive next-read (the next record's boundary).
	 *
	 * @param array<int, mixed> $message
	 * @return array{segment:int, offset:int, length:int}|null
	 */
	private function parse_breadcrumb( array $message ): ?array {
		$id    = Core::as_string( $message[ Message::ID ] ?? '' );
		$parts = \explode( ':', $id );
		if ( 3 !== \count( $parts ) || ! \ctype_digit( $parts[0] ) || ! \ctype_digit( $parts[1] ) || ! \ctype_digit( $parts[2] ) ) {
			return null;
		}
		return [ 'segment' => (int) $parts[0], 'offset' => (int) $parts[1], 'length' => (int) $parts[2] ];
	}

	/**
	 * Commit one offsetlog frame at `{segment,offset}` via the shared writer. A graceful frame is
	 * a clean handoff (attempts=0 → a respawn resumes at the virgin baseline); a non-graceful
	 * frame carries the live attempt accounting (a climbing hard-crash lineage / pinned crawl).
	 * Ensures the lazy per-node offsetlog exists first (Consumer builds its in arguments()).
	 */
	private function commit_position( int $segment, int $offset, bool $graceful ): void {
		if ( null === $this->ensure_offsetlog_partition() ) {
			return;
		}
		$this->commit_checkpoint_frame( $segment, $offset, $graceful );
	}

	// =========================================================================
	// Durable offsetlog — per-node, keyed by NODE NAME.
	// =========================================================================

	/**
	 * Ensure the per-node offsetlog Partition exists + is registered. Derives the
	 * dir (`<offsets_dir>/<name>.<remote_partition>`), delegates the build to the
	 * Offsetlog_Cursor trait, and routes its sink to the command interpreter.
	 */
	private function ensure_offsetlog_partition(): ?Partition_Node {
		if ( null !== $this->offsetlog ) {
			return $this->offsetlog;
		}
		if ( '' === $this->name ) {
			return null;
		}
		$offsets_dir = Config::get_offsets_directory();
		if ( '' === $offsets_dir ) {
			return null;
		}
		$offsetlog = $this->ensure_offsetlog(
			"{$offsets_dir}/{$this->name}.{$this->remote_partition}",
			"{$this->name}:{$this->remote_partition}:offsetlog",
			self::OFFSETLOG_SEGMENT_SIZE,
			self::OFFSETLOG_NUM_SEGMENTS
		);
		$ci = Core::node( Node_Names::COMMAND_INTERPRETER );
		if ( null !== $offsetlog && null === $offsetlog->sink() && null !== $ci ) {
			$offsetlog->sink( $ci );
		}
		return $offsetlog;
	}

	/**
	 * SEEK_FRAME landing: reseed SSE_In from the frame's {segment,offset} and drop the
	 * current stream. Seeking only ever happens while paused (the transport bar
	 * gates rewind/forward on PAUSE), so the reconnect is deferred to PLAY's tick —
	 * which replays the remote partition from the reseeded offset.
	 *
	 * @param string|array<array-key, mixed> $position Explicit {segment,offset} from seek_frame().
	 */
	public function next_offset( $position ): void {
		if ( ! \is_array( $position ) ) {
			return;
		}
		$segment = \is_numeric( $position['segment'] ?? null ) ? (int) $position['segment'] : 0;
		$offset = \is_numeric( $position['offset'] ?? null ) ? (int) $position['offset'] : 0;
		$sse = $this->ensure_patrons();
		if ( null === $sse ) {
			return;
		}
		$sse->disconnect();
		$sse->restore_position( $segment, $offset );
		$this->cursor_segment = $segment;
		$this->cursor_offset = $offset;
	}

	// =========================================================================
	// Patron wiring — relay the stream through our own fill() (see fill()).
	// =========================================================================

	/**
	 * Build the base patrons, then point SSE_In's sink at THIS node so each stream
	 * message passes through fill() (where a poison one is quarantined). The base
	 * already set SSE_In's target to our downstream path, so healthy messages still
	 * land at the same place — we just interpose ourselves for the poison guard.
	 */
	protected function ensure_patrons(): ?SSE_In_Node {
		$sse = parent::ensure_patrons();
		$sse?->sink( $this );
		if ( null !== $sse ) {
			// Route an unparseable frame into this node's DLQ at its last known
			// position — same quarantine the Consumer gives a torn on-disk line.
			$sse->on_poison = function ( string $raw ): void {
				$this->ensure_deadletter_sibling();
				$pos = $this->sse_in?->position() ?? [ 'segment' => 0, 'offset' => 0 ];
				$this->dead_letter( $this->poison_from_line( $raw, $pos['segment'], $pos['offset'] ), 'unparseable' );
			};
		}
		return $sse;
	}

	// =========================================================================
	// Dead-letter sibling — per-node quarantine for poison stream messages.
	// =========================================================================

	/**
	 * Ensure the per-node deadletter Partition exists. Derives the dir
	 * (`<base>/deadletter/<name>.<remote_partition>`), delegates the build to the
	 * Dead_Letter_Queue trait, and routes its sink to the command interpreter.
	 */
	private function ensure_deadletter_sibling(): ?Partition_Node {
		if ( null !== $this->deadletter ) {
			return $this->deadletter;
		}
		if ( '' === $this->name ) {
			return null;
		}
		$base       = \rtrim( Config::get_base_directory(), '/' );
		$deadletter = $this->ensure_deadletter(
			"{$base}/deadletter/{$this->name}.{$this->remote_partition}",
			"{$this->name}:{$this->remote_partition}:deadletter"
		);
		$ci = Core::node( Node_Names::COMMAND_INTERPRETER );
		if ( null !== $deadletter && null === $deadletter->sink() && null !== $ci ) {
			$deadletter->sink( $ci );
		}
		return $deadletter;
	}

	// =========================================================================
	// Dashboard status snapshot — a per-node memcache key the Aggregator reads.
	// These override the Remote_Link no-op seams; only aggregated spokes publish
	// status (a Remote_IPC channel isn't aggregated, so it stays a no-op there).
	// =========================================================================

	/** Stamp the heartbeat send-time so record_heartbeat_reply() can compute the round-trip. */
	protected function record_heartbeat_sent( int $now ): void {
		$this->last_heartbeat_sent = $now;
		$this->write_status( [ 'last_heartbeat_sent' => $now ] );
	}

	/** Record a heartbeat reply's round-trip into the status snapshot. */
	protected function record_heartbeat_reply(): void {
		if ( 0 === $this->last_heartbeat_sent ) {
			return;
		}
		$now                           = (int) Core::$now;
		$this->last_heartbeat_response = $now;
		$this->write_status( [
			'last_heartbeat_response' => $now,
			'last_heartbeat_rtt'      => $now - $this->last_heartbeat_sent,
		] );
	}

	/**
	 * Publish the connection-state snapshot from SSE_In::connection(). Ages out the
	 * heartbeat round-trip so the dashboard's Status badge can't latch 'success' on a
	 * stale timestamp: the response is "live" only while connected AND seen within the
	 * node's HEARTBEAT_INTERVAL*4 window (the slot-TTL span); otherwise it's nulled
	 * (mirrors the old clear-on-disconnect). Live values ride the write_status merge.
	 */
	protected function publish_status(): void {
		$conn = null !== $this->sse_in
			? $this->sse_in->connection()
			: [ 'connected' => false, 'last_http_code' => null, 'last_error' => null, 'current_backoff' => SSE_In_Node::INITIAL_BACKOFF, 'last_sse_heartbeat' => null, 'last_attempt' => null ];
		$data = [
			'last_connection_attempt' => $conn['last_attempt'],
			'connected'               => $conn['connected'],
			'last_http_code'          => $conn['last_http_code'],
			'last_error'              => $conn['last_error'],
			'current_backoff'         => $conn['current_backoff'],
			'last_sse_heartbeat'      => $conn['last_sse_heartbeat'],
		];
		// Live only while connected AND the response is within the slot-TTL window.
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
		$cache = Core::$memd;
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

	// Keyed by NODE NAME first so two spokes pulling the same remote_partition
	// (e.g. firehose.p0) don't collide; Aggregator_CI reads the identical key.
	private function status_key(): string {
		return "np:remote:{$this->name}:{$this->remote_partition}";
	}

	/**
	 * Remote_Source's frame extra beyond the shared base: the commit wall-clock, carried on
	 * every frame so an idle-vs-fresh cursor is distinguishable in the durable record.
	 *
	 * @return array<array-key, mixed>
	 */
	protected function checkpoint_frame_extra(): array {
		return [ '_ts' => (int) Core::$now ];
	}

	// =========================================================================
	// Time-travel transport (Time_Travel trait) — mapped onto the SSE pull.
	// =========================================================================

	/**
	 * Fold the time-travel READ surface (frames + cursor) into the canvas-poll payload.
	 * The reported cursor is the node-owned after-forward cursor (cursor_segment/off) — the
	 * single source of truth now — so no SSE_In sync is needed.
	 *
	 * @api Dynamic entrypoint.
	 * @return array{frames: array<int, array{id:int,size:int}>, cursor: array{segment:int, offset:int}, polling: string, at_frame: int|null, on_frame: bool}
	 */
	public function dump_metadata(): array {
		return $this->time_travel_metadata();
	}

	/**
	 * STEP is a no-op for a push-driven source: SSE_In is fed by the event loop, not
	 * pulled one message at a time, so there is nothing to single-step. Report the
	 * current position (nothing advanced) rather than fake a step.
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
	 * dump_config → replay round-trips this source's snapshot node (same gap the
	 * Consumer had) rather than silently losing it.
	 */
	public function dump_config(): string {
		return parent::dump_config() . $this->dump_time_travel_config( $this->name );
	}

	/**
	 * @api Dynamic entrypoint.
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			// Explicit — the parent Remote_Link_Node is 'Hidden' (never used
			// directly), so pin this palette-droppable subclass to I/O.
			'category'    => 'I/O',
			'description' => 'Self-sufficient SSE-pull aggregation source for one spoke partition (Vault-resolved).',
			// The time-travel verbs (set_snapshot_node, set_line_mode, SEEK_FRAME,
			// PAUSE, PLAY, STEP) are shared with Consumer via the Time_Travel trait.
			'commands'    => self::time_travel_verbs(),
		] );
	}
}
