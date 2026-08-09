<?php
/**
 * Table
 *
 * The keyed store (Tachikoma Table vocabulary), backed by memcache — the
 * documented divergence: Tachikoma's Table holds windowed in-memory buckets,
 * but this substrate's dashboards/REST/CLI have no efficient way to query a
 * live worker, so values land in memcache where ANY process reads them via
 * `Table_Node::lookup()`. TTL replaces bucket windows.
 *
 * fill() stores KEY→VALUE write-through (the message passes on), so the
 * table composes mid-graph: `… → Table → …`. Keyless messages pass through
 * unstored.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Table node.
 */
class Table_Node extends Node {
	use Schema_Reflection;

	public const KEY_PREFIX = 'nodes-table:';

	private string $namespace = '';
	private int $ttl          = 0;

	/** Tachikoma-parity: no-arg ctor. Wires the sibling :config interpreter that serves `get` / `rm`. */
	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	/**
	 * `<namespace> [ttl]` — namespace is required (it scopes lookup());
	 * ttl in seconds, 0 (default) = no expiry.
	 *
	 * @param list<string>|null $args
	 * @return list<string>
	 * @throws \InvalidArgumentException Without a namespace argument.
	 * @throws \LogicException With no backing store (memcached or APCu).
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->arguments = $args;
		$namespace       = Core::as_string( $args[0] ?? '', '' );
		if ( '' === $namespace ) {
			throw new \InvalidArgumentException( 'Table requires a namespace argument' );
		}
		if ( null === Cache_Backend::shared_first() ) {
			throw new \LogicException( 'Table requires memcached or APCu' );
		}
		$this->namespace = $namespace;
		$this->ttl       = \max( 0, Core::num_int( $args[1] ?? 0, 0 ) );
		return $args;
	}

	public function fill( array $message ): void {
		if ( Core::num_int( $message[ Message::TYPE ] ) & Message::TM_REQUEST ) {
			$this->handle_request( $message );
			return;
		}
		$key     = Core::as_string( $message[ Message::KEY ], '' );
		$value   = $message[ Message::VALUE ];
		$backend = Cache_Backend::shared_first();
		if ( '' !== $key && null !== $backend ) {
			// Empty deletes (Table.pm:313); a bare terminator counts as empty.
			$empty = null === $value || [] === $value
				|| ( \is_string( $value ) && '' === \rtrim( $value, "\r\n" ) );
			if ( $empty ) {
				$backend->delete( self::KEY_PREFIX . "{$this->namespace}:{$key}" );
			} else {
				$backend->set( self::KEY_PREFIX . "{$this->namespace}:{$key}", $value, $this->ttl );
			}
		}
		parent::fill( $message );
	}

	/**
	 * `GET <key>` replies with the stored entry (Tachikoma Table.pm:102).
	 *
	 * The reply TYPE follows the stored value's shape, so what went in comes
	 * back out: an array replies TM_STRUCT, a scalar TM_BYTESTREAM. An absent
	 * key replies TM_ERROR — a divergence from Tachikoma, which returns an
	 * empty string and so cannot distinguish absent from stored-empty.
	 *
	 * `KEYS` and `STATS` are deliberately absent: both enumerate
	 * Tachikoma's in-memory buckets, which the memcache backing cannot do.
	 *
	 * @param array<int,mixed> $message The TM_REQUEST.
	 * @throws \RuntimeException With no wired sink to reply through.
	 */
	private function handle_request( array $message ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'fill requires a wired sink' );
		}
		$request       = \trim( Core::as_string( $message[ Message::VALUE ], '' ) );
		[ $cmd, $key ] = \array_pad( \explode( ' ', $request, 2 ), 2, '' );
		if ( 'GET' !== $cmd ) {
			$this->print_less_often( 'ERROR: bad request: ', $request );
			return;
		}
		$key   = \trim( $key );
		$value = self::lookup( $this->namespace, $key );

		$reply = Message::new_message();
		if ( null === $value ) {
			$reply[ Message::TYPE ]  = Message::TM_ERROR;
			$reply[ Message::VALUE ] = 'NOT_FOUND';
		} else {
			$reply[ Message::TYPE ]  = \is_array( $value ) ? Message::TM_STRUCT : Message::TM_BYTESTREAM;
			$reply[ Message::VALUE ] = $value;
		}
		$reply[ Message::FROM ] = $this->name;
		$reply[ Message::TO ]   = Core::as_string( $message[ Message::FROM ], '' );
		$reply[ Message::KEY ]  = $key;
		$this->sink->fill( $reply );
	}

	/**
	 * Cross-process read: the whole point of the memcache backing.
	 *
	 * @api Dashboards / REST / CLI read table values without a live worker.
	 * @param string $ns  Table namespace (the node's first argument).
	 * @param string $key Entry key.
	 * @return mixed The stored VALUE, or null when absent (or memcached is unconfigured).
	 */
	public static function lookup( string $ns, string $key ): mixed {
		if ( null === Core::$memd ) {
			$backend = Cache_Backend::shared_first();
			$value   = $backend?->get( self::KEY_PREFIX . "{$ns}:{$key}" );
			return false === $value || null === $value ? null : $value;
		}
		$value = Core::$memd->get( self::KEY_PREFIX . "{$ns}:{$key}" );
		if ( false === $value && \Memcached::RES_NOTFOUND === Core::$memd->getResultCode() ) {
			return null;
		}
		return $value;
	}

	/**
	 * Delete one entry. Verb-exposed (`rm <key>`).
	 *
	 * @param string $key Entry key.
	 */
	public function rm( string $key ): string {
		Cache_Backend::shared_first()?->delete( self::KEY_PREFIX . "{$this->namespace}:{$key}" );
		return "ok\n";
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Storage',
			'description' => 'Keyed KEY→VALUE store backed by memcache; write-through fill, cross-process lookup().',
			'arguments'   => [
				[ 'name' => 'namespace', 'type' => 'string', 'required' => true, 'description' => 'Scopes keys; lookup() reads by it.' ],
				[ 'name' => 'ttl', 'type' => 'int', 'default' => 0, 'description' => 'Entry TTL in seconds; 0 = no expiry.' ],
			],
			'commands'    => [
				[
					'name'        => 'get',
					'action'      => true,
					'description' => 'Read one entry (JSON-encoded), or "null" when absent.',
					'args'        => [ [ 'name' => 'key', 'type' => 'string', 'required' => true ] ],
					'handler'     => static function ( Command_Interpreter_Node $interpreter, array $args ): string {
						$patron = $interpreter->patron();
						if ( ! $patron instanceof self ) {
							return "error: no table patron\n";
						}
						return (string) \wp_json_encode( self::lookup( $patron->namespace, Core::as_string( $args[0] ?? '', '' ) ) );
					},
				],
				[
					'name'        => 'rm',
					'action'      => true,
					'description' => 'Delete one entry.',
					'args'        => [ [ 'name' => 'key', 'type' => 'string', 'required' => true ] ],
					'handler'     => static function ( Command_Interpreter_Node $interpreter, array $args ): string {
						$patron = $interpreter->patron();
						return $patron instanceof self ? $patron->rm( Core::as_string( $args[0] ?? '', '' ) ) : "error: no table patron\n";
					},
				],
			],
			'has_target'  => true,
		];
	}
}
