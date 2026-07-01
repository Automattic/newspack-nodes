<?php
/**
 * Remote_Link: the full-duplex "be the browser" SSE+HTTP channel, as one node.
 *
 * One Remote_Link patrons two hidden siblings: an `SSE_In_Node` (`<name>:sse-in`)
 * that pulls one remote partition, and an `HTTP_Out_Node` (`<name>:http-out`)
 * that carries outbound commands + the slot-keepalive heartbeat. A recurring tick
 * drives the passive SSE_In (`check_stale` + `maybe_connect`), mints a
 * `workers.heartbeat` every ~HEARTBEAT_INTERVAL (filled into the patron HTTP_Out,
 * whose reply self-routes back into `fill()` for RTT bookkeeping)
 *
 * Credentials + URL come from the Vault entry resolved by `<vault-id>`; a missing
 * entry leaves the node disconnected (no mis-configured patrons created).
 *
 * Mirrors the JS RemoteLinkNode. Two subclasses specialize the base via three
 * protected seams (`restore_position`, `persist_cursor`, `should_connect`).
 * `Remote_Source_Node` adds the durable aggregation offsetlog;
 * `Remote_IPC_Node` adds the worker-pivot send + single-connection steal.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Remote_Link_Node extends Timer_Node {
	use Schema_Reflection;

	// Protected so Remote_Source's time-travel PLAY can re-arm the same tick cadence.
	protected const TICK_INTERVAL_MS = 1000;

	/** Slot-keepalive heartbeat cadence (seconds). */
	public const HEARTBEAT_INTERVAL = 10;

	/** Memcache TTL for the status snapshot (seconds). */
	public const STATUS_TTL = 300;

	protected string $vault_id         = '';
	protected string $remote_partition = '';

	/** Patron SSE_In sibling (`<name>:sse-in`); null until first connect / Vault-resolved. */
	protected ?SSE_In_Node $sse_in = null;

	/** Patron HTTP_Out sibling (`<name>:http-out`); carries commands + the heartbeat. */
	protected ?HTTP_Out_Node $http_out = null;

	private int $last_heartbeat          = 0;
	private int $last_heartbeat_sent     = 0;
	private int $last_heartbeat_response = 0;

	/** Tachikoma-parity: no-arg ctor. Positional config arrives via arguments(); no I/O here (ADR-5). */
	public function __construct() {
		parent::__construct();
	}

	/**
	 * Parse `<vault-id> <remote_partition>` and arm the recurring tick.
	 *
	 * @api Dynamic entrypoint.
	 * @param string|null $args
	 * @return string
	 */
	public function arguments( ?string $args = null ): string {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		if ( '' !== $args ) {
			$this->set_timer( self::TICK_INTERVAL_MS );
		}
		return $args;
	}

	/**
	 * Inbound message. A heartbeat reply (TM_COMMAND|TM_RESPONSE / |TM_ERROR) routed
	 * back from the spoke records RTT; anything else is a command to send().
	 *
	 * @api Dynamic entrypoint.
	 * @param array<int, mixed> $message The 7-field positional message array.
	 */
	public function fill( array &$message ): void {
		++$this->counter;
		$type = \is_int( $message[ Message::TYPE ] ) ? $message[ Message::TYPE ] : 0;
		if ( ( Message::TM_COMMAND | Message::TM_RESPONSE ) === $type
				|| ( Message::TM_COMMAND | Message::TM_ERROR ) === $type ) {
			$this->record_heartbeat_reply();
			return;
		}
		$this->send( $message );
	}

	/**
	 * Per-tick housekeeping (Timer_Node::fire_cb calls this): drive the passive
	 * SSE_In, persist the cursor, and keep the slot alive. Idempotent and cheap.
	 * `should_connect()` gates whether a tick initiates/keeps the connection —
	 * Remote_Source always pulls; Remote_IPC only while it holds the live stream.
	 */
	public function fire(): void {
		// Only the link actively managing the stream ticks (a stolen Remote_IPC is
		// dormant — no stale slot keepalive, no status churn). Remote_Source always manages.
		if ( ! $this->should_connect() ) {
			return;
		}
		$sse = $this->ensure_patrons();
		if ( null === $sse ) {
			return;
		}
		$sse->check_stale();
		$sse->maybe_connect();
		$this->persist_cursor();
		$this->maybe_send_heartbeat();
		$this->publish_status();
	}

	/** Record a heartbeat reply's round-trip into the status snapshot. */
	private function record_heartbeat_reply(): void {
		if ( 0 === $this->last_heartbeat_sent ) {
			return;
		}
		$now                           = (int) Core::$now;
		$rtt                           = $this->last_heartbeat_sent > 0 ? ( $now - $this->last_heartbeat_sent ) : 0;
		$this->last_heartbeat_response = $now;
		$this->write_status( [
			'last_heartbeat_response' => $now,
			'last_heartbeat_rtt'      => $rtt,
		] );
	}

	/**
	 * Default send: relay the message out through the patron HTTP_Out. Remote_IPC
	 * overrides this to wrap the reply-FROM pivot + bundle a `connect_worker_input`.
	 *
	 * @param array<int, mixed> $message The 7-field positional message array.
	 */
	protected function send( array &$message ): void {
		$this->ensure_patrons();
		$this->http_out?->fill( $message );
	}

	/** Whether a tick initiates/keeps the connection. Base always pulls. */
	protected function should_connect(): bool {
		return true;
	}

	/** Per-tick cursor persistence. Base no-op; Remote_Source commits its offsetlog. */
	protected function persist_cursor(): void {}

	// =========================================================================
	// Heartbeat — minted as a workers.heartbeat command, routed through HTTP_Out.
	// =========================================================================

	/**
	 * Every ~HEARTBEAT_INTERVAL seconds, mint a `workers.heartbeat` TM_COMMAND
	 * (FROM=<this node>, TO=workers, args `<slot> <ttl>`) and fill it into the
	 * patron HTTP_Out. Skips until SSE_In reports a slot. The slot pool keys on
	 * (user, ip, slot) — no partition.
	 */
	private function maybe_send_heartbeat(): void {
		if ( null === $this->sse_in || null === $this->http_out ) {
			return;
		}
		$slot = $this->sse_in->slot();
		if ( null === $slot || $slot < 0 ) {
			return;
		}
		$now = (int) Core::$now;
		if ( $now - $this->last_heartbeat < self::HEARTBEAT_INTERVAL ) {
			return;
		}
		$this->last_heartbeat      = $now;
		$this->last_heartbeat_sent = $now;

		// ttl must outlive HEARTBEAT_INTERVAL — only the client refreshes the slot.
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::FROM ]  = $this->name;
		$message[ Message::TO ]    = 'workers';
		$message[ Message::VALUE ] = [
			'name'      => 'heartbeat',
			'arguments' => $slot . ' ' . ( self::HEARTBEAT_INTERVAL * 3 ),
		];
		++$this->counter;
		$this->http_out->fill( $message );

		$this->write_status( [ 'last_heartbeat_sent' => $now ] );
	}

	/**
	 * Publish the connection-state snapshot from SSE_In::connection(). Ages out the
	 * heartbeat round-trip so the dashboard's Status badge can't latch 'success' on a
	 * stale timestamp: the response is "live" only while connected AND seen within the
	 * node's HEARTBEAT_INTERVAL*4 window (the slot-TTL span); otherwise it's nulled
	 * (mirrors the old clear-on-disconnect). Live values ride the write_status merge.
	 */
	private function publish_status(): void {
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

	// =========================================================================
	// Status snapshot — per-node memcache key (node name + remote_partition).
	// =========================================================================

	// Keyed by NODE NAME first so two spokes pulling the same remote_partition
	// (e.g. firehose.p0) don't collide; Aggregator_CI reads the identical key.
	private function status_key(): string {
		return "np:remote:{$this->name}:{$this->remote_partition}";
	}

	/**
	 * Open the inbound stream (children built lazily). Mirrors JS RemoteLink.connect.
	 *
	 * @api Dynamic entrypoint.
	 */
	public function connect(): void {
		$sse = $this->ensure_patrons();
		$sse?->maybe_connect();
	}

	// =========================================================================
	// Patron lifecycle — SSE_In + HTTP_Out siblings.
	// =========================================================================

	/**
	 * Create + register the two hidden patron siblings on first call, configuring
	 * SSE_In from the Vault entry resolved by `<vault-id>`. A missing Vault entry
	 * leaves the node disconnected (no mis-configured patrons) and returns null.
	 *
	 * @return SSE_In_Node|null The SSE_In patron once configured, else null.
	 */
	protected function ensure_patrons(): ?SSE_In_Node {
		if ( null !== $this->sse_in ) {
			return $this->sse_in;
		}
		if ( '' === $this->name ) {
			return null;
		}

		$entry = Vault::get_instance()->get( $this->vault_id );
		if ( null === $entry ) {
			$this->print_less_often( "no Vault entry; staying disconnected" );
			return null;
		}
		$url = \rtrim( Core::as_string( $entry['url'] ?? '' ), '/' );
		if ( '' === $url ) {
			$this->print_less_often( "Vault entry has no url; staying disconnected" );
			return null;
		}

		$cfg           = Config::load_config();
		$verify_ssl    = ! isset( $cfg['vault_verify_ssl'] ) || (bool) $cfg['vault_verify_ssl'];
		$require_https = ! empty( $cfg['vault_require_https'] );

		// Restore the cursor before connect so it seeds SSE_In (Remote_Source's offsetlog).
		$restored = $this->restore_position();

		$sse = new SSE_In_Node();
		$sse->name( "{$this->name}:sse-in" );
		$sse->patron( $this );
		// SSE_In forwards parsed output to THIS node's own downstream wiring.
		if ( null !== $this->sink ) {
			$sse->sink( $this->sink );
		}
		if ( \is_string( $this->target ) && '' !== $this->target ) {
			$sse->target( $this->target );
		}
		$sse->configure(
			$url,
			Core::as_string( $entry['auth_username'] ?? '' ),
			Core::as_string( $entry['auth_password'] ?? '' ),
			Core::as_string( $entry['token'] ?? '' ),
			"{$this->remote_partition}",
			$restored,
			$this->vault_id,
			$verify_ssl,
			$require_https
		);
		$this->sse_in = $sse;

		$http = new HTTP_Out_Node();
		$http->name( "{$this->name}:http-out" );
		$http->patron( $this );
		$http->arguments( $this->vault_id );
		$http->sink( $this->sink );
		$this->http_out = $http;

		return $sse;
	}

	// =========================================================================
	// Subclass seams.
	// =========================================================================

	/**
	 * Initial SSE_In cursor. Base seeds none; Remote_Source restores its offsetlog.
	 *
	 * @return array{segment_id?:int,offset?:int}
	 */
	protected function restore_position(): array {
		return [];
	}

	// Composite-node stat delegation (like Topic→Partition): this link does no
	// wire I/O itself — its SSE_In child reads the stream and its HTTP_Out child
	// POSTs — so report THEIR counters/byte tallies, not the link's own zeros.
	public function counter(): int {
		return null !== $this->sse_in ? $this->sse_in->counter() : parent::counter();
	}

	public function bytes_read(): int {
		return $this->sse_in?->bytes_read() ?? 0;
	}

	public function bytes_written(): int {
		return $this->http_out?->bytes_written() ?? 0;
	}

	public function largest_msg_sent(): int {
		return $this->sse_in?->largest_msg_sent() ?? 0;
	}

	/**
	 * Close the inbound stream. Mirrors JS RemoteLink.close.
	 *
	 * @api Dynamic entrypoint.
	 */
	public function close(): void {
		$this->sse_in?->disconnect();
	}

	/** True while the SSE_In holds a live stream (a steady poll doesn't reconnect). */
	protected function is_streaming(): bool {
		return null !== $this->sse_in && $this->sse_in->connection()['connected'];
	}

	public function connect_node( string $target ): void {
		$this->target = $target;
		$this->sse_in?->target( $target );
	}

	/**
	 * Teardown: tear down both patrons, then remove self.
	 *
	 * @api Dynamic entrypoint.
	 */
	public function remove_node(): void {
		$this->sse_in?->remove_node();
		$this->sse_in = null;
		$this->http_out?->remove_node();
		$this->http_out = null;
		parent::remove_node();
	}

	/**
	 * @api Dynamic entrypoint.
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'I/O',
			'description'  => 'Full-duplex SSE+HTTP channel base: composes an SSE_In + HTTP_Out and drives the heartbeat/status tick.',
			'arguments'    => [
				[ 'name' => 'vault_id',         'type' => 'string', 'required' => true ],
				[ 'name' => 'remote_partition', 'type' => 'string', 'required' => true ],
			],
			'commands'     => [],
			'requests'     => [],
			'accepts_fill' => false,
		];
	}
}
