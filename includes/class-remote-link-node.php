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
 * Mirrors the JS RemoteLinkNode. ONE subclass specializes the base in PHP —
 * `Remote_Source_Node`, which adds the durable aggregation offsetlog and the
 * dashboard status snapshot. The seams are shaped for two because the JS side
 * still has the second (`src/runtime/remote-ipc-node.js`); PHP's `Remote_IPC_Node`
 * was deleted, so `should_connect()` has a single implementation returning a
 * constant, and the status seams (`publish_status`, `record_heartbeat_sent`,
 * `record_heartbeat_reply`) are no-ops here that only `Remote_Source_Node` fills.
 *
 * No topology instantiates `Remote_Link` itself; it reaches the graph as that
 * subclass, or through its `@api` dynamic entrypoints (`connect`, `close`).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Remote_Link_Node extends Timer_Node {
	use Schema_Reflection;

	/** Slot-keepalive heartbeat cadence (seconds). */
	public const HEARTBEAT_INTERVAL = 15;

	// 10Hz poll; housekeeping self-latches. Protected: PLAY re-arms it.
	protected const TICK_INTERVAL_MS = 100;

	/** Patron HTTP_Out sibling (`<name>:http-out`); carries commands + the heartbeat. */
	protected ?HTTP_Out_Node $http_out = null;

	/** Black hole for reply-leg traffic the wire-inbound clause stamps. */
	protected ?Null_Node $null_sink = null;

	protected int $last_heartbeat_sent = 0;

	/**
	 * Pending connects, drained one per tick by Connect_Queue_Timer_Node.
	 * Process-wide, exactly as Tachikoma's `@SPAWN_QUEUE` is package-wide.
	 *
	 * Each entry is `[ closure, owning link ]` so a removed link's pending
	 * connect can be purged rather than resurrect it.
	 *
	 * @var list<array{0: callable, 1: self|null}>
	 */
	private static array $connect_queue = [];

	/** Whether this link already has a connect waiting in that queue. */
	private bool $connect_queued = false;

	/** Wall-second the lease first existed; both cadences count from it. */
	protected int $link_epoch = 0;

	/** Wall-second of the last session request; its own retry clock. */
	protected int $last_session_request = 0;


	protected string $remote_partition = '';

	/** Patron SSE_In sibling (`<name>:sse-in`); null until first connect / Vault-resolved. */
	protected ?SSE_In_Node $sse_in = null;

	protected string $vault_id = '';

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
	 * @param list<string>|null $args
	 * @return list<string>
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		if ( [] !== $args ) {
			$this->set_timer( self::TICK_INTERVAL_MS );
			// @longform Subscribe where the vault config is captured, so
			// capture and re-read live together. Null outside a worker (REPL
			// or request scope): no fleet, so nothing detects a change.
			//
			// @longform CLOSURE, not Node-name dispatch. `fill()` relays
			// anything it does not recognize OUT to a remote spoke, so a name
			// registration would route control through the one entry point
			// whose fall-through is a third party, and every message would then
			// have to be discriminated from control. A closure builds no
			// message at all: provenance is the callback identity, one closure
			// per (emitter, event), so there is nothing to verify. Only an
			// explicit `return false` unregisters (`notify()` compares
			// identity), so a void handler keeps listening.
			Core::node( Node_Names::FLEET )?->register(
				'RELOAD',
				$this->name,
				function (): void {
					$this->reload();
				}
			);
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
			$failure = self::heartbeat_failure( $message );
			if ( null === $failure ) {
				$this->record_heartbeat_reply();
			} else {
				$this->stderr( 'ERROR: client heartbeat failed - ' . $failure );
				$this->record_heartbeat_failure( $failure );
			}
			return;
		}
		$this->send( $message );
	}

	/**
	 * Per-tick housekeeping (Timer_Node::fire_cb calls this): drive the passive
	 * SSE_In, persist the cursor, and keep the slot alive. Idempotent and cheap.
	 * `should_connect()` gates whether a tick initiates/keeps the connection.
	 */
	public function fire(): void {
		// Housekeeping once per second; subclass fast paths ride every tick.
		$now_s = (int) Core::$now;
		if ( $now_s === $this->last_housekeeping_s ) {
			return;
		}
		$this->last_housekeeping_s = $now_s;
		if ( ! $this->should_connect() ) {
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
	 * The credentials this node reads live in its patrons, resolved once from
	 * the Vault. Dropping them is HALF the re-read: the Vault memoizes its
	 * entries for the life of the process, so the other half is `Vault::reset()`
	 * on `Config::RESET_ACTION`, which the fleet fires before it announces the
	 * RELOAD. Without that, the next tick rebuilds both patrons from the same
	 * cached entry and a rotated credential reconnects a healthy stream with the
	 * old password. The cursor is restored as on any reconnect.
	 */
	public function reload(): void {
		$this->drop_patrons();
	}

	/**
	 * Default send: relay the message out through the patron HTTP_Out.
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
	 * (FROM=<this node>, TO=workers, args `<slot> <owner>`) and fill it into the
	 * patron HTTP_Out. Skips until SSE_In reports the complete lease. The slot
	 * pool keys on (user, ip, slot, owner) — no partition.
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
		if ( 0 === $this->link_epoch ) {
			$this->link_epoch = $now;
		}
		// Silence is not a refusal — HTTP_Out drops the session on a 401.
		$spoke = $this->http_out->vault_id();
		if ( '' === $spoke ) {
			return;
		}
		if ( ! Command_Auth::has_session( $spoke ) ) {
			$this->maybe_request_session( $this->http_out, $now );
			return;
		}
		if ( $now - $this->last_heartbeat_sent < self::HEARTBEAT_INTERVAL ) {
			return;
		}
		$this->last_heartbeat_sent = $now;

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::FROM ]  = $this->name;
		$message[ Message::TO ]    = 'workers';
		$message[ Message::VALUE ] = [
			'name'      => 'heartbeat',
			'arguments' => [ (string) $slot, (string) $owner ],
		];
		Command_Auth::sign_for( $spoke, $message );
		++$this->counter;
		$this->http_out->fill( $message );

		$this->record_heartbeat_sent( $now );
	}

	/**
	 * Queue this link's connect instead of running it inline, and make sure the
	 * shared drain timer is up.
	 *
	 * @longform Tachikoma `Job.pm`: a spawn pushes a closure onto `@SPAWN_QUEUE`
	 * and mounts `_spawn_timer` if absent. Same shape, same reason — an
	 * aggregator brings every Remote_Source up in one tick, and N simultaneous
	 * SSE connects are what the spoke answers with 429. The queued flag is what
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
				$sse->maybe_connect();
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
	 * Pop the next queued connect, or null when the queue is dry.
	 *
	 * @api Called by Connect_Queue_Timer_Node::fire().
	 */
	/**
	 * Append a connect for the drain timer to run. The owner may be null for a
	 * queue entry with no link to purge it (tests).
	 *
	 * @param callable   $connect The queued connect.
	 * @param self|null  $owner   Link whose remove_node() should purge it.
	 */
	public static function push_connect_queue( callable $connect, ?self $owner ): void {
		self::$connect_queue[] = [ $connect, $owner ];
	}

	private function maybe_request_session( HTTP_Out_Node $http_out, int $now ): void {
		// intdiv, so a 1s housekeeping tick can actually land on the boundary.
		$offset = \intdiv( self::HEARTBEAT_INTERVAL, 2 );
		if ( $now - $this->link_epoch < $offset ) {
			return;
		}
		// @longform Each link owns one second of the cadence, from its name.
		// The connect queue only spreads FIRST boot; a spoke restart or key
		// rotation drops every session at once, leaving every link past its
		// retry gate and asking together. A phase on the absolute clock
		// spreads boot and mass re-auth alike, and survives both because no
		// session loss resets it.
		if ( $now % self::HEARTBEAT_INTERVAL !== $this->session_phase() ) {
			return;
		}
		if ( $this->last_session_request > 0
				&& $now - $this->last_session_request < self::HEARTBEAT_INTERVAL ) {
			return;
		}
		$this->last_session_request = $now;
		$http_out->ensure_session();
	}

	/**
	 * Ask for a command session, on a clock of its own offset half a cadence
	 * from the heartbeat grid.
	 *
	 * @longform Every Remote_Source in an aggregator boots in the same tick, so
	 * anything sent "immediately" is sent N times at once — which is what the
	 * spoke answers with 429. Auth lands between heartbeats, never with one, and
	 * asking never moves the heartbeat clock: that coupling is what pushed the
	 * first heartbeat a full extra cadence out.
	 *
	 * @param HTTP_Out_Node $http_out The patron egress that owns the session.
	 * @param int           $now      Current wall-second.
	 */
	/** This link's second within the cadence. Stable, so it survives re-auth. */
	private function session_phase(): int {
		return \crc32( $this->name ) % self::HEARTBEAT_INTERVAL;
	}

	// --- Dashboard status snapshot: Remote_Source-only (IPC writes dead) ---

	/** Per-tick connection-state snapshot (Remote_Source overrides; base no-op). */
	protected function publish_status(): void {}

	/** Record the heartbeat send-time into the status snapshot (Remote_Source overrides). */
	protected function record_heartbeat_sent( int $now ): void {}

	/** Record a heartbeat reply's round-trip into the status snapshot (Remote_Source overrides). */
	protected function record_heartbeat_reply(): void {}

	/** Clear successful heartbeat status and retain a failure (Remote_Source overrides). */
	protected function record_heartbeat_failure( string $reason ): void {}

	/**
	 * Return null only for an explicit successful heartbeat response.
	 *
	 * @param array<int,mixed> $message Command response/error envelope.
	 */
	private static function heartbeat_failure( array $message ): ?string {
		$type  = Core::int( $message[ Message::TYPE ] );
		$value = $message[ Message::VALUE ];
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

	/** Extract only a bounded single-line reason, never a raw response body. */
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

		// One owner for the spoke TLS posture; three transports read it.
		$verify_ssl  = HTTP_Out_Node::verify_ssl();
		$require_ssl = HTTP_Out_Node::require_ssl();

		// Restore the cursor before connect so it seeds SSE_In.
		$restored = $this->restore_position();

		$sse = new SSE_In_Node();
		$sse->name( "{$this->name}:sse-in" );
		$sse->patron( $this );
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
		$http->arguments( [ $this->vault_id ] );
		$http->sink( $this->sink );
		// Arms HTTP_Out's wire-inbound clause; a Null, since the link relays.
		$null = new Null_Node();
		$null->name( "{$this->name}:null" );
		$null->patron( $this );
		$this->null_sink = $null;
		$http->target( $null->name() );
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

	/**
	 * Teardown: tear down both patrons, then remove self.
	 *
	 * @api Dynamic entrypoint.
	 */
	public function remove_node(): void {
		// @longform Registrations are by NAME: a stale one outlives the node
		// and gets walked on the next notify (Timer_Node drops TIMER alike).
		Core::node( Node_Names::FLEET )?->unregister( 'RELOAD', $this->name );
		$this->drop_patrons();
		parent::remove_node();
	}

	/**
	 * Tear down the three patron siblings and any connect queued against them.
	 *
	 * @longform A queued closure holds this node and its SSE_In; popped after
	 * teardown it reconnects a stream nothing owns any more and strands a cURL
	 * handle in the drain loop, holding a slot nothing can release.
	 */
	private function drop_patrons(): void {
		$this->connect_queued = false;
		self::$connect_queue  = \array_values(
			\array_filter(
				self::$connect_queue,
				fn ( $queued ): bool => $queued[1] !== $this
			)
		);
		$this->sse_in?->remove_node();
		$this->sse_in = null;
		$this->http_out?->remove_node();
		$this->http_out = null;
		$this->null_sink?->remove_node();
		$this->null_sink = null;
	}

	/** Drop every pending connect. Teardown only; a live graph purges per link. */
	public static function reset_connect_queue(): void {
		self::$connect_queue = [];
	}

	public static function shift_connect_queue(): ?callable {
		$queued = \array_shift( self::$connect_queue );
		return null === $queued ? null : $queued[0];
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

	public function connect_node( string $target ): void {
		$this->target = $target;
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
