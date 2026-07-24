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

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Table node.
 */
class Table_Node extends Node {
	use Schema_Reflection;

	public const KEY_PREFIX = 'nodes-table:';

	private string $namespace = '';
	private int $ttl          = 0;

	/**
	 * `<namespace> [ttl]` — namespace is required (it scopes lookup());
	 * ttl in seconds, 0 (default) = no expiry.
	 *
	 * @param list<string>|null $args
	 * @return list<string>
	 * @throws \InvalidArgumentException Without a namespace argument.
	 * @throws \LogicException Without memcached (the table has no backing store).
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
		if ( null === Core::$memd ) {
			throw new \LogicException( 'Table requires memcached (memcache_servers unconfigured)' );
		}
		$this->namespace = $namespace;
		$this->ttl       = \max( 0, Core::num_int( $args[1] ?? 0, 0 ) );
		return $args;
	}

	public function fill( array $message ): void {
		$key = Core::as_string( $message[ Message::KEY ], '' );
		if ( '' !== $key && null !== Core::$memd ) {
			Core::$memd->set( self::KEY_PREFIX . "{$this->namespace}:{$key}", $message[ Message::VALUE ], $this->ttl );
		}
		parent::fill( $message );
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
			return null;
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
		Core::$memd?->delete( self::KEY_PREFIX . "{$this->namespace}:{$key}" );
		return 'ok';
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
					'description' => 'Read one entry (JSON-encoded), or "null" when absent.',
					'args'        => [ [ 'name' => 'key', 'type' => 'string', 'required' => true ] ],
					'handler'     => static function ( Command_Interpreter_Node $interpreter, array $args ): string {
						$patron = $interpreter->patron();
						if ( ! $patron instanceof self ) {
							return 'error: no table patron';
						}
						return (string) \wp_json_encode( self::lookup( $patron->namespace, Core::as_string( $args[0] ?? '', '' ) ) );
					},
				],
				[
					'name'        => 'rm',
					'description' => 'Delete one entry.',
					'args'        => [ [ 'name' => 'key', 'type' => 'string', 'required' => true ] ],
					'handler'     => static function ( Command_Interpreter_Node $interpreter, array $args ): string {
						$patron = $interpreter->patron();
						return $patron instanceof self ? $patron->rm( Core::as_string( $args[0] ?? '', '' ) ) : 'error: no table patron';
					},
				],
			],
			'requests'    => [],
			'has_target'  => true,
		];
	}
}
