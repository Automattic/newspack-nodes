<?php
/**
 * Table
 *
 * The keyed store (Tachikoma Table vocabulary), backed by memcache — the
 * documented divergence: Tachikoma's Table holds windowed in-memory buckets,
 * but this substrate's dashboards/REST/CLI have no efficient way to query a
 * live worker, so values land in memcache where ANY process reads them via
 * `lookup()`. TTL replaces bucket windows.
 *
 * fill() stores KEY→VALUE write-through (the message passes on), so the
 * table composes mid-graph: `… → Table → …`. Keyless messages pass through
 * unstored. `lookup()` / `store()` / `forget()` are the same table reached
 * from outside a graph — a REST handler, wp-admin, a CLI command — and are
 * how a caller stays out of the key convention's business. Nothing about them
 * needs a graph: `Table_Node::table( $ns )` builds one anywhere.
 *
 * An OPTIONAL accumulator tier holds values a caller is still folding into,
 * bringing back Tachikoma's buckets as a tier rather than as the store. It is
 * off by default because a table is a cross-process source of truth and held
 * state is not: nothing another process writes touches it, so opting in
 * buys speed and pays bounded staleness. See arguments().
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

	private string $namespace = '';
	private int $ttl          = 0;

	/** In-memory accumulator, or null until accumulator() opts in. */
	private ?LRU_Cache $buffer = null;

	/** Tachikoma-parity: no-arg ctor. Wires the sibling :config interpreter that serves `get` / `rm`. */
	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	/**
	 * `<namespace> [ttl]` — namespace is required (it scopes lookup()); ttl in
	 * seconds, 0 (default) = no expiry.
	 *
	 * Re-calling this moves a live table, which is how a caller carries a
	 * generation: name the table `pyrobase:g47` and a schema bump renames it to
	 * `pyrobase:g48`, orphaning every key at BOTH tiers at once. That works
	 * because entries are keyed by the derived `entry_key()`, not the bare key.
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
		$key   = Core::as_string( $message[ Message::KEY ], '' );
		$value = $message[ Message::VALUE ];
		if ( '' !== $key ) {
			// Empty deletes (Table.pm:313); a bare terminator counts as empty.
			$empty = null === $value || [] === $value
				|| ( \is_string( $value ) && '' === \rtrim( $value, "\r\n" ) );
			if ( $empty ) {
				$this->forget( $key );
			} else {
				$this->store( $key, $value );
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
		$sink = $this->require_sink();
		$request       = \trim( Core::as_string( $message[ Message::VALUE ], '' ) );
		[ $cmd, $key ] = \array_pad( \explode( ' ', $request, 2 ), 2, '' );
		if ( 'GET' !== $cmd ) {
			$this->print_less_often( 'ERROR: bad request: ', $request );
			return;
		}
		$key   = \trim( $key );
		$value = $this->lookup( $key );

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
		$sink->fill( $reply );
	}

	/**
	 * Read many keys, found-only, keyed by the caller's key.
	 *
	 * One backend round trip for the whole set, so a caller resolving
	 * a set of ids pays one `getMulti` rather than N reads.
	 *
	 * @api Batch readers (a dashboard resolving a page of ids).
	 * @param list<string> $keys Entry keys.
	 * @return array<string,mixed> Values for the keys that were present.
	 */
	public function lookup_multi( array $keys ): array {
		$entry_keys = [];
		foreach ( $keys as $key ) {
			$entry_keys[ self::entry_key( $this->namespace, $key ) ] = $key;
		}
		$found   = [];
		$fetched = Cache_Backend::shared_first()?->read_multi( \array_keys( $entry_keys ) ) ?? [];
		foreach ( $fetched as $entry_key => $value ) {
			$found[ $entry_keys[ $entry_key ] ] = $value;
		}
		return $found;
	}

	/**
	 * Cross-process write — the mirror of lookup(), and the same divergence.
	 *
	 * `fill()` is the graph's way in, but the processes that own a table's
	 * contents are not always in a graph: a ruleset saved from wp-admin, a
	 * REST handler, a CLI command. Without this they each assemble
	 * `Cache_Backend::shared_first()?->set( Table_Node::entry_key( … ) )` by
	 * hand, which puts the key convention in every caller.
	 *
	 * Fails soft when the backend went away, as every read here does. The TTL
	 * is the table's, not the call's — one table, one lifetime.
	 *
	 * @api Non-graph writers store table values without a live worker.
	 * @param string $key   Entry key.
	 * @param mixed  $value Value to store.
	 * @return bool True when the backend accepted the write. A caller that
	 *              shadows its writes durably must not record a refused one.
	 */
	public function store( string $key, mixed $value ): bool {
		$entry_key = self::entry_key( $this->namespace, $key );
		return true === Cache_Backend::shared_first()?->set( $entry_key, $value, $this->ttl );
	}

	/**
	 * Delete one entry. Verb-exposed (`rm <key>`).
	 *
	 * @param string $key Entry key.
	 */
	public function rm( string $key ): string {
		$this->forget( $key );
		return "ok\n";
	}

	/**
	 * Fold a value into the accumulator. In memory only — `store()` persists.
	 *
	 * @param string $key   Entry key.
	 * @param mixed  $value Value to hold.
	 * @throws \LogicException Without accumulator() first; dropping the value
	 *                         silently would lose whatever it counted.
	 */
	public function accumulate( string $key, mixed $value ): void {
		if ( null === $this->buffer ) {
			throw new \LogicException( 'Table::accumulate() needs accumulator() first' );
		}
		$this->buffer->set( self::entry_key( $this->namespace, $key ), $value );
	}

	/**
	 * The accumulating value for a key, or what is stored when none is held.
	 *
	 * The fallback is what makes a cold key resumable: an entry evicted, or never
	 * accumulated in this process, still folds onto what was last persisted.
	 *
	 * @param string $key Entry key.
	 */
	public function accumulated( string $key ): mixed {
		$held = $this->buffer?->get( self::entry_key( $this->namespace, $key ) );
		return null !== $held ? $held : $this->lookup( $key );
	}

	/**
	 * Cross-process read: the whole point of the memcache backing.
	 *
	 * Only a HIT returns a value: an absent key stays absent, so a caller
	 * polling one it expects to appear sees it as soon as memcache does.
	 *
	 * @api Dashboards / REST / CLI read table values without a live worker.
	 * @param string $key Entry key.
	 * @return mixed The stored VALUE, or null when absent (or memcached is unconfigured).
	 */
	public function lookup( string $key ): mixed {
		$entry_key = self::entry_key( $this->namespace, $key );
		// read() carries the status the raw handle needed getResultCode() for.
		$read = Cache_Backend::shared_first()?->read( $entry_key );
		if ( Cache_Backend::READ_ERROR === ( $read['status'] ?? null ) ) {
			// Null reads as "empty table" downstream; say the backend broke.
			Core::print_less_often( 'Table: backend read error for ', "{$this->namespace}:{$key}" );
		}
		if ( Cache_Backend::READ_HIT !== ( $read['status'] ?? null ) ) {
			return null;
		}
		return $read['value'];
	}

	/**
	 * Walk what is held, keyed by the caller's key, for a drain.
	 *
	 * Draining does NOT clear: a caller that persists whole values is idempotent
	 * across drains, and clearing would discard accumulation between them.
	 *
	 * @return iterable<string,mixed>
	 */
	public function accumulating(): iterable {
		if ( null === $this->buffer ) {
			return;
		}
		$prefix = self::entry_key( $this->namespace, '' );
		foreach ( $this->buffer->iterate() as $entry_key => $value ) {
			yield \substr( (string) $entry_key, \strlen( $prefix ) ) => $value;
		}
	}

	/**
	 * Cross-process delete, for the same callers `store()` serves.
	 *
	 * @api Non-graph writers drop table entries without a live worker.
	 * @param string $key Entry key.
	 */
	public function forget( string $key ): void {
		$entry_key = self::entry_key( $this->namespace, $key );
		Cache_Backend::shared_first()?->delete( $entry_key );
	}

	/**
	 * Memcache key for one entry. Site-scoped through Cache_Backend: a table is
	 * a cross-container source of truth for THIS install, and a co-tenant
	 * install's table of the same name is a different table.
	 */
	public static function entry_key( string $ns, string $key ): string {
		return Cache_Backend::site_key( "table:{$ns}:{$key}" );
	}

	/**
	 * Opt in to an in-memory accumulator tier, and set its bounds.
	 *
	 * @api Callers folding many updates into a value before persisting it.
	 * @param int $bucket_size Entries per bucket before rotation.
	 * @param int $num_buckets Buckets retained; capacity is roughly the product.
	 * @return self For chaining off table().
	 */
	public function accumulator( int $bucket_size, int $num_buckets ): self {
		$this->buffer = new LRU_Cache( $bucket_size, $num_buckets );
		return $this;
	}

	/** Drop everything the accumulator holds. */
	public function reset(): void {
		$this->buffer?->flush();
	}

	/**
	 * A table outside any graph, for the callers `lookup()` / `store()` /
	 * `forget()` exist for. Sugar for `new Table_Node()` plus `arguments()`.
	 *
	 * Deliberately NOT memoized: an accumulator's lifetime belongs to whoever
	 * holds the table, and one rebuilt per call is empty every time — worse
	 * than none. Callers wanting one memoize it themselves, which is what keeps
	 * that lifetime visible at the call site instead of hidden in here.
	 *
	 * @api Non-graph readers and writers reach a table without a live worker.
	 * @param string $ns     Table namespace.
	 * @param int    $ttl    Entry TTL in seconds; 0 = no expiry.
	 * @throws \InvalidArgumentException With an empty namespace.
	 * @throws \LogicException With no backing store; a caller that treats a
	 *                         backend-less host as ordinary guards on
	 *                         `Cache_Backend::shared_first()` first.
	 */
	public static function table( string $ns, int $ttl = 0 ): self {
		$table = new self();
		$table->arguments( [ $ns, (string) $ttl ] );
		return $table;
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
						return (string) \wp_json_encode( $patron->lookup( Core::as_string( $args[0] ?? '', '' ) ) );
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
