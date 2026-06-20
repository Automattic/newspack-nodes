<?php
/**
 * Remote_Source: a self-sufficient, topology-visible SSE-pull aggregation node.
 *
 * One Remote_Source patrons two hidden siblings: a `SSE_In_Node` (`<name>:sse-in`)
 * that pulls one spoke topic/partition, and an `HTTP_Out_Node` (`<name>:remote`)
 * that carries the slot-keepalive heartbeat. Remote_Source owns the durable
 * offsetlog (`<offsets_dir>/<name>.p<partition>`, keyed by NODE NAME) and a
 * recurring tick that drives the passive SSE_In (`check_stale` + `maybe_connect`),
 * commits the cursor every ~5s, and mints a `workers.heartbeat` command every ~15s
 * (filled into the patron HTTP_Out, not POSTed directly). The heartbeat reply
 * self-routes back into `fill()` for RTT bookkeeping. A generic per-node status
 * snapshot is published to memcache under `np:remote:<name>:p<partition>`.
 *
 * Credentials + URL come from the Vault entry resolved by `<vault-id>`; a missing
 * entry leaves the node disconnected (no mis-configured patrons created).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Remote_Source_Node extends Timer_Node {
	use Schema_Reflection;

	private const TICK_INTERVAL_MS = 1000;

	/** Offsetlog commit cadence (seconds). */
	private const COMMIT_INTERVAL = 5;

	/** Slot-keepalive heartbeat cadence (seconds). */
	public const HEARTBEAT_INTERVAL = 15;

	/** Memcache TTL for the status snapshot (seconds). */
	public const STATUS_TTL = 300;

	protected string $vault_id     = '';
	protected string $remote_topic = '';
	protected int    $partition    = 0;

	/** Patron SSE_In sibling (`<name>:sse-in`); null until first tick / Vault-resolved. */
	private ?SSE_In_Node $sse_in = null;

	/** Patron HTTP_Out sibling (`<name>:remote`); carries the heartbeat. */
	private ?HTTP_Out_Node $http_out = null;

	/** Durable per-node offsetlog (`<offsets_dir>/<name>.p<partition>`). */
	private ?Partition_Node $offsetlog = null;

	private float $last_commit_time = 0.0;
	private int   $last_heartbeat   = 0;
	private int   $last_heartbeat_sent = 0;

	/** Tachikoma-parity: no-arg ctor. Positional config arrives via arguments(); no I/O here (ADR-5). */
	public function __construct() {
		parent::__construct();
	}

	/**
	 * Parse `<vault-id> <remote_topic> <partition>` and arm the recurring tick.
	 * A Timer_Node subclass does not self-schedule, so we explicitly set_timer().
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
		$this->partition = \max( 0, $this->partition );
		if ( '' !== $args ) {
			$this->set_timer( self::TICK_INTERVAL_MS );
		}
		return $args;
	}

	/**
	 * @api Dynamic entrypoint.
	 * @param array<int, mixed> $message The 7-field positional message array.
	 */
	public function fill( array &$message ): void {
		++$this->counter;
		$type = \is_int( $message[ Message::TYPE ] ) ? $message[ Message::TYPE ] : 0;
		if ( ( Message::TM_COMMAND | Message::TM_RESPONSE ) === $type	
				|| ( Message::TM_COMMAND | Message::TM_ERROR ) === $type ) {	
			if ( 0 === $this->last_heartbeat_sent ) {
				return;
			}
			$now = (int) Core::$now;
			$rtt = $this->last_heartbeat_sent > 0 ? ( $now - $this->last_heartbeat_sent ) : 0;
			$this->write_status( [
				'last_heartbeat_response' => $now,
				'last_heartbeat_rtt'      => $rtt,
			] );
			return;
		}
		$this->ensure_patrons();
		if ( null !== $this->http_out ) {
			$this->http_out->fill( $message );
		}
	}

	/**
	 * Per-tick housekeeping (Timer_Node::fire_cb calls this): drive the passive
	 * SSE_In, persist the cursor, and keep the slot alive. Idempotent and cheap.
	 */
	public function fire(): void {
		$sse = $this->ensure_patrons();
		if ( null === $sse ) {
			return;
		}
		$sse->check_stale();
		$sse->maybe_connect();
		$this->maybe_commit_offsetlog();
		$this->maybe_send_heartbeat();
		$this->publish_status();
	}

	/**
	 * Merge $data into the status snapshot under the generic per-node key.
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
	// Status snapshot — generic per-node memcache key.
	// =========================================================================

	private function status_key(): string {
		return "np:remote:{$this->name}:p{$this->partition}";
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
	private function ensure_patrons(): ?SSE_In_Node {
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

		// Offsetlog first so the restored cursor seeds SSE_In before its connect.
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
			"{$this->remote_topic}.p{$this->partition}",
			$restored,
			$this->vault_id,
			$verify_ssl,
			$require_https
		);
		Core::register_node( "{$this->name}:sse-in", $sse );
		$this->sse_in = $sse;

		$http = new HTTP_Out_Node();
		$http->name( "{$this->name}:remote" );
		$http->patron( $this );
		$http->arguments( $this->vault_id );
		$http->sink( $this->sink );
		Core::register_node( "{$this->name}:remote", $http );
		$this->http_out = $http;

		return $sse;
	}

	/**
	 * Read the latest committed `{seg,off}` line from the offsetlog into a position
	 * array suitable for SSE_In::configure(). Empty on a fresh offsetlog.
	 *
	 * @return array{segment_id?:int,offset?:int}
	 */
	private function restore_position(): array {
		$offsetlog = $this->ensure_offsetlog();
		if ( null === $offsetlog ) {
			return [];
		}
		$segments = $offsetlog->get_segments( true );
		if ( empty( $segments ) ) {
			return [];
		}
		$last    = \end( $segments );
		$content = $offsetlog->read_at( $last['id'], 0, $last['size'] );
		if ( '' === $content && \count( $segments ) > 1 ) {
			$prev    = $segments[ \count( $segments ) - 2 ];
			$content = $offsetlog->read_at( $prev['id'], 0, $prev['size'] );
		}
		if ( '' === $content ) {
			return [];
		}
		$lines = \explode( "\n", \rtrim( $content, "\n" ) );
		try {
			$message = Message::unpacked( \end( $lines ) );
		} catch ( \InvalidArgumentException $e ) {
			$this->print_less_often( "ignoring unparseable offsetlog entry: {$e->getMessage()}" );
			return [];
		}
		$value = $message[ Message::VALUE ];
		if ( ! \is_array( $value ) ) {
			return [];
		}
		$seg = $value['seg'] ?? 0;
		$off = $value['off'] ?? 0;
		return [
			'segment_id' => \is_scalar( $seg ) ? (int) $seg : 0,
			'offset'     => \is_scalar( $off ) ? (int) $off : 0,
		];
	}

	// =========================================================================
	// Durable offsetlog — per-node, keyed by NODE NAME.
	// =========================================================================

	/** Ensure the per-node offsetlog Partition exists + is registered. Idempotent. */
	private function ensure_offsetlog(): ?Partition_Node {
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
		$dir = "{$offsets_dir}/{$this->name}.p{$this->partition}";
		if ( ! \is_dir( $dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $dir, 0755, true );
		}
		$offsetlog = new Partition_Node();
		$offsetlog->name( "{$this->name}:offsetlog" );
		$offsetlog->patron( $this );
		$ci = Core::node( Node_Names::COMMAND_INTERPRETER );
		if ( null === $offsetlog->sink() && null !== $ci ) {
			$offsetlog->sink( $ci );
		}
		$offsetlog->arguments( $dir );
		$this->offsetlog = $offsetlog;
		return $offsetlog;
	}

	/** Write the SSE_In cursor to the offsetlog every ~COMMIT_INTERVAL seconds. */
	private function maybe_commit_offsetlog(): void {
		$now = Core::$now ?: \microtime( true );
		if ( $this->last_commit_time > 0.0 && ( $now - $this->last_commit_time ) < self::COMMIT_INTERVAL ) {
			return;
		}
		$this->last_commit_time = $now;
		$this->commit_offsetlog();
	}

	/** Write a single `{seg,off,_ts}` JSONL line covering this node's cursor. */
	private function commit_offsetlog(): void {
		if ( null === $this->sse_in ) {
			return;
		}
		$offsetlog = $this->ensure_offsetlog();
		if ( null === $offsetlog ) {
			return;
		}
		$pos                           = $this->sse_in->position();
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_STRUCT;
		$message[ Message::TIMESTAMP ] = Core::$now;
		$message[ Message::VALUE ]     = [
			'seg' => $pos['segment_id'],
			'off' => $pos['offset'],
			'_ts' => (int) Core::$now,
		];
		$offsetlog->fill( $message );
		$offsetlog->flush();
	}

	// =========================================================================
	// Heartbeat — minted as a workers.heartbeat command, routed through HTTP_Out.
	// =========================================================================

	/**
	 * Every ~HEARTBEAT_INTERVAL seconds, mint a `workers.heartbeat` TM_COMMAND
	 * (FROM=<this node>, TO=workers, args `<slot> <ttl> <partition>`) and fill it
	 * into the patron HTTP_Out. Skips until SSE_In reports a slot.
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
			'arguments' => $slot . ' ' . ( self::HEARTBEAT_INTERVAL * 4 ) . ' ' . $this->partition,
		];
		++$this->counter;
		$this->http_out->fill( $message );

		$this->write_status( [ 'last_heartbeat_sent' => $now ] );
	}

	/** Publish the connection-state snapshot from SSE_In::connection(). */
	private function publish_status(): void {
		$conn = null !== $this->sse_in
			? $this->sse_in->connection()
			: [ 'connected' => false, 'last_http_code' => null, 'last_error' => null, 'current_backoff' => SSE_In_Node::INITIAL_BACKOFF ];
		$this->write_status( [
			'last_connection_attempt' => (int) Core::$now,
			'connected'               => $conn['connected'],
			'last_http_code'          => $conn['last_http_code'],
			'last_error'              => $conn['last_error'],
			'current_backoff'         => $conn['current_backoff'],
		] );
	}

	/** Set target. Tee overrides to append to its fan-out array. */
	public function connect_node( string $target ): void {
		$this->target = $target;
		$this->sse_in?->target( $target );
	}

	/**
	 * Teardown: tear down both patrons + the offsetlog, then remove self.
	 *
	 * @api Dynamic entrypoint.
	 */
	public function remove_node(): void {
		$this->sse_in?->remove_node();
		$this->sse_in = null;
		$this->http_out?->remove_node();
		$this->http_out = null;
		$this->offsetlog?->remove_node();
		$this->offsetlog = null;
		parent::remove_node();
	}

	/**
	 * @api Dynamic entrypoint.
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'     => 'I/O',
			'description'  => 'Self-sufficient SSE-pull aggregation source for one spoke topic/partition (Vault-resolved).',
			'arguments'    => [
				[ 'name' => 'vault_id',     'type' => 'string', 'required' => true ],
				[ 'name' => 'remote_topic', 'type' => 'string' ],
				[ 'name' => 'partition',    'type' => 'int' ],
			],
			'commands'     => [],
			'requests'     => [],
			'accepts_fill' => true,
		];
	}
}
