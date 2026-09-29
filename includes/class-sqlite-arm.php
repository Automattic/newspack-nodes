<?php
/**
 * Sqlite_Arm: the durable, host-local Cache_Backend arm.
 *
 * One database file per Table node per partition, at
 * `{base}/tables/{table}.p{N}.sqlite`, on the one host's local filesystem the
 * substrate already requires (ADR-4). The partition's worker is the file's
 * one writer (ADR-6): it creates the file, puts it in WAL mode and declares
 * the `kv` table. Any other process on the host opens it read-only, changing
 * nothing in it and reading nothing while there is no file yet; WAL lets that
 * reader run without blocking the writer. A row whose `expires` has passed
 * reads as absent, and `purge()` reclaims it on the Router's tick.
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

	/** The open connection; null while a reader's file does not exist. */
	private ?\PDO $db = null;

	/**
	 * Open the file as its writer: create it and its directory, enter WAL
	 * mode and declare the `kv` table. A reader, `$read_only`, creates no
	 * file, directory or table and switches no journal mode. With no file at
	 * the path it reads nothing and fails every write, and each read looks
	 * again, so a file its writer creates while the arm lives is read from
	 * then on. It opens with `busy_timeout` alone, so only a path SQLite
	 * cannot open refuses here; a file that is no database, or holds no `kv`
	 * table, fails each read instead. SQLite may add the `-wal` and `-shm`
	 * files a WAL reader needs beside a file whose writer is not running.
	 *
	 * @param string $path            Database file.
	 * @param int    $busy_timeout_ms Wait on a held write lock, in milliseconds.
	 * @param bool   $read_only       Open as a reader rather than the writer.
	 * @throws \LogicException Without pdo_sqlite.
	 * @throws \RuntimeException When the directory or a path SQLite cannot open.
	 */
	public function __construct(
		private readonly string $path,
		private readonly int $busy_timeout_ms = self::BUSY_TIMEOUT_MS,
		private readonly bool $read_only = false
	) {
		if ( ! ( self::$available ?? static fn (): bool => \extension_loaded( 'pdo_sqlite' ) )() ) {
			throw new \LogicException( 'sqlite backend needs the pdo_sqlite extension' );
		}
		if ( ! $read_only ) {
			Config::ensure_path( \dirname( $path ) );
		}
		try {
			$this->db = $read_only ? $this->db() : $this->connect();
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
		$this->handle()->exec( 'VACUUM' );
		$checkpoint = $this->handle()->prepare( 'PRAGMA wal_checkpoint(TRUNCATE)' );
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
		$this->handle()->exec( 'BEGIN IMMEDIATE' );
		try {
			$out = $work();
			$this->handle()->exec( 'COMMIT' );
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
			$this->handle()->exec( 'ROLLBACK' );
		} catch ( \PDOException ) {
			// SQLite rolled back on its own error; nothing is left to end.
			return;
		}
	}

	/** See Durable_Arm::select_rows(). */
	protected function select_rows( array $keys ): array {
		$db = $this->db();
		if ( null === $db ) {
			// No file: its writer has not written, so there is nothing to read.
			return [];
		}
		$out = [];
		foreach ( \array_chunk( $keys, self::IN_CHUNK ) as $chunk ) {
			$in   = \implode( ',', \array_fill( 0, \count( $chunk ), '?' ) );
			$stmt = $db->prepare( "SELECT \"key\", \"value\" FROM kv WHERE \"key\" IN ( {$in} ) AND " . self::LIVE );
			$stmt->execute( [ ...$chunk, self::now() ] );
			$out += self::pairs( $stmt );
		}
		return $out;
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
		$stmt    = $this->handle()->prepare( "{$verb} INTO kv ( \"key\", \"value\", expires ) VALUES ( ?, ?, ? )" );
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
		$stmt = $this->handle()->prepare( 'UPDATE kv SET "value" = ? WHERE "key" = ? AND "value" = ? AND ' . self::LIVE );
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
		$stmt = $this->handle()->prepare( $sql );
		$stmt->execute( $args );
		return $stmt->rowCount();
	}

	/**
	 * The connection a statement runs on.
	 *
	 * @throws \PDOException When a reader's file does not exist, or cannot open.
	 */
	private function handle(): \PDO {
		return $this->db() ?? throw new \PDOException( "no file at {$this->path}" );
	}

	/**
	 * The connection, a reader's opened on its first call that finds a file.
	 *
	 * @return \PDO|null Null while a reader's file does not exist.
	 * @throws \PDOException When the file cannot open.
	 */
	private function db(): ?\PDO {
		if ( null === $this->db ) {
			\clearstatcache( true, $this->path );
			if ( \file_exists( $this->path ) ) {
				$this->db = $this->connect();
			}
		}
		return $this->db;
	}

	/**
	 * Open the connection: read-only, or as the writer in WAL mode with the
	 * `kv` table declared.
	 *
	 * @return \PDO The connection.
	 * @throws \PDOException When the file cannot open.
	 * @throws \RuntimeException When the writer cannot enter WAL mode.
	 */
	private function connect(): \PDO {
		$flags = $this->read_only ? [ \PDO::SQLITE_ATTR_OPEN_FLAGS => \PDO::SQLITE_OPEN_READONLY ] : [];
		$db    = new \PDO( 'sqlite:' . $this->path, null, null, [ \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION ] + $flags );
		$db->exec( 'PRAGMA busy_timeout = ' . \max( 1, $this->busy_timeout_ms ) );
		if ( $this->read_only ) {
			return $db;
		}
		$mode = $db->prepare( 'PRAGMA journal_mode = WAL' );
		$mode->execute();
		if ( 'wal' !== $mode->fetchColumn() ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; Table_Node::open() escapes the wrapped message once.
			throw new \RuntimeException( "sqlite backend could not enter WAL mode at {$this->path}" );
		}
		$db->exec( 'PRAGMA synchronous = NORMAL' );
		$db->exec( 'CREATE TABLE IF NOT EXISTS kv ( "key" TEXT PRIMARY KEY, "value" BLOB NOT NULL, expires INTEGER NOT NULL )' );
		$db->exec( 'CREATE INDEX IF NOT EXISTS kv_expires ON kv ( expires )' );
		return $db;
	}
}
