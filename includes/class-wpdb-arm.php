<?php
/**
 * Wpdb_Arm: the durable Cache_Backend arm shared across hosts.
 *
 * Two tables, `{base_prefix}newspack_nodes_table` for keyed rows and
 * `{base_prefix}newspack_nodes_members` for set members, each with a
 * namespace column, so every Table naming this arm shares them and sees only
 * its own rows. For
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
 * are binary, so `Kea` and `kea` stay two keys. A key or member longer than
 * its column, or a row no statement can carry under `max_allowed_packet`, is
 * refused before anything is sent: WordPress clears strict SQL mode, so MySQL
 * would otherwise truncate a long key silently into another key. A member read
 * is one statement per set key, a seek on the members table's primary key.
 *
 * @package Newspack_Nodes
 */

// phpcs:disable WordPress.DB.DirectDatabaseQuery -- The arm IS the table's store; there is no cache above it.

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * One namespace of the shared tables.
 */
final class Wpdb_Arm extends Durable_Arm {

	/** Widest namespace the column holds. */
	private const NAMESPACE_BYTES = 191;

	/**
	 * Widest key, set key or member a column holds: with the namespace, the
	 * members table's primary key stays under InnoDB's 767-byte index prefix.
	 */
	private const KEY_BYTES = 255;

	/** The keyed rows' table, under the base prefix. */
	private const KV_TABLE = 'newspack_nodes_table';

	/** The set members' table, under the base prefix. */
	private const MEMBERS_TABLE = 'newspack_nodes_members';

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

	/** Each shared table's suffix under the base prefix, its DDL, and the column widths it binds. */
	private const TABLES = [
		self::KV_TABLE      => [
			'CREATE TABLE IF NOT EXISTS %i ( namespace VARBINARY(%d) NOT NULL, cache_key VARBINARY(%d) NOT NULL, `value` LONGBLOB NOT NULL,'
			. ' expires INT UNSIGNED NOT NULL, PRIMARY KEY ( namespace, cache_key ), KEY namespace_expires ( namespace, expires ) )',
			[ self::NAMESPACE_BYTES, self::KEY_BYTES ],
		],
		self::MEMBERS_TABLE => [
			'CREATE TABLE IF NOT EXISTS %i ( namespace VARBINARY(%d) NOT NULL, set_key VARBINARY(%d) NOT NULL, member VARBINARY(%d) NOT NULL,'
			. ' `value` LONGBLOB NOT NULL, expires INT UNSIGNED NOT NULL, PRIMARY KEY ( namespace, set_key, member ), KEY namespace_expires ( namespace, expires ) )',
			[ self::NAMESPACE_BYTES, self::KEY_BYTES, self::KEY_BYTES ],
		],
	];

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
	 * Read the connection's packet limit and create the tables, each once per
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
		$connections  = self::$connections ??= new \WeakMap();
		$state        = $connections[ $db ] ?? [
			'packet' => self::packet( $db ),
			'tables' => [],
		];
		$this->packet = $state['packet'];
		foreach ( self::TABLES as $suffix => [ $ddl, $widths ] ) {
			$table = $db->base_prefix . $suffix;
			if ( ! \array_key_exists( $table, $state['tables'] ) ) {
				self::create( $table, $ddl, $widths );
				$state['tables'][ $table ] = true;
			}
		}
		$connections[ $db ] = $state;
	}

	/**
	 * See Durable_Arm::vacuum(). OPTIMIZE rebuilds both whole shared tables, so
	 * it is an operator's verb for a quiet moment. The server reports some
	 * failures as a result row rather than an error, so every row is read.
	 *
	 * @throws \RuntimeException When the server refuses the rebuild.
	 */
	public function vacuum(): void {
		try {
			foreach ( $this->rows( $this->statement( 'OPTIMIZE TABLE %i, %i', self::db()->base_prefix . self::MEMBERS_TABLE ) ) as $row ) {
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
				$this->statement( 'SELECT cache_key, `value` FROM %i WHERE namespace = %s AND cache_key IN ( ' . $in . ' ) AND ' . self::LIVE, $this->namespace, ...[ ...$chunk, self::now() ] ),
				'cache_key'
			);
		}
		return $out;
	}

	/** See Durable_Arm::select_set(). */
	protected function select_set( string $set_key, int $limit ): array {
		return $this->pairs(
			$this->member_statement( 'SELECT member, `value` FROM %i WHERE namespace = %s AND set_key = %s AND expires > %d ORDER BY member LIMIT %d', $this->namespace, $set_key, self::now(), $limit ),
			'member'
		);
	}

	/**
	 * A two-column SELECT's rows, as key => tagged bytes.
	 *
	 * @param string $statement The bound statement.
	 * @param string $key       The column the rows are keyed by.
	 * @return array<string,string>
	 * @throws \UnexpectedValueException When the server refused it.
	 */
	private function pairs( string $statement, string $key ): array {
		$out = [];
		foreach ( $this->rows( $statement ) as $row ) {
			$bytes = \base64_decode( Core::as_string( $row['value'] ), true );
			$out[ Core::as_string( $row[ $key ] ) ] = false === $bytes ? '' : $bytes;
		}
		return $out;
	}

	/**
	 * A statement's result rows.
	 *
	 * @param string $statement The bound statement.
	 * @return list<array<array-key,mixed>>
	 * @throws \UnexpectedValueException When the server refused it.
	 */
	private function rows( string $statement ): array {
		$db   = self::db();
		$rows = $db->get_results( $statement, 'ARRAY_A' );
		if ( '' !== $db->last_error || ! \is_array( $rows ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- The server's text is the failure record; it is escaped where shown.
			throw new \UnexpectedValueException( $db->last_error );
		}
		return \array_map( Core::arr( ... ), $rows );
	}

	/**
	 * See Durable_Arm::upsert(): every row is bound and measured first, then
	 * sent in as few statements as the packet allows.
	 */
	protected function upsert( array $rows, int $expires ): void {
		$tuples = [];
		foreach ( $rows as $key => $bytes ) {
			$tuples[] = self::bind( self::db(), '( %s, %s, %s, %d )', [ $this->namespace, self::column_key( (string) $key ), \base64_encode( $bytes ), $expires ] );
		}
		$this->send_upsert( $this->statement( 'INSERT INTO %i ( namespace, cache_key, `value`, expires ) VALUES ' ), $tuples );
	}

	/** See Durable_Arm::upsert_members(), measured and sent as upsert() is. */
	protected function upsert_members( array $rows ): void {
		$tuples = [];
		foreach ( $rows as [ $set_key, $member, $bytes, $expires ] ) {
			$tuples[] = self::bind( self::db(), '( %s, %s, %s, %s, %d )', [ $this->namespace, self::column_key( $set_key ), self::column_key( $member, 'member' ), \base64_encode( $bytes ), $expires ] );
		}
		$this->send_upsert( $this->member_statement( 'INSERT INTO %i ( namespace, set_key, member, `value`, expires ) VALUES ' ), $tuples );
	}

	/**
	 * Send bound rows under one INSERT head in as few statements as the packet
	 * allows, every row measured before the first is sent.
	 *
	 * @param string       $head   The bound `INSERT … VALUES ` head.
	 * @param list<string> $tuples Bound rows.
	 * @throws \UnexpectedValueException When a row cannot fit, or the server refused.
	 */
	private function send_upsert( string $head, array $tuples ): void {
		$room = $this->packet - self::PACKET_HEADROOM - \strlen( $head ) - \strlen( self::UPSERT_TAIL );
		$fit  = \array_map( fn ( string $tuple ): string => $this->fit( $tuple, $room ), $tuples );
		foreach ( self::chunks( $fit, $room ) as $chunk ) {
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
	 * @param string $key  Key.
	 * @param string $what What the key is, for the refusal.
	 * @return string The key.
	 * @throws \UnexpectedValueException On a key wider than the column.
	 */
	private static function column_key( string $key, string $what = 'key' ): string {
		if ( \strlen( $key ) > self::KEY_BYTES ) {
			throw new \UnexpectedValueException( "{$what} longer than " . self::KEY_BYTES . ' bytes' );
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

	/** See Durable_Arm::purge_rows(). */
	protected function purge_rows( int $now, int $limit ): int {
		return $this->run( 'DELETE FROM %i WHERE namespace = %s AND ' . self::EXPIRED . ' LIMIT %d', $this->namespace, $now, $limit );
	}

	/**
	 * See Durable_Arm::discard(): a DELETE of this namespace's rows, which
	 * costs what the rows do. Every wpdb Table shares the two tables, so a
	 * TRUNCATE would empty every other Table's rows too; wpdb is for
	 * low-volume Tables, where that cost stays small.
	 *
	 * @return array{rows:int} Rows deleted.
	 */
	protected function discard(): array {
		return [
			'rows' => self::checked( self::db()->query( $this->member_statement( 'DELETE FROM %i WHERE namespace = %s', $this->namespace ) ) )
				+ $this->run( 'DELETE FROM %i WHERE namespace = %s', $this->namespace ),
		];
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
		return self::db()->base_prefix . self::KV_TABLE;
	}

	/** See Durable_Arm::purge_member_rows(). */
	protected function purge_member_rows( int $now, int $limit ): int {
		return self::checked( self::db()->query( $this->member_statement( 'DELETE FROM %i WHERE namespace = %s AND expires <= %d LIMIT %d', $this->namespace, $now, $limit ) ) );
	}

	/**
	 * A statement against the members table, which binds as its first `%i`.
	 *
	 * @param literal-string $sql     The statement, with placeholders.
	 * @param mixed          ...$args Its values after the table.
	 * @return string The bound statement.
	 */
	private function member_statement( string $sql, mixed ...$args ): string {
		return self::bind( self::db(), $sql, [ self::db()->base_prefix . self::MEMBERS_TABLE, ...\array_values( $args ) ] );
	}

	/**
	 * Create one shared table.
	 *
	 * @param string         $table  The table name.
	 * @param literal-string $ddl    Its `CREATE TABLE IF NOT EXISTS`.
	 * @param list<int>      $widths The column widths it binds after the table.
	 * @throws \RuntimeException When the server refuses.
	 */
	private static function create( string $table, string $ddl, array $widths ): void {
		try {
			self::checked( self::db()->query( self::bind( self::db(), $ddl, [ $table, ...$widths ] ) ) );
		} catch ( \UnexpectedValueException $e ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; Table_Node::open() escapes the wrapped message once.
			throw new \RuntimeException( "wpdb backend could not create {$table}: " . $e->getMessage(), 0, $e );
		}
	}

	/**
	 * `$wpdb->prepare()`, refusing a statement it will not bind. Core's own
	 * prepare() binds a statement given too many values and only warns.
	 *
	 * @param \wpdb          $db   The handle.
	 * @param literal-string $sql  The statement, with placeholders.
	 * @param list<mixed>    $args Its values.
	 * @return string The bound statement.
	 * @throws \UnexpectedValueException When the placeholders and values disagree.
	 */
	private static function bind( \wpdb $db, string $sql, array $args ): string {
		$placeholders = \count( \array_diff( \preg_match_all( '/%(%|[sdfFi])/', $sql, $m ) > 0 ? $m[1] : [], [ '%' ] ) );
		if ( \count( $args ) !== $placeholders ) {
			throw new \UnexpectedValueException( "statement has {$placeholders} placeholders for " . \count( $args ) . ' values' );
		}
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
