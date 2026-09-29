<?php
/**
 * Sqlite_Arm: the durable, host-local Cache_Backend arm.
 *
 * One database file per Table node per partition, at
 * `{base}/tables/{table}.p{N}.sqlite`, on the one host's local filesystem the
 * substrate already requires (ADR-4). The partition's worker is the file's
 * one writer (ADR-6); any process on the host reads it, which WAL allows
 * without blocking that writer. A row whose `expires` has passed reads as
 * absent, and `purge()` reclaims it on the Router's tick.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * One SQLite file, one `kv` table.
 */
final class Sqlite_Arm extends Durable_Arm {

	/** How long a call waits on another connection's write lock. */
	public const BUSY_TIMEOUT_MS = 1000;

	/** Keys bound per `IN ( … )`: under the 999 variables an older build allows. */
	private const IN_CHUNK = 500;

	/** SQL predicate for a live row; binds one `now`. */
	private const LIVE = '( expires = 0 OR expires > ? )';

	/** SQL predicate for an expired row; binds one `now`. */
	private const EXPIRED = '( expires > 0 AND expires <= ? )';

	/**
	 * Extension seam: whether `pdo_sqlite` is loaded. Null reads the real
	 * `extension_loaded()`; tests pin it false to reach the refusal.
	 * Signature: `function (): bool`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $available = null;

	/** The open connection. */
	private \PDO $db;

	/**
	 * Open the file, creating it and its directory, in WAL mode.
	 *
	 * @param string $path            Database file.
	 * @param int    $busy_timeout_ms Wait on a held write lock, in milliseconds.
	 * @throws \LogicException Without pdo_sqlite.
	 * @throws \RuntimeException When the directory or the file cannot open.
	 */
	public function __construct( private readonly string $path, int $busy_timeout_ms = self::BUSY_TIMEOUT_MS ) {
		if ( ! ( self::$available ?? static fn (): bool => \extension_loaded( 'pdo_sqlite' ) )() ) {
			throw new \LogicException( 'sqlite backend needs the pdo_sqlite extension' );
		}
		Config::ensure_path( \dirname( $path ) );
		try {
			$this->db = new \PDO( 'sqlite:' . $path, null, null, [ \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION ] );
			$this->db->exec( 'PRAGMA busy_timeout = ' . \max( 1, $busy_timeout_ms ) );
			$mode = $this->db->prepare( 'PRAGMA journal_mode = WAL' );
			$mode->execute();
			if ( 'wal' !== $mode->fetchColumn() ) {
				// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; Table_Node::open() escapes the wrapped message once.
				throw new \RuntimeException( "sqlite backend could not enter WAL mode at {$path}" );
			}
			$this->db->exec( 'PRAGMA synchronous = NORMAL' );
			$this->db->exec( 'CREATE TABLE IF NOT EXISTS kv ( "key" TEXT PRIMARY KEY, "value" BLOB NOT NULL, expires INTEGER NOT NULL )' );
			$this->db->exec( 'CREATE INDEX IF NOT EXISTS kv_expires ON kv ( expires )' );
		} catch ( \PDOException $e ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; Table_Node::open() escapes the wrapped message once.
			throw new \RuntimeException( "sqlite backend could not open {$path}: " . $e->getMessage(), 0, $e );
		}
	}

	/**
	 * See Durable_Arm::vacuum(); the checkpoint returns the WAL's pages too.
	 *
	 * @throws \RuntimeException When a reader keeps the checkpoint from finishing.
	 */
	public function vacuum(): void {
		$this->db->exec( 'VACUUM' );
		$checkpoint = $this->db->prepare( 'PRAGMA wal_checkpoint(TRUNCATE)' );
		$checkpoint->execute();
		$row = $checkpoint->fetch( \PDO::FETCH_NUM );
		if ( ! \is_array( $row ) || 0 !== Core::as_int( $row[0] ) ) {
			$this->failure = 'database is locked: a reader holds the WAL';
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; the verb reporting it escapes at its view.
			throw new \RuntimeException( $this->last_failure() );
		}
	}

	/** See Cache_Backend::last_failure(). */
	public function last_failure(): string {
		return "sqlite {$this->path}: {$this->failure}";
	}

	/** See Cache_Backend::backend_name(). */
	public function backend_name(): string {
		return 'sqlite';
	}

	/** See Cache_Backend::batch_is_atomic(); every write runs in one transaction. */
	public function batch_is_atomic(): bool {
		return true;
	}

	/**
	 * See Durable_Arm::write_scope(): one transaction holding the write lock
	 * from its start, so a read inside sees what it writes over. The file is
	 * this arm's own, so no caller's transaction shares the connection.
	 */
	protected function write_scope( \Closure $work ): mixed {
		$this->db->exec( 'BEGIN IMMEDIATE' );
		try {
			$out = $work();
			$this->db->exec( 'COMMIT' );
			return $out;
		} catch ( \Throwable $e ) {
			$this->rollback();
			throw $e;
		}
	}

	/**
	 * End a failed transaction, whether it failed mid-way or at a COMMIT
	 * SQLite answered BUSY, which leaves the transaction open.
	 */
	private function rollback(): void {
		try {
			$this->db->exec( 'ROLLBACK' );
		} catch ( \PDOException ) {
			// SQLite rolled back on its own error; nothing is left to end.
			return;
		}
	}

	/** See Durable_Arm::select_rows(). */
	protected function select_rows( array $keys ): array {
		$out = [];
		foreach ( \array_chunk( $keys, self::IN_CHUNK ) as $chunk ) {
			$in   = \implode( ',', \array_fill( 0, \count( $chunk ), '?' ) );
			$stmt = $this->db->prepare( "SELECT \"key\", \"value\" FROM kv WHERE \"key\" IN ( {$in} ) AND " . self::LIVE );
			$stmt->execute( [ ...$chunk, self::now() ] );
			$out += self::pairs( $stmt );
		}
		return $out;
	}

	/** See Durable_Arm::upsert(). */
	protected function upsert( array $rows, int $expires ): void {
		$this->store( 'INSERT OR REPLACE', $rows, $expires );
	}

	/** See Durable_Arm::claim(). */
	protected function claim( string $key, string $bytes, int $expires ): bool {
		$this->run( 'DELETE FROM kv WHERE "key" = ? AND ' . self::EXPIRED, [ $key, self::now() ] );
		return 1 === $this->store( 'INSERT OR IGNORE', [ $key => $bytes ], $expires );
	}

	/**
	 * Insert rows with one prepared statement, values bound as blobs.
	 *
	 * @param string                  $verb    `INSERT OR REPLACE` or `INSERT OR IGNORE`.
	 * @param array<array-key,string> $rows    Key => tagged bytes.
	 * @param int                     $expires The `expires` column for every row.
	 * @return int Rows changed.
	 */
	private function store( string $verb, array $rows, int $expires ): int {
		$stmt    = $this->db->prepare( "{$verb} INTO kv ( \"key\", \"value\", expires ) VALUES ( ?, ?, ? )" );
		$changed = 0;
		foreach ( $rows as $key => $bytes ) {
			$stmt->bindValue( 1, (string) $key );
			$stmt->bindValue( 2, $bytes, \PDO::PARAM_LOB );
			$stmt->bindValue( 3, $expires, \PDO::PARAM_INT );
			$stmt->execute();
			$changed += $stmt->rowCount();
		}
		return $changed;
	}

	/** See Durable_Arm::replace(). */
	protected function replace( string $key, string $old, string $new ): bool {
		$stmt = $this->db->prepare( 'UPDATE kv SET "value" = ? WHERE "key" = ? AND "value" = ? AND ' . self::LIVE );
		$stmt->bindValue( 1, $new, \PDO::PARAM_LOB );
		$stmt->bindValue( 2, $key );
		$stmt->bindValue( 3, $old, \PDO::PARAM_LOB );
		$stmt->bindValue( 4, self::now(), \PDO::PARAM_INT );
		$stmt->execute();
		return 1 === $stmt->rowCount();
	}

	/** See Durable_Arm::update_expiry(). */
	protected function update_expiry( string $key, int $expires ): int {
		return $this->run( 'UPDATE kv SET expires = ? WHERE "key" = ? AND ' . self::LIVE, [ $expires, $key, self::now() ] );
	}

	/** See Durable_Arm::delete_key(). */
	protected function delete_key( string $key ): int {
		return $this->run( 'DELETE FROM kv WHERE "key" = ? AND ' . self::LIVE, [ $key, self::now() ] );
	}

	/** See Durable_Arm::scan_rows(). */
	protected function scan_rows( string $prefix, ?string $upper, int $limit ): array {
		$stmt = $this->db->prepare(
			'SELECT "key", "value" FROM kv WHERE "key" >= ?' . ( null === $upper ? '' : ' AND "key" < ?' )
			. ' AND ' . self::LIVE . " ORDER BY \"key\" LIMIT {$limit}"
		);
		$stmt->execute( [ $prefix, ...( null === $upper ? [] : [ $upper ] ), self::now() ] );
		return self::pairs( $stmt );
	}

	/**
	 * A key/value result as key => tagged bytes.
	 *
	 * @param \PDOStatement $stmt An executed two-column statement.
	 * @return array<array-key,string>
	 */
	private static function pairs( \PDOStatement $stmt ): array {
		return \array_map( Core::as_string( ... ), $stmt->fetchAll( \PDO::FETCH_KEY_PAIR ) );
	}

	/** See Durable_Arm::purge_rows(). */
	protected function purge_rows( int $now, int $limit ): int {
		return $this->run( 'DELETE FROM kv WHERE rowid IN ( SELECT rowid FROM kv WHERE ' . self::EXPIRED . " LIMIT {$limit} )", [ $now ] );
	}

	/**
	 * Run one statement.
	 *
	 * @param string      $sql  Statement.
	 * @param list<mixed> $args Bound values.
	 * @return int Rows changed.
	 */
	private function run( string $sql, array $args ): int {
		$stmt = $this->db->prepare( $sql );
		$stmt->execute( $args );
		return $stmt->rowCount();
	}
}
