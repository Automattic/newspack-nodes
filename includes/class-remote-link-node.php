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
 * Mirrors the JS RemoteLinkNode. Two subclasses specialize the base via protected
 * seams: connection (`restore_position`, `should_connect`) and the dashboard status
 * snapshot (`publish_status`, `record_heartbeat_sent`, `record_heartbeat_reply`
 * — all no-ops here, so only `Remote_Source_Node` publishes).
 * `Remote_Source_Node` adds the durable aggregation offsetlog + that status snapshot;
 * `Remote_IPC_Node` adds the worker-attach send + single-connection steal.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Remote_Link_Node extends Timer_Node {
	use Schema_Reflection;

	/** Slot-keepalive heartbeat cadence (seconds). */
	public const HEARTBEAT_INTERVAL = 10;

	// 10Hz poll; housekeeping self-latches. Protected: PLAY re-arms it.
	protected const TICK_INTERVAL_MS = 100;

	/** Patron HTTP_Out sibling (`<name>:http-out`); carries commands + the heartbeat. */
	protected ?HTTP_Out_Node $http_out = null;
	protected string $remote_partition = '';

	/** Patron SSE_In sibling (`<name>:sse-in`); null until first connect / Vault-resolved. */
	protected ?SSE_In_Node $sse_in = null;

	protected string $vault_id = '';

	protected int $last_heartbeat_sent = 0;

	/** Wall-second of the last housekeeping pass; fire() latches on it. */
	private int $last_housekeeping_s = 0;

	// Status snapshot is Remote_Source-only; the base exposes no-op seams.

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
	public function fill( array $message ): void {
		++$this->counter;
		$type = Core::int( $message[ Message::TYPE ] );
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
		// Housekeeping once per second; subclass fast paths ride every tick.
		$now_s = (int) Core::$now;
		if ( $now_s === $this->last_housekeeping_s ) {
			return;
		}
		$this->last_housekeeping_s = $now_s;
		// Only the link managing stream ticks; stolen Remote_IPC stays dormant.
		if ( ! $this->should_connect() ) {
			return;
		}
		$sse = $this->ensure_patrons();
		if ( null === $sse ) {
			return;
		}
		$sse->check_stale();
		$sse->maybe_connect();
		$this->maybe_send_heartbeat();
		$this->publish_status();
	}

	/**
	 * Default send: relay the message out through the patron HTTP_Out. Remote_IPC
	 * overrides this to wrap the reply-FROM + bundle a `connect_worker_input`.
	 *
	 * @param array<int, mixed> $message The 7-field positional message array.
	 */
	protected function send( array $message ): void {
		$this->ensure_patrons();
		$this->http_out?->fill( $message );
	}

	/** Whether a tick initiates/keeps the connection. Base always pulls. */
	protected function should_connect(): bool {
		return true;
	}

	// --- Heartbeat: minted as a workers.heartbeat command via HTTP_Out ---

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
		if ( $now - $this->last_heartbeat_sent < self::HEARTBEAT_INTERVAL ) {
			return;
		}
		$this->last_heartbeat_sent = $now;

		// ttl must outlive HEARTBEAT_INTERVAL — only client refreshes slot.
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

		$this->record_heartbeat_sent( $now );
	}

	// --- Dashboard status snapshot: Remote_Source-only (IPC writes dead) ---

	/** Per-tick connection-state snapshot (Remote_Source overrides; base no-op). */
	protected function publish_status(): void {}

	/** Record the heartbeat send-time into the status snapshot (Remote_Source overrides). */
	protected function record_heartbeat_sent( int $now ): void {}

	/** Record a heartbeat reply's round-trip into the status snapshot (Remote_Source overrides). */
	protected function record_heartbeat_reply(): void {}

	/**
	 * Open the inbound stream (children built lazily). Mirrors JS RemoteLink.connect.
	 *
	 * @api Dynamic entrypoint.
	 */
	public function connect(): void {
		$sse = $this->ensure_patrons();
		$sse?->maybe_connect();
	}

	// --- Patron lifecycle — SSE_In + HTTP_Out siblings ---

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

		$verify_ssl  = (bool) Config::value( 'vault_verify_ssl' );
		$require_ssl = (bool) Config::value( 'vault_require_ssl' );

		// Restore the cursor before connect so it seeds SSE_In.
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
		// Delivery seam: links forward downstream; Remote_Source buffers.
		$sse->on_message = function ( string $raw ): void {
			$this->deliver_downstream( $raw );
		};
		$sse->configure(
			$url,
			Core::as_string( $entry['auth_username'] ?? '' ),
			Core::as_string( $entry['auth_password'] ?? '' ),
			Core::as_string( $entry['token'] ?? '' ),
			"{$this->remote_partition}",
			$restored,
			$verify_ssl,
			$require_ssl
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

	/**
	 * Unpack one raw `msg` payload and forward it straight downstream. Honors an empty
	 * target (an attached worker reply carries its own
	 * TO — the TO=FROM breadcrumb — so don't overwrite it). A false FROM stamp (over
	 * MAX_FROM_SIZE) or an unparseable frame is dropped, never forwarded. Remote_Source
	 * overrides the delivery seam entirely (it buffers), so this is the channel path only.
	 */
	protected function deliver_downstream( string $raw ): void {
		try {
			$message = Message::unpacked( $raw );
		} catch ( \InvalidArgumentException $e ) {
			$this->print_less_often( 'dropping unparseable SSE frame' );
			return;
		}
		if ( \is_string( $this->target ) && '' !== $this->target ) {
			$message[ Message::TO ] = $this->target;
		}
		// Stamp SSE_In sibling's name, not link's, to keep reply breadcrumb.
		$stamp = null !== $this->sse_in ? $this->sse_in->name() : $this->name;
		if ( ! $this->stamp_message( $message, $stamp ) ) {
			$this->print_less_often( 'dropping stream message: FROM exceeded MAX_FROM_SIZE' );
			return;
		}
		++$this->counter;
		$this->sink?->fill( $message );
	}

	// --- Subclass seams ---

	/**
	 * Initial SSE_In cursor. Base seeds none; Remote_Source restores its offsetlog.
	 *
	 * @return array{segment?:int,offset?:int}
	 */
	protected function restore_position(): array {
		return [];
	}

	// Composite stat delegation: report the children's tallies, not zeros.
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
			'category'    => 'Hidden',
			'description'  => 'Full-duplex SSE+HTTP channel base: composes an SSE_In + HTTP_Out and drives the slot-keepalive heartbeat tick.',
			'arguments'    => [
				[ 'name' => 'vault_id',         'type' => 'vault_id', 'required' => true, 'description' => 'Which spoke to connect to — a Vault-registered server (URL + credentials).' ],
				[ 'name' => 'remote_partition', 'type' => 'string',    'required' => true, 'description' => 'The spoke partition to pull, e.g. firehose.p0.' ],
			],
			'commands'     => [],
			'requests'     => [],
			'accepts_fill' => false,
		];
	}
}
