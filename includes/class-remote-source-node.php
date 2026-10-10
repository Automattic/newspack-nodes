<?php
/**
 * Remote_Source: one SSE connection to a spoke, carrying a durable reader per stream.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

use Newspack_Nodes\Rest\SSE_Out_Node;

\defined( 'ABSPATH' ) || exit;

/**
 * An SSE-pull broker: one connection to a spoke carries every stream its
 * `<source>:<target>` pairs name, and each stamp it carries is read by its
 * own `Remote_Consumer_Node`.
 *
 * The command channel, the pairs and the readers come from
 * `Remote_Broker_Node`. This class adds the stream: an `SSE_In` patron
 * (`<name>:sse-in`), the slot-keepalive heartbeat it mints every
 * ~HEARTBEAT_INTERVAL through the channel's HTTP_Out (whose reply self-routes
 * back into `fill()` for RTT bookkeeping), the staggered connect queue, and
 * the routing between the stream and the readers. `SSE_In` hands each raw
 * `msg` payload to `route()`, which reads its FROM stamp and hands it to the
 * reader the first matching pair owns, building that reader on first sight.
 * A connect asks each live reader where its stream stands; a paused reader
 * drops out of the request and steps through `send_read()` over the HTTP_Out
 * instead. One valve meters the whole connection, on the bytes every reader
 * holds.
 *
 * Mirrors the JS RemoteLinkNode's channel, which the browser composes the
 * same way over its one page-wide stream.
 *
 * @phpstan-import-type Stream_Positions from SSE_In_Node
 * @phpstan-type Stream_Request array{0:list<string>,1:Stream_Positions}
 */
class Remote_Source_Node extends Remote_Broker_Node {

	/** `SSE_Slot_Pool` lease state for a slot released under us — expected, not an error. */
	public const RELEASED_SLOT = 'slot_released';

	/**
	 * SSE backpressure valve water marks: re-arm at 256 KB, disarm at 512 KB.
	 *
	 * The readers drain between arrivals, so their buffers accumulate in route():
	 * disarm once the sum crosses the high mark, re-arm once their drains bring
	 * it back under the low one. The hysteresis is what keeps the valve OPEN
	 * through normal flow. A single threshold closes it on every buffered line and
	 * stop-starts the spoke, which is what makes a hub-aggregation pull lag.
	 */
	private const PUMP_ARM_BYTES    = 262144;
	private const PUMP_DISARM_BYTES = 524288;

	/**
	 * Pending connects, drained one per tick by Connect_Queue_Timer_Node.
	 * Process-wide, exactly as Tachikoma's `@SPAWN_QUEUE` is package-wide.
	 *
	 * Each entry is `[ closure, owning source ]` so a removed source's pending
	 * connect can be purged rather than resurrect it.
	 *
	 * @var list<array{0: callable,1: self|null}>
	 */
	private static array $connect_queue = [];

	/** Whether this source already has a connect waiting in that queue. */
	private bool $connect_queued = false;

	/** Patron SSE_In sibling (`<name>:sse-in`); null until the Vault entry resolves. */
	protected ?SSE_In_Node $sse_in = null;

	/** Wall-second of the last heartbeat sent; the HEARTBEAT_INTERVAL gate reads it. */
	private int $last_heartbeat_sent = 0;

	/** Wall-second of the last heartbeat reply; 0 while none has come back. */
	private int $last_heartbeat_response = 0;

	/** Reason the last heartbeat failed, published as `last_error`; null on success. */
	private ?string $last_heartbeat_error = null;

	/** Mirror of the SSE_In valve state: true while armed. Only the readers' bytes flip it. */
	private bool $pump_armed = true;

	/**
	 * One tick's housekeeping: drive the passive SSE_In, keep the slot
	 * alive, and publish the status snapshot. Idempotent and cheap.
	 * `should_connect()` gates whether a tick initiates or keeps the
	 * connection.
	 */
	protected function housekeep(): void {
		if ( ! $this->should_connect() ) {
			$this->publish_status();
			return;
		}
		$sse = $this->ensure_patrons();
		if ( null === $sse ) {
			return;
		}
		$sse->check_stale();
		$this->queue_connect( $sse );
		$this->maybe_send_heartbeat();
		$this->publish_status();
	}

	/**
	 * Build the channel, then the SSE_In patron configured from the Vault
	 * entry, and wire its seams to the readers: the handshake and skip frames
	 * hand each stamp's cursor to the reader that owns it, and each raw `msg`
	 * payload goes through `route()`. The seal-grace flag is seeded onto it,
	 * because an aggregator configures its spokes before anything connects.
	 *
	 * @return SSE_In_Node|null The SSE_In patron once configured, else null.
	 */
	protected function ensure_patrons(): ?SSE_In_Node {
		if ( null !== $this->sse_in ) {
			return $this->sse_in;
		}
		$entry = $this->spoke_entry();
		if ( null === $entry || null === $this->ensure_channel() ) {
			return null;
		}
		$sse = new SSE_In_Node();
		$sse->patron( $this );
		$sse->on_connecting = function () use ( $sse ): void {
			[ $subscribe, $positions ] = $this->stream_request();
			$sse->streams( $subscribe, $positions );
		};
		$sse->configure(
			Vault::url_of( $entry ),
			Core::as_string( $entry['auth_username'] ?? '' ),
			Core::as_string( $entry['auth_password'] ?? '' ),
			Core::as_string( $entry['token'] ?? '' ),
			Vault::tls_opts(),
			Vault::require_ssl()
		);
		$sse->set_multi_writer( $this->multi_writer );
		$sse->on_connected = function ( array $cursors ): void {
			/** @var array<string,array{segment?:int,offset:int}> $cursors */
			foreach ( $cursors as $stamp => $cursor ) {
				$this->consumer_for( $stamp )?->adopt_stream_start( $cursor );
			}
		};
		$sse->on_skipped = function ( array $cursors ): void {
			/** @var array<string,array{segment?:int,offset:int}> $cursors */
			foreach ( $cursors as $stamp => $cursor ) {
				$this->reader( $stamp )?->skip_to( $cursor );
			}
		};
		$sse->on_message = function ( string $raw ): void {
			$this->route( $raw );
		};
		$this->sse_in = $sse;
		$this->publish_patron( self::SSE_IN_KIND, $sse );
		return $sse;
	}

	/**
	 * What the next connect asks for: each exact pair whose reader is live,
	 * from that reader's own position, and each glob, with every reader it
	 * already owns stated — a paused one as `SSE_Out_Node::SKIP`, so the glob
	 * keeps finding new dirs while that one stays out. A new stream opens with
	 * its valve armed.
	 *
	 * @return Stream_Request Subscriptions, then per-stamp positions.
	 */
	private function stream_request(): array {
		$this->pump_armed = true;
		$subscribe        = [];
		$positions        = [];
		foreach ( $this->pairs as $pair ) {
			$source = $pair['source'];
			if ( ! \str_contains( $source, '*' ) ) {
				$child = $this->consumer_for( $source );
				if ( null !== $child && $child->is_live() ) {
					$subscribe[]          = $source;
					$positions[ $source ] = $child->connect_position();
				}
				continue;
			}
			$subscribe[] = $source;
			foreach ( $this->readers() as $stamp => $child ) {
				if ( $this->pair_for( $stamp ) === $pair ) {
					$positions[ $stamp ] = $child->is_live() ? $child->connect_position() : SSE_Out_Node::SKIP;
				}
			}
		}
		return [ $subscribe, $positions ];
	}

	/**
	 * Route one raw `msg` payload, with its decoded message, to the reader its
	 * FROM stamp names. A frame that will not unpack has nothing to route by
	 * and is dropped, rate-limited; `consumer_for()` refuses the rest.
	 *
	 * @param string $raw One packed record.
	 */
	private function route( string $raw ): void {
		try {
			$message = Message::unpacked( $raw );
		} catch ( \InvalidArgumentException $e ) {
			$this->print_less_often( 'dropping unparseable SSE frame' );
			return;
		}
		$child = $this->consumer_for( Log_Discovery::dir_from_stamp( Core::as_string( $message[ Message::FROM ] ) ) );
		if ( null === $child ) {
			return;
		}
		$child->receive( $raw, $message );
		$this->pump_maybe_disarm();
	}

	/** Close the valve once the readers' backlog crosses the high-water mark. */
	private function pump_maybe_disarm(): void {
		if ( $this->pump_armed && $this->buffered_bytes() >= self::PUMP_DISARM_BYTES ) {
			$this->sse_in?->disarm();
			$this->pump_armed = false;
		}
	}

	/**
	 * Queue this source's connect instead of running it inline, and make sure
	 * the shared drain timer is up.
	 *
	 * Tachikoma `Job.pm`: a spawn pushes a closure onto `@SPAWN_QUEUE` and
	 * mounts `_spawn_timer` if absent. Same shape, same reason — an aggregator
	 * brings every Remote_Source up in one tick, and N simultaneous SSE
	 * connects are what the spoke answers with 429. The queued flag is what
	 * keeps a once-per-second housekeeping tick from queueing the same connect
	 * over and over while it waits its turn.
	 *
	 * @param SSE_In_Node $sse The patron stream to connect.
	 */
	private function queue_connect( SSE_In_Node $sse ): void {
		if ( $this->connect_queued ) {
			return;
		}
		$this->connect_queued = true;
		self::push_connect_queue(
			function () use ( $sse ): void {
				$this->connect_queued = false;
				// Its turn can come after the source stopped wanting it.
				if ( $this->should_connect() ) {
					$sse->maybe_connect();
				}
			},
			$this
		);
		if ( null === Core::node( Connect_Queue_Timer_Node::NODE_NAME ) ) {
			$timer = new Connect_Queue_Timer_Node();
			$timer->name( Connect_Queue_Timer_Node::NODE_NAME );
			// fire_cb() returns early on a null sink, before fire().
			$timer->sink( Core::node( Node_Names::COMMAND_INTERPRETER ) );
			$timer->set_timer( Connect_Queue_Timer_Node::INTERVAL_MS );
		}
	}

	/**
	 * Connect while any exact pair's reader is live, or any glob may yet find a
	 * dir. The tick builds each exact pair's reader before housekeeping, so
	 * this only reads them.
	 */
	protected function should_connect(): bool {
		$connect = false;
		foreach ( $this->pairs as [ 'source' => $source ] ) {
			$live    = \str_contains( $source, '*' ) || ( $this->reader( $source )?->is_live() ?? false );
			$connect = $connect || $live;
		}
		return $connect;
	}

	/**
	 * Append a connect for the drain timer to run. The owner may be null for a
	 * queue entry with no source to purge it (tests).
	 *
	 * @param callable  $connect The queued connect.
	 * @param self|null $owner   Source whose remove_node() should purge it.
	 */
	public static function push_connect_queue( callable $connect, ?self $owner ): void {
		self::$connect_queue[] = [ $connect, $owner ];
	}

	/**
	 * Every ~HEARTBEAT_INTERVAL seconds, mint a `workers.heartbeat` TM_COMMAND
	 * (FROM=<this node>, TO=workers, args `<slot> <owner>`) and fill it into the
	 * patron HTTP_Out. Skips until SSE_In reports the complete lease. The slot
	 * pool keys on (user, ip, slot, owner) — no partition.
	 *
	 * Signing needs a session with the spoke, so `mint()` mints nothing on a
	 * tick that finds none, asks for one on the broker's own throttle, and
	 * leaves the heartbeat clock where it was.
	 */
	private function maybe_send_heartbeat(): void {
		if ( null === $this->sse_in || null === $this->http_out ) {
			return;
		}
		$slot  = $this->sse_in->slot();
		$owner = $this->sse_in->owner();
		if ( null === $slot || $slot < 0 || null === $owner || $owner <= 0 ) {
			return;
		}
		$now = (int) Core::$now;
		// The lease exists from this tick; the session offset counts from it.
		if ( 0 === $this->lease_epoch ) {
			$this->lease_epoch = $now;
		}
		// Silence is not a refusal — HTTP_Out drops the session on a 401.
		if ( '' === $this->http_out->vault_id() || $now - $this->last_heartbeat_sent < self::HEARTBEAT_INTERVAL ) {
			return;
		}
		$message = $this->mint( $this->name, 'workers', 'heartbeat', [ (string) $slot, (string) $owner ] );
		if ( null === $message ) {
			return;
		}
		$this->last_heartbeat_sent = $now;
		++$this->counter;
		$this->http_out->fill( $message );
		$this->write_status( [ 'last_heartbeat_sent' => $now ] );
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
			: [ 'connected' => false, 'connecting' => false, 'last_http_code' => null, 'last_error' => null, 'current_backoff' => SSE_In_Node::INITIAL_BACKOFF, 'last_sse_heartbeat' => null, 'last_attempt' => null, 'scheduled_reconnect_at' => null, 'unparseable_lines' => 0 ];
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
			// Torn spoke lines this stream skipped; the pull itself stays up.
			'unparseable_lines'       => $conn['unparseable_lines'],
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
	 * The heartbeat's reply: a success records the round-trip, and a failure
	 * other than a released slot is said and published.
	 *
	 * @param array<int,mixed> $message The reply, TM_COMMAND|TM_RESPONSE or |TM_ERROR.
	 */
	protected function settle_reply( array $message ): void {
		$failure = self::heartbeat_failure( $message );
		if ( null === $failure ) {
			$this->record_heartbeat_reply();
		} elseif ( ! \str_contains( $failure, self::RELEASED_SLOT ) ) {
			// A released slot is a race, not a fault. Say nothing.
			$this->stderr( 'ERROR: client heartbeat failed - ' . $failure );
			$this->record_heartbeat_failure( $failure );
		}
	}

	/**
	 * Return null only for an explicit successful heartbeat response.
	 *
	 * @param array<int,mixed> $message Command response/error envelope.
	 * @return string|null The failure reason, or null on success.
	 */
	private static function heartbeat_failure( array $message ): ?string {
		$type    = Core::int( $message[ Message::TYPE ] );
		$value   = $message[ Message::VALUE ];
		$payload = \is_array( $value ) && \array_key_exists( 'payload', $value )
			? $value['payload']
			: $value;

		if ( $type & Message::TM_ERROR ) {
			return self::heartbeat_failure_reason( $payload, 'heartbeat command failed' );
		}
		if (
			! \is_array( $payload )
			|| ! \array_key_exists( 'success', $payload )
			|| true !== $payload['success']
		) {
			return self::heartbeat_failure_reason( $payload, 'heartbeat response was not successful' );
		}
		return null;
	}

	/**
	 * Extract only a bounded single-line reason, never a raw response body.
	 *
	 * @param mixed  $payload  The response payload, a string or an array.
	 * @param string $fallback Reason to report when the payload names none.
	 */
	private static function heartbeat_failure_reason( mixed $payload, string $fallback ): string {
		$reason = \is_string( $payload ) ? $payload : '';
		if ( \is_array( $payload ) ) {
			foreach ( [ 'error', 'message', 'reason' ] as $key ) {
				if ( isset( $payload[ $key ] ) && \is_string( $payload[ $key ] ) ) {
					$reason = $payload[ $key ];
					break;
				}
			}
		}
		$clean = \preg_replace( '/[\x00-\x1F\x7F]+/', ' ', $reason );
		$clean = \trim( null === $clean ? '' : $clean );
		if ( '' === $clean ) {
			return $fallback;
		}
		if ( \strlen( $clean ) > 512 ) {
			return \substr( $clean, 0, 509 ) . '...';
		}
		return $clean;
	}

	/**
	 * Record a heartbeat reply's round-trip into the status snapshot and clear the stored
	 * failure. `last_error` is republished from SSE_In's connection rather than blanked,
	 * because the stream can be down while the command channel still answers, and the
	 * dashboard badge has to say so.
	 */
	private function record_heartbeat_reply(): void {
		if ( 0 === $this->last_heartbeat_sent ) {
			return;
		}
		$now                           = (int) Core::$now;
		$this->last_heartbeat_response = $now;
		$this->last_heartbeat_error    = null;
		$connection_error              = null !== $this->sse_in
			? $this->sse_in->connection()['last_error']
			: null;
		$this->write_status( [
			'last_heartbeat_response' => $now,
			'last_heartbeat_rtt'      => $now - $this->last_heartbeat_sent,
			'last_error'              => $connection_error,
		] );
	}

	/** Clear a prior success immediately and retain the spoke's safe failure reason. */
	private function record_heartbeat_failure( string $reason ): void {
		$this->last_heartbeat_response = 0;
		$this->last_heartbeat_error    = 'Client heartbeat failed: ' . $reason;
		$this->write_status( [
			'last_heartbeat_response' => null,
			'last_heartbeat_rtt'      => null,
			'last_error'              => $this->last_heartbeat_error,
		] );
	}

	/**
	 * Re-open the valve once the readers have drained below the low-water mark.
	 *
	 * @param Remote_Consumer_Node $child The reader that drained.
	 */
	public function refill( Remote_Consumer_Node $child ): void {
		if ( ! $this->pump_armed && $this->buffered_bytes() <= self::PUMP_ARM_BYTES ) {
			$this->sse_in?->arm();
			$this->pump_armed = true;
		}
	}

	/** Bytes buffered across every reader: one connection, one valve. */
	private function buffered_bytes(): int {
		$bytes = 0;
		foreach ( $this->reader_walk() as $child ) {
			$bytes += $child->buffered_bytes();
		}
		return $bytes;
	}

	/**
	 * The seal-grace rides a connect-time query parameter, so a CHANGE
	 * restreams, and the tick reconnects past what is buffered.
	 *
	 * @param bool $flag Whether the spoke should apply the seal-grace.
	 */
	public function set_multi_writer( bool $flag ): void {
		$changed = $flag !== $this->multi_writer();
		parent::set_multi_writer( $flag );
		if ( null !== $this->sse_in && $changed ) {
			$this->sse_in->set_multi_writer( $flag );
			$this->restream();
		}
	}

	/**
	 * Drop the live stream so the next request states the live set again;
	 * what it left buffered still drains. The tick queues the reconnect, so
	 * readers that pause in one tick share one.
	 */
	public function restream(): void {
		$this->sse_in?->disconnect();
	}

	/**
	 * Tear down the SSE_In patron and any connect queued against it, then the
	 * channel.
	 *
	 * A queued closure holds this node and its SSE_In; popped after teardown it
	 * reconnects a stream nothing owns any more and strands a cURL handle in
	 * the drain loop, holding a slot nothing can release.
	 */
	protected function drop_patrons(): void {
		$this->connect_queued = false;
		self::$connect_queue  = \array_values(
			\array_filter(
				self::$connect_queue,
				fn ( $queued ): bool => $queued[1] !== $this
			)
		);
		$this->sse_in = null;
		$this->retract_sibling( self::SSE_IN_KIND );
		parent::drop_patrons();
	}

	/** Drop every pending connect. Teardown only; a live graph purges per source. */
	public static function reset_connect_queue(): void {
		self::$connect_queue = [];
	}

	/** Pop the oldest queued connect for the drain timer; null when the queue is dry. */
	public static function shift_connect_queue(): ?callable {
		$queued = \array_shift( self::$connect_queue );
		return null === $queued ? null : $queued[0];
	}

	/** Composite stat delegation: report the children's tallies, not zeros. */
	public function counter(): int {
		return null !== $this->sse_in ? $this->sse_in->counter() : parent::counter();
	}

	/** SSE_In's tally: the source holds no socket of its own to read. */
	public function bytes_read(): int {
		return $this->sse_in?->bytes_read() ?? 0;
	}

	/** The largest SSE frame SSE_In has delivered. */
	public function largest_msg_sent(): int {
		return $this->sse_in?->largest_msg_sent() ?? 0;
	}

	/**
	 * Palette entry: the broker's form and verbs, in the I/O category.
	 *
	 * @api Dynamic entrypoint.
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			// The base hides itself; this subclass belongs in the palette.
			'category'    => 'I/O',
			'description' => 'SSE-pull broker: one connection to a spoke carrying several streams, a durable reader per `source:target` pair (Vault-resolved).',
		] );
	}
}
