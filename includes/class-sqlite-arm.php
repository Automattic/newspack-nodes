<?php
/**
 * Sqlite_Arm: the durable, host-local Cache_Backend arm.
 *
 * One database file per Table node per partition, at
 * `{base}/tables/{table}.p{N}.sqlite`, on the one host's local filesystem the
 * substrate already requires (ADR-4). The partition's worker is the file's
 * one writer (ADR-6): it creates the file, puts it in WAL mode and declares
 * the `kv` and `members` tables. Any other process on the host opens it
 * read-only, changing nothing in it and reading nothing while there is no
 * file yet; WAL lets that reader run without blocking the writer. A row whose
 * `expires` has passed reads as absent, and `purge()` reclaims it on the
 * Router's tick. A member read is one primary-key seek per set key.
 *
 * No COMMIT checkpoints: the writer turns `wal_autocheckpoint` off, and the
 * Router's tick calls `checkpoint()` instead, after the tick's writes, so a
 * write pays for its own frames and never for copying the WAL back.
 *
 * A write wrapped in `write_scope()` begins its own transaction, and a
 * rewrite is an UPSERT, updating the row it finds in place. Every fixed
 * statement is prepared once per connection.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * One SQLite file: a `kv` table, and a `members` table of set members.
 */
final class Sqlite_Arm extends Durable_Arm {

	/** How long a call waits on another connection's write lock. */
	public const BUSY_TIMEOUT_MS = 1000;

	/**
	 * Page cache per connection, in KiB: 64 MiB, against SQLite's 2 MB
	 * default. Staging's aggregate file is ~300 MB and its worker reads back
	 * the current hour's keys before each write, a working set the default
	 * evicts between messages: 500 random keys took 46 ms there against
	 * 5.7 ms for adjacent ones. The worker's long-lived connection is the one
	 * that keeps pages; a mount's lives one request. SQLite allocates a page
	 * only when a statement touches it, so this is a ceiling: on eve a reader
	 * grew 4 KiB at open and 4.6 MB reading 500 random keys of a 266 MB file.
	 * `mmap_size` stays 0: on eve it cost a fresh connection 0.5 ms per 500
	 * random keys and paid only on a warm one, which no mount is.
	 */
	public const CACHE_KIB = 65536;

	/**
	 * Bytes the writer's WAL file is cut back to once a checkpoint rewinds
	 * it: 64 MiB. SQLite writes a rewound WAL from its start and otherwise
	 * keeps the file at its high-water mark, so one stalled checkpoint or one
	 * backfill would hold its size on disk for good. At staging's ~630 frames
	 * a second one `Table_Node::CHECKPOINT_INTERVAL_S` writes ~75 MB, so a
	 * steady interval regrows only its last ~10 MB past the cap, while a
	 * burst gives back everything above it.
	 */
	public const WAL_LIMIT_BYTES = 67108864;

	/** The page-cache pragma; a negative size counts KiB rather than pages. */
	private const CACHE_PRAGMA = 'PRAGMA cache_size = -' . self::CACHE_KIB;

	/** The WAL checkpoint every writer runs on the tick. */
	public const PASSIVE_CHECKPOINT = 'PRAGMA wal_checkpoint(PASSIVE)';

	/** Keys bound per `IN ( … )`: under the 999 variables an older build allows. */
	public const IN_CHUNK = 500;

	/** SQL predicate for a live row; binds one `now`. */
	private const LIVE = '( expires = 0 OR expires > ? )';

	/** SQL predicate for an expired row; binds one `now`. */
	private const EXPIRED = '( expires > 0 AND expires <= ? )';

	/** One set's live members: a primary-key seek, in its order; binds set, now, limit. */
	private const MEMBERS_READ = 'SELECT member, "value" FROM members WHERE set_key = ? AND expires > ? ORDER BY member LIMIT ?';

	/** A row when the file declares a `members` table. */
	private const MEMBERS_TABLE = "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'members'";

	/** Expired keyed rows, deleted by rowid; binds now, limit. */
	private const KV_PURGE = 'DELETE FROM kv WHERE rowid IN ( SELECT rowid FROM kv WHERE ' . self::EXPIRED . ' LIMIT ? )';

	/** A row written, or rewritten in place; binds key, value, expires. */
	private const KV_UPSERT = 'INSERT INTO kv ( "key", "value", expires ) VALUES ( ?, ?, ? ) ON CONFLICT ( "key" ) DO UPDATE SET "value" = excluded."value", expires = excluded.expires';

	/** A member written, or rewritten in place; binds set, member, value, expires. */
	private const MEMBERS_UPSERT = 'INSERT INTO members ( set_key, member, "value", expires ) VALUES ( ?, ?, ?, ? ) ON CONFLICT ( set_key, member ) DO UPDATE SET "value" = excluded."value", expires = excluded.expires';

	/** An expired row under a key `claim()` takes; binds key, now. */
	private const KV_CLAIM_EXPIRED = 'DELETE FROM kv WHERE "key" = ? AND ' . self::EXPIRED;

	/** A row written only where its key holds none; binds key, value, expires. */
	private const KV_CLAIM = 'INSERT OR IGNORE INTO kv ( "key", "value", expires ) VALUES ( ?, ?, ? )';

	/** Expired members through `members_expires`, deleted by key; binds now, limit. */
	private const MEMBERS_PURGE = 'DELETE FROM members WHERE ( set_key, member ) IN ( SELECT set_key, member FROM members WHERE expires <= ? LIMIT ? )';

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

	/** Whether the open file holds a `members` table; null until first asked. */
	private ?bool $has_members = null;

	/**
	 * The open connection's statements, each prepared on its first use.
	 *
	 * @var array<string,\PDOStatement> SQL => statement.
	 */
	private array $statements = [];

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
	 * @param string $namespace       The Table's namespace, which prefixes its keys.
	 * @param int    $busy_timeout_ms Wait on a held write lock, in milliseconds.
	 * @param bool   $read_only       Open as a reader rather than the writer.
	 * @throws \LogicException Without pdo_sqlite.
	 * @throws \RuntimeException When the directory or a path SQLite cannot open.
	 */
	public function __construct(
		private readonly string $path,
		private readonly string $namespace,
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
		$row = $this->single_row( 'PRAGMA wal_checkpoint(TRUNCATE)' );
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

	/**
	 * This file's PASSIVE checkpoint; see passive_checkpoint().
	 *
	 * @return array{0: int, 1: int}|null The WAL's frames, and those written
	 *                                    back; null while another connection
	 *                                    checkpoints.
	 * @throws \PDOException When the checkpoint fails.
	 */
	public function checkpoint(): ?array {
		return self::passive_checkpoint( $this->statement( self::PASSIVE_CHECKPOINT ) );
	}

	/**
	 * One PASSIVE checkpoint: copy back every WAL frame no reader's snapshot
	 * still needs, waiting on no reader and blocking none. Frames past an
	 * open reader's snapshot stay for the next call, which is ordinary. While
	 * another connection holds the checkpoint lock, as the next partition
	 * writing a Ledger's file may, SQLite answers busy and copies nothing.
	 *
	 * @param \PDOStatement $checkpoint PASSIVE_CHECKPOINT, prepared on a
	 *                                  writer's connection.
	 * @return array{0: int, 1: int}|null The WAL's frames, and those written
	 *                                    back; null when SQLite answered busy.
	 * @throws \PDOException When the checkpoint fails.
	 */
	public static function passive_checkpoint( \PDOStatement $checkpoint ): ?array {
		self::execute( $checkpoint );
		$row = $checkpoint->fetchAll( \PDO::FETCH_NUM )[0] ?? [];
		$row = \is_array( $row ) ? $row : [];
		if ( 1 === Core::as_int( $row[0] ?? 0 ) ) {
			return null;
		}
		return [ \max( 0, Core::as_int( $row[1] ?? 0 ) ), \max( 0, Core::as_int( $row[2] ?? 0 ) ) ];
	}

	/**
	 * Run `$work` in one `BEGIN DEFERRED … COMMIT` on `$db`, so every read in
	 * it sees the one snapshot its first read took, whatever another
	 * connection commits meanwhile. In WAL it takes no lock a writer waits on.
	 *
	 * @template T
	 * @param \PDO           $db   The connection.
	 * @param \Closure(): T  $work What the transaction reads.
	 * @return T What `$work` returned.
	 */
	public static function deferred( \PDO $db, \Closure $work ): mixed {
		return self::transaction( $db, 'BEGIN DEFERRED', $work );
	}

	/** See Durable_Arm::row_key(): `{namespace}:{key}`. */
	public function row_key( string $key ): string {
		return "{$this->namespace}:{$key}";
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
	 * Whether `$name` cannot name a SQLite file inside its directory: a path
	 * separator, NUL, `..`, a leading dot, or any character outside
	 * `[A-Za-z0-9_.:-]`.
	 *
	 * @param string $name A Table's or a Ledger's declared name.
	 * @return bool True when it cannot.
	 */
	public static function refuses_file_name( string $name ): bool {
		return 1 !== \preg_match( '/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/D', $name ) || \str_contains( $name, '..' );
	}

	/**
	 * Refuse a reader running as root: SQLite can add `-wal` and `-shm` files
	 * beside a WAL database, and root's would lock the file's writer out.
	 * Running as root is the operator's to fix, never a backend to degrade
	 * past, so the refusal is a plain \RuntimeException.
	 *
	 * @param string $path The file the reader would open.
	 * @throws \RuntimeException In a process running as root.
	 */
	public static function refuse_root_reader( string $path ): void {
		if ( 0 === CLI::uid() ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; the node wrapping it escapes the message once.
			throw new \RuntimeException( "a sqlite mount refuses to run as root: a root reader leaves -wal and -shm files beside {$path} that its worker cannot open" );
		}
	}

	/**
	 * See Durable_Arm::write_scope(): one transaction holding the write lock
	 * from its start, so a read inside sees what it writes over. The file is
	 * this arm's own, so no caller's transaction shares the connection.
	 */
	protected function write_scope( \Closure $work ): mixed {
		return self::immediate( $this->handle(), $work );
	}

	/**
	 * Run `$work` in one `BEGIN IMMEDIATE … COMMIT` on `$db`, which takes the
	 * write lock at its start, waiting on busy_timeout for another writer's.
	 * A throw rolls the transaction back and propagates.
	 *
	 * @template T
	 * @param \PDO           $db   The connection.
	 * @param \Closure(): T  $work What the transaction runs.
	 * @return T What `$work` returned.
	 */
	public static function immediate( \PDO $db, \Closure $work ): mixed {
		return self::transaction( $db, 'BEGIN IMMEDIATE', $work );
	}

	/**
	 * Run `$work` between `$begin` and a COMMIT; a throw rolls it back and
	 * propagates.
	 *
	 * @template T
	 * @param \PDO           $db    The connection.
	 * @param string         $begin The BEGIN statement.
	 * @param \Closure(): T  $work  What the transaction runs.
	 * @return T What `$work` returned.
	 */
	private static function transaction( \PDO $db, string $begin, \Closure $work ): mixed {
		$db->exec( $begin );
		try {
			$out = $work();
			$db->exec( 'COMMIT' );
			return $out;
		} catch ( \Throwable $e ) {
			self::rollback( $db );
			throw $e;
		}
	}

	/**
	 * End a failed transaction, whether it failed mid-way or at a COMMIT
	 * SQLite answered BUSY, which leaves the transaction open.
	 *
	 * @param \PDO $db The connection.
	 */
	private static function rollback( \PDO $db ): void {
		try {
			$db->exec( 'ROLLBACK' );
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
			$stmt = $db->prepare( "SELECT \"key\", \"value\", expires FROM kv WHERE \"key\" IN ( {$in} ) AND " . self::LIVE );
			self::execute( $stmt, [ ...$chunk, self::now() ] );
			/** @var array<array-key,array{0: string, 1: int}> $rows The key column keys each row. */
			$rows = $stmt->fetchAll( \PDO::FETCH_UNIQUE | \PDO::FETCH_NUM );
			$out  = $rows + $out;
		}
		return $out;
	}

	/** See Durable_Arm::upsert(); a key already there is updated in place. */
	protected function upsert( array $rows, int $expires ): void {
		$this->store( self::KV_UPSERT, $rows, $expires );
	}

	/** See Durable_Arm::claim(). */
	protected function claim( string $key, string $bytes, int $expires ): bool {
		$this->run( self::KV_CLAIM_EXPIRED, [ $key, self::now() ] );
		return 1 === $this->store( self::KV_CLAIM, [ $key => $bytes ], $expires );
	}

	/**
	 * Write rows through one prepared statement, values bound as blobs.
	 *
	 * @param string                  $sql     KV_UPSERT or KV_CLAIM.
	 * @param array<array-key,string> $rows    Key => tagged bytes.
	 * @param int                     $expires The `expires` column for every row.
	 * @return int Rows changed.
	 */
	private function store( string $sql, array $rows, int $expires ): int {
		$stmt    = $this->statement( $sql );
		$changed = 0;
		foreach ( $rows as $key => $bytes ) {
			$stmt->bindValue( 1, (string) $key );
			$stmt->bindValue( 2, $bytes, \PDO::PARAM_LOB );
			$stmt->bindValue( 3, $expires, \PDO::PARAM_INT );
			self::execute( $stmt );
			$changed += $stmt->rowCount();
		}
		return $changed;
	}

	/** See Durable_Arm::replace(). */
	protected function replace( string $key, string $old, string $new ): bool {
		$stmt = $this->statement( 'UPDATE kv SET "value" = ? WHERE "key" = ? AND "value" = ? AND ' . self::LIVE );
		$stmt->bindValue( 1, $new, \PDO::PARAM_LOB );
		$stmt->bindValue( 2, $key );
		$stmt->bindValue( 3, $old, \PDO::PARAM_LOB );
		$stmt->bindValue( 4, self::now(), \PDO::PARAM_INT );
		self::execute( $stmt );
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

	/**
	 * Run one statement.
	 *
	 * @param string      $sql  Statement.
	 * @param list<mixed> $args Bound values.
	 * @return int Rows changed.
	 */
	private function run( string $sql, array $args ): int {
		$stmt = $this->statement( $sql );
		self::execute( $stmt, $args );
		return $stmt->rowCount();
	}

	/** See Durable_Arm::purge_rows(). */
	protected function purge_rows( int $now, int $limit ): int {
		return $this->delete_expired( self::KV_PURGE, $now, $limit );
	}

	/**
	 * See Durable_Arm::discard(): the file, not its rows. A Table partition
	 * owns its file, and its writer is the file's one writer (ADR-6), so the
	 * writer unlinks the database and its `-wal` and `-shm`, drops its
	 * connection and its prepared statements, and opens a new file with the
	 * same pragmas and tables: a cost that never grows with the rows. A mount in
	 * another process that opened the old file keeps reading its rows until
	 * that request ends; one opened after reads the new file.
	 *
	 * @return array{bytes:int} What the three files held before the unlink.
	 * @throws \UnexpectedValueException On a reader, or a file that will not unlink.
	 */
	protected function discard(): array {
		if ( $this->read_only ) {
			throw new \UnexpectedValueException( 'a reader cannot flush' );
		}
		$sizes = self::file_sizes( $this->path );
		try {
			foreach ( \array_keys( $sizes ) as $file ) {
				if ( ! @\unlink( $file ) ) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
					throw new \UnexpectedValueException( "could not unlink {$file}" );
				}
			}
		} finally {
			// Reopen even on a refusal: never write into an unlinked inode.
			$this->statements  = [];
			$this->has_members = null;
			$this->db          = null;
			$this->db          = $this->connect();
		}
		return [ 'bytes' => \array_sum( $sizes ) ];
	}

	/**
	 * The files one SQLite database is made of — the database, its `-wal` and
	 * its `-shm` — each on disk now, with its bytes.
	 *
	 * @param string $path The database file.
	 * @return array<string,int> File => bytes; a file not on disk is absent.
	 */
	public static function file_sizes( string $path ): array {
		\clearstatcache();
		$sizes = [];
		foreach ( [ $path, "{$path}-wal", "{$path}-shm" ] as $file ) {
			if ( \is_file( $file ) ) {
				$sizes[ $file ] = (int) \filesize( $file );
			}
		}
		return $sizes;
	}

	/** See Durable_Arm::purge_member_rows(); the table has no rowid to name. */
	protected function purge_member_rows( int $now, int $limit ): int {
		return $this->delete_expired( self::MEMBERS_PURGE, $now, $limit );
	}

	/**
	 * Delete up to `$limit` rows expired at `$now`, both bound as integers.
	 *
	 * @param string $sql   KV_PURGE or MEMBERS_PURGE.
	 * @param int    $now   Epoch second.
	 * @param int    $limit Most rows.
	 * @return int Rows deleted.
	 */
	private function delete_expired( string $sql, int $now, int $limit ): int {
		$stmt = $this->statement( $sql );
		$stmt->bindValue( 1, $now, \PDO::PARAM_INT );
		$stmt->bindValue( 2, $limit, \PDO::PARAM_INT );
		self::execute( $stmt );
		return $stmt->rowCount();
	}

	/** See Durable_Arm::upsert_members(); a member already there is updated in place. */
	protected function upsert_members( array $rows ): void {
		$stmt = $this->statement( self::MEMBERS_UPSERT );
		foreach ( $rows as [ $set_key, $member, $bytes, $expires ] ) {
			$stmt->bindValue( 1, $set_key );
			$stmt->bindValue( 2, $member );
			$stmt->bindValue( 3, $bytes, \PDO::PARAM_LOB );
			$stmt->bindValue( 4, $expires, \PDO::PARAM_INT );
			self::execute( $stmt );
		}
	}

	/** See Durable_Arm::select_set(). */
	protected function select_set( string $set_key, int $limit ): array {
		if ( null === $this->db() ) {
			// No file: its writer has not written, so there is nothing to read.
			return [];
		}
		// A file its writer declared before members holds none to read.
		$this->has_members ??= null !== $this->single_row( self::MEMBERS_TABLE );
		if ( ! $this->has_members ) {
			return [];
		}
		$read = $this->statement( self::MEMBERS_READ );
		$read->bindValue( 1, $set_key );
		$read->bindValue( 2, self::now(), \PDO::PARAM_INT );
		$read->bindValue( 3, $limit, \PDO::PARAM_INT );
		self::execute( $read );
		return \array_map( Core::as_string( ... ), $read->fetchAll( \PDO::FETCH_KEY_PAIR ) );
	}

	/**
	 * The one row a statement answers, read to its end, so a cached statement
	 * holds no read snapshot open past this call.
	 *
	 * @param string $sql The statement.
	 * @return array<array-key,mixed>|null The row, or null when it answered none.
	 */
	private function single_row( string $sql ): ?array {
		$stmt = $this->statement( $sql );
		self::execute( $stmt );
		$rows = $stmt->fetchAll( \PDO::FETCH_NUM );
		return \is_array( $rows[0] ?? null ) ? $rows[0] : null;
	}

	/**
	 * The open connection's prepared statement for `$sql`, prepared once.
	 *
	 * @param string $sql The statement.
	 * @throws \PDOException When a reader's file does not exist, or it will not prepare.
	 */
	private function statement( string $sql ): \PDOStatement {
		return $this->statements[ $sql ] ??= $this->handle()->prepare( $sql );
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
	 * Open the connection through `open_database()`, declaring the writer's
	 * `kv` and `members` tables.
	 *
	 * @return \PDO The connection.
	 * @throws \PDOException When the file cannot open.
	 * @throws \RuntimeException When the writer cannot enter WAL mode.
	 */
	private function connect(): \PDO {
		$db = self::open_database( $this->path, $this->read_only, $this->busy_timeout_ms );
		if ( $this->read_only ) {
			return $db;
		}
		$db->exec( 'CREATE TABLE IF NOT EXISTS kv ( "key" TEXT PRIMARY KEY, "value" BLOB NOT NULL, expires INTEGER NOT NULL )' );
		$db->exec( 'CREATE INDEX IF NOT EXISTS kv_expires ON kv ( expires )' );
		$db->exec( 'CREATE TABLE IF NOT EXISTS members ( set_key TEXT NOT NULL, member TEXT NOT NULL, "value" BLOB NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY ( set_key, member ) ) WITHOUT ROWID' );
		$db->exec( 'CREATE INDEX IF NOT EXISTS members_expires ON members ( expires )' );
		$this->has_members = true;
		return $db;
	}

	/**
	 * The one place a SQLite file opens, for a Table's arm and a Ledger alike:
	 * `busy_timeout`, then for a writer WAL, `synchronous=NORMAL`, no
	 * autocheckpoint, the WAL cap and the page cache, and for a reader the page
	 * cache alone. It declares no table; each caller declares its own. A reader
	 * creates nothing and refuses a path with no file.
	 *
	 * @param string $path            Database file; a writer's directory exists.
	 * @param bool   $read_only       Open as a reader rather than a writer.
	 * @param int    $busy_timeout_ms Wait on a held write lock, in milliseconds.
	 * @return \PDO The connection, throwing on every error.
	 * @throws \PDOException When the file cannot open.
	 * @throws \RuntimeException When a writer cannot enter WAL mode.
	 */
	public static function open_database( string $path, bool $read_only, int $busy_timeout_ms ): \PDO {
		$flags = $read_only ? [ \PDO::SQLITE_ATTR_OPEN_FLAGS => \PDO::SQLITE_OPEN_READONLY ] : [];
		$db    = new \PDO( 'sqlite:' . $path, null, null, [ \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION ] + $flags );
		self::busy_timeout( $db, $busy_timeout_ms );
		if ( $read_only ) {
			try {
				$db->exec( self::CACHE_PRAGMA );
			} catch ( \PDOException ) {
				// It reads the schema; a non-database file fails each read.
				return $db;
			}
			return $db;
		}
		$mode = $db->prepare( 'PRAGMA journal_mode = WAL' );
		self::execute( $mode );
		if ( 'wal' !== $mode->fetchColumn() ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; the node wrapping it escapes the message once.
			throw new \RuntimeException( "sqlite backend could not enter WAL mode at {$path}" );
		}
		$db->exec( 'PRAGMA synchronous = NORMAL' );
		$db->exec( 'PRAGMA wal_autocheckpoint = 0' );
		$db->exec( 'PRAGMA journal_size_limit = ' . self::WAL_LIMIT_BYTES );
		$db->exec( self::CACHE_PRAGMA );
		return $db;
	}

	/**
	 * Execute `$statement`, resetting it when it fails, so its next execute
	 * runs afresh: a statement SQLite answered BUSY fails every retry until
	 * it is reset. Every statement on a SQLite file runs through here.
	 *
	 * @param \PDOStatement    $statement The statement.
	 * @param list<mixed>|null $params    Values to bind, or null for those bound.
	 * @throws \PDOException When the statement fails.
	 */
	public static function execute( \PDOStatement $statement, ?array $params = null ): void {
		try {
			$statement->execute( $params );
		} catch ( \PDOException $e ) {
			$statement->closeCursor();
			throw $e;
		}
	}

	/**
	 * Set how long `$db` waits on another connection's write lock.
	 *
	 * @param \PDO $db              The connection.
	 * @param int  $busy_timeout_ms Milliseconds, at least 1.
	 */
	public static function busy_timeout( \PDO $db, int $busy_timeout_ms ): void {
		$db->exec( 'PRAGMA busy_timeout = ' . \max( 1, $busy_timeout_ms ) );
	}
}
