<?php
/**
 * Wpdb_Arm: the durable Cache_Backend arm shared across hosts.
 *
 * One table, `{base_prefix}newspack_nodes_table`, with a namespace column, so
 * every Table naming this arm shares it and sees only its own rows. For
 * low-volume Tables that must survive and be read from any host; a Table
 * written per request belongs on SQLite or memcache.
 *
 * The arm writes on the site's own connection, where a caller may hold a
 * transaction, and MySQL commits that transaction the moment another one
 * starts. So the arm opens none: every statement is atomic on its own, a batch
 * lands chunk by chunk (`batch_is_atomic()` is false), `add()` is an INSERT
 * IGNORE, and a counter writes only where the row still holds what it read.
 *
 * Values are the tagged serialization in base64, because `$wpdb`'s query
 * sanitizer is not a safe carrier for igbinary's raw bytes. The key columns
 * are binary, so `Kea` and `kea` stay two keys. A key longer than its column,
 * or a row no statement can carry under `max_allowed_packet`, is refused before
 * anything is sent: WordPress clears strict SQL mode, so MySQL would otherwise
 * truncate a long key silently into another key.
 *
 * @package Newspack_Nodes
 */

// phpcs:disable WordPress.DB.DirectDatabaseQuery -- The arm IS the table's store; there is no cache above it.

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * One namespace of the shared table.
 */
final class Wpdb_Arm extends Durable_Arm {

	/** Widest namespace the column holds. */
	private const NAMESPACE_BYTES = 191;

	/** Widest key the column holds. */
	private const KEY_BYTES = 255;

	/** Keys per SELECT: 500 of at most 255 bytes stay far inside any packet. */
	private const IN_CHUNK = 500;

	/** Bytes of a packet left to the protocol's own framing. */
	private const PACKET_HEADROOM = 1024;

	/** SQL predicate for a live row; binds one `now`. */
	private const LIVE = '( expires = 0 OR expires > %d )';

	/** SQL predicate for an expired row; binds one `now`. */
	private const EXPIRED = '( expires > 0 AND expires <= %d )';

	/** What follows a batch's VALUES list. */
	private const UPSERT_TAIL = ' ON DUPLICATE KEY UPDATE `value` = VALUES( `value` ), expires = VALUES( expires )';

	/**
	 * Per connection: its `max_allowed_packet`, and the tables created on it,
	 * so each is read or created once per process and a new connection object
	 * starts afresh.
	 *
	 * @var \WeakMap<\wpdb,array{packet:int,tables:array<string,true>}>|null
	 */
	private static ?\WeakMap $connections = null;

	/** The connection's `max_allowed_packet`, in bytes. */
	private int $packet;

	/**
	 * Read the connection's packet limit and create the table, each once per
	 * connection.
	 *
	 * @param string $namespace The Table's namespace, which scopes every row.
	 * @throws \InvalidArgumentException On a namespace the column cannot hold.
	 * @throws \RuntimeException When the limit cannot be read or the table created.
	 */
	public function __construct( private readonly string $namespace ) {
		if ( self::refuses_key( $namespace ) || \strlen( $namespace ) > self::NAMESPACE_BYTES ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; Table_Node::open() escapes the wrapped message once.
			throw new \InvalidArgumentException( "wpdb backend cannot hold namespace {$namespace}" );
		}
		$db           = self::db();
		$table        = self::table();
		$connections  = self::$connections ??= new \WeakMap();
		$state        = $connections[ $db ] ?? [
			'packet' => self::packet( $db ),
			'tables' => [],
		];
		$this->packet = $state['packet'];
		if ( ! \array_key_exists( $table, $state['tables'] ) ) {
			$this->create( $table );
			$state['tables'][ $table ] = true;
		}
		$connections[ $db ] = $state;
	}

	/**
	 * See Durable_Arm::vacuum(). OPTIMIZE rebuilds the whole shared table, so
	 * it is an operator's verb for a quiet moment. The server reports some
	 * failures as a result row rather than an error, so every row is read.
	 *
	 * @throws \RuntimeException When the server refuses the rebuild.
	 */
	public function vacuum(): void {
		try {
			foreach ( $this->rows( 'OPTIMIZE TABLE %i' ) as $row ) {
				if ( 'error' === \strtolower( Core::as_string( $row['Msg_type'] ) ) ) {
					throw new \UnexpectedValueException( Core::as_string( $row['Msg_text'] ) );
				}
			}
		} catch ( \UnexpectedValueException $e ) {
			$this->failure = $e->getMessage();
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; the verb reporting it escapes at its view.
			throw new \RuntimeException( "vacuum failed: {$this->failure}", 0, $e );
		}
	}

	/** See Cache_Backend::last_failure(). */
	public function last_failure(): string {
		return 'wpdb ' . self::table() . ": {$this->failure}";
	}

	/** See Cache_Backend::backend_name(). */
	public function backend_name(): string {
		return 'wpdb';
	}

	/** See Durable_Arm::write_scope(): no transaction, for the reason above. */
	protected function write_scope( \Closure $work ): mixed {
		return $work();
	}

	/** See Durable_Arm::select_rows(). */
	protected function select_rows( array $keys ): array {
		$out = [];
		foreach ( \array_chunk( $keys, self::IN_CHUNK ) as $chunk ) {
			$in   = \implode( ', ', \array_fill( 0, \count( $chunk ), '%s' ) );
			$out += $this->pairs(
				'SELECT cache_key, `value` FROM %i WHERE namespace = %s AND cache_key IN ( ' . $in . ' ) AND ' . self::LIVE,
				$this->namespace,
				...[ ...$chunk, self::now() ]
			);
		}
		return $out;
	}

	/**
	 * See Durable_Arm::upsert(): every row is bound and measured first, then
	 * sent in as few statements as the packet allows.
	 */
	protected function upsert( array $rows, int $expires ): void {
		$head   = $this->statement( 'INSERT INTO %i ( namespace, cache_key, `value`, expires ) VALUES ' );
		$room   = $this->packet - self::PACKET_HEADROOM - \strlen( $head ) - \strlen( self::UPSERT_TAIL );
		$tuples = [];
		foreach ( $rows as $key => $bytes ) {
			$tuple    = self::bind( self::db(), '( %s, %s, %s, %d )', [ $this->namespace, self::column_key( (string) $key ), \base64_encode( $bytes ), $expires ] );
			$tuples[] = $this->fit( $tuple, $room );
		}
		foreach ( self::chunks( $tuples, $room ) as $chunk ) {
			self::checked( self::db()->query( $head . \implode( ', ', $chunk ) . self::UPSERT_TAIL ) );
		}
	}

	/**
	 * Group bound rows greedily into lists whose joined length fits `$room`.
	 *
	 * @param list<string> $tuples Bound rows, each already within `$room`.
	 * @param int          $room   Bytes a VALUES list may take.
	 * @return list<list<string>>
	 */
	private static function chunks( array $tuples, int $room ): array {
		$chunks = [];
		$chunk  = [];
		$used   = 0;
		foreach ( $tuples as $tuple ) {
			$more = \strlen( $tuple ) + ( [] === $chunk ? 0 : 2 );
			if ( [] !== $chunk && $used + $more > $room ) {
				$chunks[] = $chunk;
				$chunk    = [];
				$more     = \strlen( $tuple );
				$used     = 0;
			}
			$chunk[] = $tuple;
			$used   += $more;
		}
		if ( [] !== $chunk ) {
			$chunks[] = $chunk;
		}
		return $chunks;
	}

	/** See Durable_Arm::claim(); the INSERT is measured before the DELETE runs. */
	protected function claim( string $key, string $bytes, int $expires ): bool {
		$insert = $this->fit(
			$this->statement( 'INSERT IGNORE INTO %i ( namespace, cache_key, `value`, expires ) VALUES ( %s, %s, %s, %d )', $this->namespace, self::column_key( $key ), \base64_encode( $bytes ), $expires ),
			$this->packet - self::PACKET_HEADROOM
		);
		$this->run( 'DELETE FROM %i WHERE namespace = %s AND cache_key = %s AND ' . self::EXPIRED, $this->namespace, $key, self::now() );
		return 1 === self::checked( self::db()->query( $insert ) );
	}

	/**
	 * A key the column holds whole.
	 *
	 * @param string $key Key.
	 * @return string The key.
	 * @throws \UnexpectedValueException On a key wider than the column.
	 */
	private static function column_key( string $key ): string {
		if ( \strlen( $key ) > self::KEY_BYTES ) {
			throw new \UnexpectedValueException( 'key longer than ' . self::KEY_BYTES . ' bytes' );
		}
		return $key;
	}

	/**
	 * A bound statement no longer than `$room`.
	 *
	 * @param string $statement The bound row or statement.
	 * @param int    $room      Bytes it may take.
	 * @return string The statement.
	 * @throws \UnexpectedValueException When it cannot fit.
	 */
	private function fit( string $statement, int $room ): string {
		if ( \strlen( $statement ) > $room ) {
			throw new \UnexpectedValueException( 'row of ' . \strlen( $statement ) . " bytes cannot fit max_allowed_packet {$this->packet}" );
		}
		return $statement;
	}

	/** See Durable_Arm::replace(). */
	protected function replace( string $key, string $old, string $new ): bool {
		return 1 === $this->run(
			'UPDATE %i SET `value` = %s WHERE namespace = %s AND cache_key = %s AND `value` = %s AND ' . self::LIVE,
			\base64_encode( $new ),
			$this->namespace,
			$key,
			\base64_encode( $old ),
			self::now()
		);
	}

	/** See Durable_Arm::update_expiry(); MySQL counts an unmoved expiry as no change. */
	protected function update_expiry( string $key, int $expires ): int {
		return $this->run( 'UPDATE %i SET expires = %d WHERE namespace = %s AND cache_key = %s AND ' . self::LIVE, $expires, $this->namespace, $key, self::now() );
	}

	/** See Durable_Arm::delete_key(). */
	protected function delete_key( string $key ): int {
		return $this->run( 'DELETE FROM %i WHERE namespace = %s AND cache_key = %s AND ' . self::LIVE, $this->namespace, $key, self::now() );
	}

	/** See Durable_Arm::scan_rows(). */
	protected function scan_rows( string $prefix, ?string $upper, int $limit ): array {
		if ( null === $upper ) {
			return $this->pairs( 'SELECT cache_key, `value` FROM %i WHERE namespace = %s AND cache_key >= %s AND ' . self::LIVE . ' ORDER BY cache_key LIMIT %d', $this->namespace, $prefix, self::now(), $limit );
		}
		return $this->pairs( 'SELECT cache_key, `value` FROM %i WHERE namespace = %s AND cache_key >= %s AND cache_key < %s AND ' . self::LIVE . ' ORDER BY cache_key LIMIT %d', $this->namespace, $prefix, $upper, self::now(), $limit );
	}

	/**
	 * A key/value SELECT against the table, as key => tagged bytes.
	 *
	 * @param literal-string $sql     The statement, with placeholders.
	 * @param mixed          ...$args Its values after the table.
	 * @return array<string,string>
	 * @throws \UnexpectedValueException When the server refused it.
	 */
	private function pairs( string $sql, mixed ...$args ): array {
		$out = [];
		foreach ( $this->rows( $sql, ...$args ) as $row ) {
			$bytes = \base64_decode( Core::as_string( $row['value'] ), true );
			$out[ Core::as_string( $row['cache_key'] ) ] = false === $bytes ? '' : $bytes;
		}
		return $out;
	}

	/**
	 * A statement's result rows.
	 *
	 * @param literal-string $sql     The statement, with placeholders.
	 * @param mixed          ...$args Its values after the table.
	 * @return list<array<array-key,mixed>>
	 * @throws \UnexpectedValueException When the server refused it.
	 */
	private function rows( string $sql, mixed ...$args ): array {
		$db   = self::db();
		$rows = $db->get_results( $this->statement( $sql, ...$args ), 'ARRAY_A' );
		if ( '' !== $db->last_error || ! \is_array( $rows ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- The server's text is the failure record; it is escaped where shown.
			throw new \UnexpectedValueException( $db->last_error );
		}
		return \array_map( Core::arr( ... ), $rows );
	}

	/** See Durable_Arm::purge_rows(). */
	protected function purge_rows( int $now, int $limit ): int {
		return $this->run( 'DELETE FROM %i WHERE namespace = %s AND ' . self::EXPIRED . ' LIMIT %d', $this->namespace, $now, $limit );
	}

	/**
	 * Create the shared table.
	 *
	 * @param string $table The table name, for the refusal.
	 * @throws \RuntimeException When the server refuses.
	 */
	private function create( string $table ): void {
		try {
			$this->run(
				'CREATE TABLE IF NOT EXISTS %i ( namespace VARBINARY(%d) NOT NULL, cache_key VARBINARY(%d) NOT NULL, `value` LONGBLOB NOT NULL,'
				. ' expires INT UNSIGNED NOT NULL, PRIMARY KEY ( namespace, cache_key ), KEY namespace_expires ( namespace, expires ) )',
				self::NAMESPACE_BYTES,
				self::KEY_BYTES
			);
		} catch ( \UnexpectedValueException $e ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; Table_Node::open() escapes the wrapped message once.
			throw new \RuntimeException( "wpdb backend could not create {$table}: " . $e->getMessage(), 0, $e );
		}
	}

	/**
	 * Run one statement against the table, which binds as its first `%i`.
	 *
	 * @param literal-string $sql     The statement, with placeholders.
	 * @param mixed          ...$args Its values after the table.
	 * @return int Rows changed.
	 * @throws \UnexpectedValueException When the server refused it.
	 */
	private function run( string $sql, mixed ...$args ): int {
		return self::checked( self::db()->query( $this->statement( $sql, ...$args ) ) );
	}

	/**
	 * A statement with the table and its values bound.
	 *
	 * @param literal-string $sql     The statement, with placeholders.
	 * @param mixed          ...$args Its values after the table.
	 * @return string The bound statement.
	 */
	private function statement( string $sql, mixed ...$args ): string {
		return self::bind( self::db(), $sql, [ self::table(), ...\array_values( $args ) ] );
	}

	/**
	 * The shared table, under the network's base prefix.
	 *
	 * @return string The table name.
	 */
	public static function table(): string {
		return self::db()->base_prefix . 'newspack_nodes_table';
	}

	/**
	 * `$wpdb->prepare()`, refusing a statement it will not bind.
	 *
	 * @param \wpdb          $db   The handle.
	 * @param literal-string $sql  The statement, with placeholders.
	 * @param list<mixed>    $args Its values.
	 * @return string The bound statement.
	 * @throws \UnexpectedValueException When the placeholders and values disagree.
	 */
	private static function bind( \wpdb $db, string $sql, array $args ): string {
		return $db->prepare( $sql, ...$args ) ?? throw new \UnexpectedValueException( 'wpdb could not prepare the statement' );
	}

	/**
	 * The rows a statement changed.
	 *
	 * @param int|bool $result What `$wpdb->query()` answered.
	 * @return int Rows changed.
	 * @throws \UnexpectedValueException When the server refused the statement.
	 */
	private static function checked( int|bool $result ): int {
		$db = self::db();
		if ( false === $result ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- The server's text is the failure record; it is escaped where shown.
			throw new \UnexpectedValueException( $db->last_error );
		}
		return $db->rows_affected;
	}

	/**
	 * The site's database handle.
	 *
	 * @return \wpdb The handle.
	 * @throws \LogicException Outside WordPress.
	 */
	private static function db(): \wpdb {
		$db = $GLOBALS['wpdb'] ?? null;
		return $db instanceof \wpdb ? $db : throw new \LogicException( 'wpdb backend needs $wpdb' );
	}

	/**
	 * The connection's `max_allowed_packet`.
	 *
	 * @param \wpdb $db The handle.
	 * @return int Bytes.
	 * @throws \RuntimeException When the server will not say.
	 */
	private static function packet( \wpdb $db ): int {
		$packet = $db->get_var( 'SELECT @@max_allowed_packet' );
		if ( ! \is_numeric( $packet ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; Table_Node::open() escapes the wrapped message once.
			throw new \RuntimeException( "wpdb backend could not read max_allowed_packet: {$db->last_error}" );
		}
		return (int) $packet;
	}
}
