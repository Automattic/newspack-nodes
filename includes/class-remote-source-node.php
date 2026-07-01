<?php
/**
 * Remote_Source: a self-sufficient, topology-visible SSE-pull aggregation node.
 *
 * Extends Remote_Link with the one concern that distinguishes durable aggregation
 * from a transient channel: a per-node offsetlog (`<offsets_dir>/<name>.<remote_partition>`,
 * keyed by NODE NAME). It restores the committed `{seg,off}` cursor into SSE_In
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

	// Offsetlog geometry (OFFSETLOG_SEGMENT_SIZE / NUM_SEGMENTS), the throttle floor
	// ($last_checkpoint) and the committed-cursor bookkeeping ($checkpoint_seg/off) all
	// live in the Time_Travel trait, shared with Consumer.

	/**
	 * Live SSE_In read position the Time_Travel trait reads (synced in dump_metadata, the
	 * only reader). The committed {seg,off} it compares against is the trait's checkpoint_*.
	 */
	protected int $cursor_seg = 0;
	protected int $cursor_off = 0;

	/** Tachikoma-parity: no-arg ctor. Auto-wire the {name}:config interpreter for the time-travel verbs. */
	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	/**
	 * Poison head's own start `{seg,off}`; non-null = BLOCKED ([42]). While blocked,
	 * nothing past the poison forwards and the committed cursor freezes here, so a
	 * respawn re-pulls exactly this message and the attempt count climbs.
	 *
	 * @var array{seg:int,off:int}|null
	 */
	private ?array $poison_pos = null;

	/**
	 * A quarantined-poison offset `{seg,off}`; non-null = a `dlq`-marked frame is committed
	 * here ([42]). SSE_In can't compute the poison's byte END (its cursor sits at a message's
	 * OWN start, and the remote-log line length is unknown to the client), so "advance PAST"
	 * is durable as a marker AT the poison's offset: a respawn / idle reconnect re-pulls the
	 * poison once and DROPS it (recognized by this offset) instead of re-forwarding /
	 * re-quarantining it, and the cursor advances the moment a later message forwards past.
	 *
	 * @var array{seg:int,off:int}|null
	 */
	private ?array $dlq_pos = null;

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
	public function fill( array &$message ): void {
		$type       = \is_int( $message[ Message::TYPE ] ) ? $message[ Message::TYPE ] : 0;
		$is_command = 0 !== ( $type & Message::TM_COMMAND );
		if ( ! $is_command && 0 !== ( $type & ( Message::TM_BYTESTREAM | Message::TM_STRUCT ) ) ) {
			$this->relay_stream_message( $message );
			return;
		}
		parent::fill( $message );
	}

	/**
	 * Relay one stream message downstream with the full Consumer-style poison lifecycle
	 * ([42]): a Worker_Should_Stop is control flow and escapes; any other Throwable is
	 * poison that BLOCKS the head (strictly serialized — nothing past it forwards, the
	 * committed cursor freezes) until COOP_MAX fair shots across respawns, then it is
	 * dead-lettered and the cursor advances PAST it. A null downstream FAILS LOUD (bug D)
	 * rather than silently dropping while the stream is consumed.
	 *
	 * @param array<int, mixed> $message The 7-field positional message array.
	 */
	private function relay_stream_message( array &$message ): void {
		if ( null !== $this->poison_pos ) {
			return; // Head poison blocks: nothing past it forwards, committed cursor frozen.
		}
		if ( $this->at_dlq_offset() ) {
			return; // Re-pulled already-quarantined poison: drop (keep the marker until real progress past it).
		}
		$sink = $this->sink;
		if ( null === $sink ) {
			throw new \RuntimeException( 'Remote_Source relay requires a wired sink' );
		}
		try {
			$sink->fill( $message );
		} catch ( Worker_Should_Stop $e ) {
			throw $e; // Control flow, not poison: let the worker shut down.
		} catch ( \Throwable $e ) {
			$this->handle_poison( $message, $e );
			return;
		}
		$this->after_forward();
	}

	/**
	 * A caught downstream throw ([42]): block the head at the poison's OWN start and
	 * either climb (below COOP_MAX) or — fair shots exhausted — quarantine, advance PAST
	 * it (next message's offset, bug B), and resume.
	 *
	 * @param array<int, mixed> $message The poison message (relayed verbatim to the DLQ for replay).
	 */
	private function handle_poison( array &$message, \Throwable $e ): void {
		$pos              = $this->sse_in?->position() ?? [ 'segment_id' => 0, 'offset' => 0 ];
		$poison           = [ 'seg' => $pos['segment_id'], 'off' => $pos['offset'] ];
		$this->poison_pos = $poison;
		if ( $this->record_poison_strike( 'throw' ) ) {
			$this->ensure_deadletter_sibling();
			$this->dead_letter( $message, 'throw', $e );
			// Quarantine is terminal for this offset. Commit a durable `dlq` marker AT the
			// poison's offset NOW — not deferred to a next message — so an idle stream or a
			// recycle re-pulls it once and DROPS it (no re-quarantine), and the cursor
			// advances past the moment a later message forwards. Unblock + reset the streak.
			$this->dlq_pos        = $poison;
			$this->poison_pos     = null;
			$this->attempts       = 1;
			$this->first_crash_ts = null;
			$this->poison_reason  = '';
			$this->commit_position( $poison['seg'], $poison['off'], true, true );
			return;
		}
		// Below threshold: freeze the committed cursor at the poison's OWN start with the
		// climbing attempts/reason so the respawn re-pulls exactly this message and climbs.
		$this->commit_position( $poison['seg'], $poison['off'], false );
	}

	/**
	 * Post-forward bookkeeping ([42]): explicit advance-past after a quarantine, the
	 * crawl per-message checkpoint (+ exit), or a forward-progress streak reset after a
	 * transient poison cleared.
	 */
	private function after_forward(): void {
		if ( null === $this->sse_in ) {
			return;
		}
		$pos = $this->sse_in->position();
		$seg = $pos['segment_id'];
		$off = $pos['offset'];
		$dlq = $this->dlq_pos;
		if ( null !== $dlq
				&& ( $seg > $dlq['seg'] || ( $seg === $dlq['seg'] && $off > $dlq['off'] ) ) ) {
			// A later message forwarded past the quarantined poison → the marker is obsolete;
			// commit this (past-the-poison) position as the clean cursor.
			$this->dlq_pos = null;
			$this->commit_position( $seg, $off, true );
			return;
		}
		if ( $this->crawl ) {
			// Survived a full interval crash-free → drop back to the baseline; either way
			// checkpoint per message (pinned attempts while crawling, baseline once exited)
			// so an uncatchable re-crash pins the exact culprit.
			if ( $this->crawl_interval_elapsed() ) {
				$this->exit_crawl();
			}
			$this->commit_position( $seg, $off, false );
			return;
		}
		if ( $this->attempts > 1 ) {
			// Forward progress past a poison lineage: the poison was transient → clear the streak.
			$this->attempts       = 1;
			$this->first_crash_ts = null;
			$this->poison_reason  = '';
			$this->commit_position( $seg, $off, true );
		}
	}

	/**
	 * Read the latest committed frame into the position seeding SSE_In before connect,
	 * and resume the shared poison/crash accounting from it (attempts+1, a hard-crash
	 * lineage → crawl). Empty on a fresh offsetlog.
	 *
	 * @return array{segment_id?:int,offset?:int}
	 */
	protected function restore_position(): array {
		if ( null === $this->ensure_offsetlog_partition() ) {
			return [];
		}
		$value = $this->read_last_offsetlog_frame();
		if ( null === $value ) {
			return [];
		}
		$seg = $value['seg'] ?? 0;
		$off = $value['off'] ?? 0;
		$seg = \is_scalar( $seg ) ? (int) $seg : 0;
		$off = \is_scalar( $off ) ? (int) $off : 0;
		if ( ! empty( $value['dlq'] ) ) {
			// The frame marks this offset as an already-quarantined poison: arm the
			// re-pull-once-and-drop marker (the lineage is resolved, baseline attempts).
			$this->dlq_pos  = [ 'seg' => $seg, 'off' => $off ];
			$this->attempts = 1;
		} else {
			$this->resume_attempts_from_frame( $value );
		}
		return [
			'segment_id' => $seg,
			'offset'     => $off,
		];
	}

	/**
	 * Throttled healthy cursor commit (the base channel's per-tick seam). Skipped while
	 * a poison lineage is in flight (blocked / crawling / climbing) — those commit on the
	 * relay path so the throttle can't overwrite the frozen/per-message frame.
	 */
	protected function persist_cursor(): void {
		if ( null !== $this->poison_pos || $this->crawl || $this->attempts > 1 ) {
			return;
		}
		if ( ! $this->checkpoint_due() || null === $this->sse_in ) {
			return;
		}
		// A quarantined poison keeps its durable dlq marker (committed once by handle_poison)
		// until a later message advances past it — else an idle recycle would re-quarantine
		// the poison. Otherwise commit the live SSE_In position.
		$dlq = null !== $this->dlq_pos;
		if ( $dlq ) {
			$seg = $this->dlq_pos['seg'];
			$off = $this->dlq_pos['off'];
		} else {
			$pos = $this->sse_in->position();
			$seg = $pos['segment_id'];
			$off = $pos['offset'];
		}
		// Advance-guard (matches Consumer): skip a redundant same-cursor write so an idle
		// stream doesn't spam identical keyframes, one per interval.
		if ( ! $this->cursor_moved_since_checkpoint( $seg, $off ) ) {
			return;
		}
		$this->commit_position( $seg, $off, true, $dlq );
	}

	/**
	 * Final cursor handoff at worker shutdown (bug C) — Remote_Source isn't a
	 * Consumer_Node, so the worker's checkpoint_durable_consumers() reaches it here.
	 * Healthy → a clean graceful commit (attempts=0) so progress survives the recycle;
	 * a poison/crash lineage in flight → preserve its climbing/pinned frame.
	 *
	 * @api Invoked by Worker_Base::checkpoint_durable_consumers().
	 */
	public function checkpoint_shutdown(): void {
		if ( null === $this->ensure_offsetlog_partition() ) {
			return;
		}
		if ( null !== $this->poison_pos ) {
			$this->commit_position( $this->poison_pos['seg'], $this->poison_pos['off'], false );
			return;
		}
		if ( null !== $this->dlq_pos ) {
			// Preserve a pending quarantine marker across the recycle.
			$this->commit_position( $this->dlq_pos['seg'], $this->dlq_pos['off'], true, true );
			return;
		}
		if ( null === $this->sse_in ) {
			return;
		}
		$pos      = $this->sse_in->position();
		$graceful = $this->attempts <= 1 && ! $this->crawl;
		$this->commit_position( $pos['segment_id'], $pos['offset'], $graceful );
	}

	/** True when the live SSE_In cursor sits on a quarantined-poison offset (the re-pulled poison). */
	private function at_dlq_offset(): bool {
		$dlq = $this->dlq_pos;
		if ( null === $dlq || null === $this->sse_in ) {
			return false;
		}
		$pos = $this->sse_in->position();
		return $pos['segment_id'] === $dlq['seg'] && $pos['offset'] === $dlq['off'];
	}

	/**
	 * Commit one offsetlog frame at `{seg,off}` via the shared writer. A graceful frame is
	 * a clean handoff (attempts=0 → a respawn resumes at the virgin baseline); a non-graceful
	 * frame carries the live attempt accounting (a climbing poison lineage / pinned crawl).
	 * `$dlq` marks the offset as an already-quarantined poison so a respawn drops it once.
	 * Ensures the lazy per-node offsetlog exists first (Consumer builds its in arguments()).
	 */
	private function commit_position( int $seg, int $off, bool $graceful, bool $dlq = false ): void {
		if ( null === $this->ensure_offsetlog_partition() ) {
			return;
		}
		$this->commit_checkpoint_frame( $seg, $off, $graceful, $dlq ? [ 'dlq' => true ] : [] );
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
		return $sse;
	}

	// =========================================================================
	// Time-travel transport (Time_Travel trait) — mapped onto the SSE pull.
	// =========================================================================

	/**
	 * Fold the time-travel READ surface (frames + cursor) into the canvas-poll
	 * payload. Sync the reported cursor from the live SSE_In position first (the
	 * single source of truth — nothing else mirrors it), then delegate.
	 *
	 * @api Dynamic entrypoint.
	 * @return array{frames: array<int, array{id:int,size:int}>, cursor: array{seg:int, off:int}, polling: string, at_frame: int|null, on_frame: bool}
	 */
	public function dump_metadata(): array {
		$pos              = $this->sse_in?->position() ?? [ 'segment_id' => 0, 'offset' => 0 ];
		$this->cursor_seg = $pos['segment_id'];
		$this->cursor_off = $pos['offset'];
		return $this->time_travel_metadata();
	}

	/**
	 * SEEK_FRAME landing: reseed SSE_In from the frame's {seg,off} and drop the
	 * current stream. Seeking only ever happens while paused (the transport bar
	 * gates rewind/forward on PAUSE), so the reconnect is deferred to PLAY's tick —
	 * which replays the remote partition from the reseeded offset.
	 *
	 * @param string|array<array-key, mixed> $position Explicit {seg,off} from seek_frame().
	 */
	public function next_offset( $position ): void {
		if ( ! \is_array( $position ) ) {
			return;
		}
		$seg = \is_numeric( $position['seg'] ?? null ) ? (int) $position['seg'] : 0;
		$off = \is_numeric( $position['off'] ?? null ) ? (int) $position['off'] : 0;
		$sse = $this->ensure_patrons();
		if ( null === $sse ) {
			return;
		}
		$sse->disconnect();
		$sse->restore_position( $seg, $off );
	}

	/**
	 * STEP is a no-op for a push-driven source: SSE_In is fed by the event loop, not
	 * pulled one message at a time, so there is nothing to single-step. Report the
	 * current position (nothing advanced) rather than fake a step.
	 *
	 * @return array{seg:int, off:int, at_eof:bool}
	 */
	protected function advance_one_message(): array {
		$pos = $this->sse_in?->position() ?? [ 'segment_id' => 0, 'offset' => 0 ];
		return [ 'seg' => $pos['segment_id'], 'off' => $pos['offset'], 'at_eof' => true ];
	}

	/** PLAY re-arm: resume the recurring tick, which reconnects from the current position. */
	protected function time_travel_resume(): void {
		$this->set_timer( self::TICK_INTERVAL_MS );
	}

	/** PAUSE also stops the pull: drop the live SSE stream so no data flows while paused. */
	protected function time_travel_on_pause(): void {
		$this->sse_in?->disconnect();
	}

	// =========================================================================
	// Dashboard status snapshot — a per-node memcache key the Aggregator reads.
	// These override the Remote_Link no-op seams; only aggregated spokes publish
	// status (a Remote_IPC channel isn't aggregated, so it stays a no-op there).
	// =========================================================================

	/** Memcache TTL for the status snapshot (seconds). */
	public const STATUS_TTL = 300;

	private int $last_heartbeat_sent     = 0;
	private int $last_heartbeat_response = 0;

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
	 * @api Dynamic entrypoint.
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'description' => 'Self-sufficient SSE-pull aggregation source for one spoke partition (Vault-resolved).',
			// The time-travel verbs (set_snapshot_node, set_line_mode, SEEK_FRAME,
			// PAUSE, PLAY, STEP) are shared with Consumer via the Time_Travel trait.
			'commands'    => self::time_travel_verbs(),
		] );
	}
}
