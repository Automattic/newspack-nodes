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
 * write pays for its own frames and never for copying the WAL back. A file
 * many processes open as its writer, as a Table built outside any graph is,
 * keeps SQLite's own COMMIT checkpoint, because no tick reaches it, and its
 * flush empties the file in place, because the others hold it open.
 *
 * A write wrapped in `write_scope()` begins its own transaction, and a
 * rewrite is an UPSERT, updating the row it finds in place. Every fixed
 * statement is prepared once per connection.
 *
 * A `Row_Schema` declares row tables beside `kv`: the writer creates them
 * with their keys, indexes and FTS5 shadows, stamps the file's
 * `user_version`, and discards a file stamped with another version that
 * holds any of them. `write_rows()` writes a batch of ops in one
 * transaction, `purge()` reclaims rows past their window and rows nothing
 * names, and `open_rows()` attaches every partition's file read-only into one
 * reader connection.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * One SQLite file: a `kv` table, a `members` table of set members, and the
 * row tables a `Row_Schema` declares.
 *
 * @phpstan-type Row_Spec array{
 *   columns: array<string,string>,
 *   key?: list<string>,
 *   add?: array<string,'sum'|'max'|'min'>,
 *   indexes?: array<string,list<string>>,
 *   retain?: array{0:string,1:int,2:int},
 *   retained_by?: list<array{0:string,1:string,2:string}>,
 *   keep?: bool,
 *   autoincrement?: string,
 *   fts?: list<string>
 * }
 * @phpstan-type Rows array{version:int, tables:array<string,Row_Spec>}
 * @phpstan-type Row_Op array{0:string, 1:string, 2:list<scalar|null>, 3?:list<mixed>, 4?:array<int,int>}
 */
final class Sqlite_Arm extends Durable_Arm {

	/** How long a call waits on another connection's write lock. */
	public const BUSY_TIMEOUT_MS = 1000;

	/**
	 * Page cache per connection, in KiB: 64 MiB, against SQLite's 2 MB
	 * default. It bounds how much of a file a worker's long-lived connection
	 * keeps between messages, so a write reading back the rows it is about to
	 * fold finds their pages cached rather than read again; a mount's
	 * connection lives one request. SQLite allocates a page only when a
	 * statement touches it, so this is a ceiling, never an allocation at
	 * open. `mmap_size` stays 0 here: for a Table's point reads a fresh
	 * connection, which every mount is, pays to map a file that only a warm
	 * one reads back faster. `open_rows()` scans, and maps.
	 */
	public const CACHE_KIB = 65536;

	/**
	 * Bytes the writer's WAL file is cut back to once a checkpoint rewinds
	 * it: 64 MiB. SQLite writes a rewound WAL from its start and otherwise
	 * keeps the file at its high-water mark, so without this one stalled
	 * checkpoint or one backfill would hold its size on disk for good. A
	 * steady `Table_Node::CHECKPOINT_INTERVAL_S` regrows the WAL only by what
	 * one interval writes past the cap, and a burst gives back everything
	 * above it.
	 */
	public const WAL_LIMIT_BYTES = 67108864;

	/**
	 * Page cache per attached file in an `open_rows()` reader, in KiB: 8 MiB,
	 * so a reader attaching all `Spawn_Coordinator::MAX_PARTITIONS` files
	 * stays inside the 64 MiB one Table connection may take.
	 */
	private const ROWS_CACHE_KIB = 8192;

	/**
	 * Bytes of each attached file an `open_rows()` reader maps: SQLite's
	 * default `SQLITE_MAX_MMAP_SIZE`, which a build may lower but rarely
	 * raises. A day's scan touches more pages than `ROWS_CACHE_KIB` holds,
	 * and each page it misses is a `pread()` back into the file; mapped, a
	 * page the kernel holds is read in place, with no syscall and no copy.
	 * On a host where a syscall is dear, such as Atomic, that turns a minute's
	 * scan into seconds.
	 */
	private const ROWS_MMAP_BYTES = 2147418112;

	/**
	 * Page cache of the file a `build_rows()` connection writes, in KiB:
	 * 256 MiB, so indexing a day's URL rows re-reads them from memory.
	 */
	private const BUILD_CACHE_KIB = 262144;

	/** The page-cache pragma; a negative size counts KiB rather than pages. */
	private const CACHE_PRAGMA = 'PRAGMA cache_size = -' . self::CACHE_KIB;

	/** Every file's `kv` and `members` tables and their indexes, by the name each takes. */
	public const KV_DDL = [
		'kv'              => 'CREATE TABLE IF NOT EXISTS kv ( "key" TEXT PRIMARY KEY, "value" BLOB NOT NULL, expires INTEGER NOT NULL )',
		'kv_expires'      => 'CREATE INDEX IF NOT EXISTS kv_expires ON kv ( expires )',
		'members'         => 'CREATE TABLE IF NOT EXISTS members ( set_key TEXT NOT NULL, member TEXT NOT NULL, "value" BLOB NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY ( set_key, member ) ) WITHOUT ROWID',
		'members_expires' => 'CREATE INDEX IF NOT EXISTS members_expires ON members ( expires )',
	];

	/** The tables FTS5 keeps beside an `fts` shadow `{table}_fts`, as suffixes on it. */
	private const FTS_TABLES = [ '_data', '_idx', '_docsize', '_config' ];

	/** The triggers keeping a shadow in step, `{table}_fts_{name}`: name => when. */
	private const FTS_TRIGGERS = [
		'insert' => 'AFTER INSERT',
		'delete' => 'AFTER DELETE',
	];

	/** The row ops a batch may name. */
	private const ROW_OPS = [ 'insert', 'ignore', 'add', 'set' ];

	/** Keys bound per `IN ( … )`: under the 999 variables an older build allows. */
	private const IN_CHUNK = 500;

	/** SQL predicate for a live row; binds one `now`. */
	private const LIVE = '( expires = 0 OR expires > ? )';

	/** SQL predicate for an expired row; binds one `now`. */
	private const EXPIRED = '( expires > 0 AND expires <= ? )';

	/** One set's live rows with expiry, in member order; binds set, now, limit. */
	private const MEMBERS_ROWS = 'SELECT member, "value", expires FROM members WHERE set_key = ? AND expires > ? ORDER BY member LIMIT ?';

	/** One member's row; binds set, member. */
	private const MEMBER_DELETE = 'DELETE FROM members WHERE set_key = ? AND member = ?';

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

	/** The oldest expiry of an expired keyed row or member; binds now, now. */
	private const OLDEST_EXPIRY = 'SELECT MIN( expires ) FROM ( SELECT MIN( expires ) AS expires FROM kv WHERE ' . self::EXPIRED . ' UNION ALL SELECT MIN( expires ) FROM members WHERE expires <= ? )';

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
	 * Each row op's SQL, built once from the declared shape.
	 *
	 * @var array<string,string> "{op} {table}" => SQL.
	 */
	private array $row_sql = [];

	/**
	 * Each autoincrement table's key columns, as positions in its rows, in
	 * key order, the order the `id` statement binds them.
	 *
	 * @var array<string,list<int>> Table => positions.
	 */
	private array $key_positions = [];

	/**
	 * Each row table's releases, read once from the declared tables: the
	 * columns a DELETE of its rows returns, how many releases one deleted
	 * row can reach, and the names tables those columns release, by each
	 * one's own column.
	 *
	 * @var array<string,array{returning:list<string>,reach:int,names:array<string,array<string,list<string>>>}>
	 */
	private array $releases = [];

	/**
	 * Open the file as its writer: create it and its directory, enter WAL
	 * mode and declare the `kv` table. A reader, `$read_only`, creates no
	 * file, directory or table and switches no journal mode. With no file at
	 * the path it reads nothing and fails every write, and each read looks
	 * again, so a file its writer creates while the arm lives is read from
	 * then on. It opens with `busy_timeout` alone, so only a path SQLite
	 * cannot open refuses here; a file that is not a database, or holds no `kv`
	 * table, fails each read instead. SQLite may add the `-wal` and `-shm`
	 * files a WAL reader needs beside a file whose writer is not running.
	 *
	 * `$rows` declares row tables beside `kv`, as a `Row_Schema`'s version
	 * and tables, already validated by the node that owns the file.
	 *
	 * @param string    $path            Database file.
	 * @param string    $namespace       The Table's namespace, which prefixes its keys.
	 * @param int       $busy_timeout_ms Wait on a held write lock, in milliseconds.
	 * @param bool      $read_only       Open as a reader rather than the writer.
	 * @param Rows|null $rows            The declared row tables, or none.
	 * @param bool      $many_writers    Other processes open the file as its
	 *                                   writer too, so no tick checkpoints it
	 *                                   and a flush must keep its inode.
	 * @throws \LogicException Without pdo_sqlite.
	 * @throws \RuntimeException When the directory or a path SQLite cannot open.
	 */
	public function __construct(
		private readonly string $path,
		private readonly string $namespace,
		private readonly int $busy_timeout_ms = self::BUSY_TIMEOUT_MS,
		private readonly bool $read_only = false,
		private readonly ?array $rows = null,
		private readonly bool $many_writers = false
	) {
		self::require_driver();
		$this->releases = null === $rows ? [] : self::releases( $rows['tables'] );
		if ( ! $read_only ) {
			Config::ensure_path( \dirname( $path ) );
		}
		try {
			$this->db = $read_only ? $this->db() : $this->connect();
		} catch ( \PDOException $e ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; Table_Node::open() escapes the wrapped message once.
			throw new \RuntimeException( "sqlite backend could not open {$path}: " . Driver_Error::of( $e ), 0, $e );
		}
	}

	/**
	 * See Durable_Arm::vacuum(); the checkpoint returns the WAL's pages too.
	 *
	 * @throws \RuntimeException When the driver refuses the VACUUM, or a
	 *                           reader keeps the checkpoint from finishing.
	 */
	public function vacuum(): void {
		try {
			$this->handle()->exec( 'VACUUM' );
			$row = $this->single_row( 'PRAGMA wal_checkpoint(TRUNCATE)' );
		} catch ( \PDOException $e ) {
			$this->failure = Driver_Error::of( $e );
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; the verb reporting it escapes at its view.
			throw new \RuntimeException( $this->last_failure(), 0, $e );
		}
		if ( ! \is_array( $row ) || 0 !== Core::as_int( $row[0] ) ) {
			$this->failure = 'database is locked: a reader holds the WAL';
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; the verb reporting it escapes at its view.
			throw new \RuntimeException( $this->last_failure() );
		}
	}

	/**
	 * One PASSIVE checkpoint: copy back every WAL frame no reader's snapshot
	 * still needs, waiting on no reader and blocking none. Frames past an
	 * open reader's snapshot stay for the next call, which is ordinary.
	 *
	 * @return array{0: int, 1: int}|null The WAL's frames and the frames now
	 *                                    written back; null when it failed,
	 *                                    which is logged.
	 */
	public function checkpoint(): ?array {
		try {
			$row = $this->single_row( 'PRAGMA wal_checkpoint(PASSIVE)' );
		} catch ( \PDOException $e ) {
			$this->failure = Driver_Error::of( $e );
			Core::print_less_often( 'Table checkpoint failed: ', $this->last_failure() );
			return null;
		}
		$row = \is_array( $row ) ? $row : [];
		return [ \max( 0, Core::as_int( $row[1] ?? 0 ) ), \max( 0, Core::as_int( $row[2] ?? 0 ) ) ];
	}

	/**
	 * What one SQLite database takes in all: the byte length and the allocated
	 * disk, each summed over the files `file_sizes()` names.
	 *
	 * @param string $path The database file.
	 * @return array{bytes:int,disk:int}
	 */
	public static function footprint( string $path ): array {
		return self::totals( self::file_sizes( $path ) );
	}

	/**
	 * Write one batch of row ops in one `BEGIN IMMEDIATE` transaction. An op
	 * is `[ verb, table, row, then?, ids? ]`, its row positional in the
	 * table's declared column order. `insert` writes the row; `ignore` writes
	 * it unless its key exists, and on a table with an `autoincrement` column
	 * resolves the row's id, inserted or found; `add` writes it or folds its
	 * `add` columns onto the row its key names; `set` writes it or replaces
	 * every column of the row its key names but the key and the
	 * `autoincrement` id, which rows elsewhere name. `then` ops run only when
	 * their op wrote its row, so a replayed batch adds nothing twice. `ids` fills a
	 * row position with the id an earlier `ignore` in the batch resolved,
	 * named by its batch index, so one batch can name a row it creates.
	 *
	 * @param list<array<array-key,mixed>> $batch The ops, each a Row_Op, as a
	 *                                     request carries them.
	 * @return int Rows written or folded.
	 * @throws \RuntimeException Naming the table and SQLite's message; the
	 *                           whole batch is rolled back.
	 * @api The row tables' one write path.
	 */
	public function write_rows( array $batch ): int {
		$table = '';
		try {
			return $this->write_scope(
				function () use ( $batch, &$table ): int {
					$written = 0;
					$ids     = [];
					foreach ( $batch as $index => $op ) {
						[ $rows, $id ] = $this->write_op( $op, $ids, $table );
						$written      += $rows;
						if ( null !== $id ) {
							$ids[ $index ] = $id;
						}
					}
					return $written;
				}
			);
		} catch ( \PDOException $e ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; the node wrapping it escapes the message once.
			throw new \RuntimeException( ( '' === $table ? $this->path : $table ) . ': ' . Driver_Error::of( $e ), 0, $e );
		}
	}

	/**
	 * Write one op and, when it wrote its row, its `then` ops.
	 *
	 * @param array<array-key,mixed> $op    The op.
	 * @param array<int,int>         $ids   Ids the batch's ignores resolved, by index.
	 * @param string                 $table Set to the table being written.
	 * @return array{0:int, 1:int|null} Rows written, and an `ignore`'s id.
	 * @throws \RuntimeException On an undeclared table or an id no op resolved.
	 */
	private function write_op( array $op, array $ids, string &$table ): array {
		$verb  = Core::as_string( $op[0] ?? null );
		$table = Core::as_string( $op[1] ?? null );
		$row   = Core::arr( $op[2] ?? null );
		$spec  = $this->rows['tables'][ $table ] ?? throw new \RuntimeException( "{$table}: no such row table" );
		if ( ! \in_array( $verb, self::ROW_OPS, true ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; the node wrapping it escapes the message once.
			throw new \RuntimeException( "{$table}: no such row op {$verb}" );
		}
		foreach ( Core::arr( $op[4] ?? null ) as $position => $from ) {
			$from = Core::as_int( $from );
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; the node wrapping it escapes the message once.
			$row[ $position ] = $ids[ $from ] ?? throw new \RuntimeException( "{$table}: batch op {$from} resolved no id" );
		}
		$stmt = $this->statement( $this->row_sql( $verb, $table, $spec ) );
		$stmt->execute( \array_values( $row ) );
		$written = $stmt->rowCount();
		$id      = 'ignore' === $verb && isset( $spec['autoincrement'] ) ? $this->resolved_id( $table, $spec, $row, $written ) : null;
		if ( 1 === $written ) {
			foreach ( Core::arr( $op[3] ?? null ) as $then ) {
				$written += $this->write_op( Core::arr( $then ), $ids, $table )[0];
			}
		}
		return [ $written, $id ];
	}

	/**
	 * The `autoincrement` id of the row an `ignore` inserted, or of the row
	 * whose key it found.
	 *
	 * @param string             $table   The table.
	 * @param Row_Spec           $spec    Its declaration.
	 * @param array<array-key,mixed> $row The row the ignore wrote.
	 * @param int                $written Rows the ignore inserted.
	 * @return int The id.
	 * @throws \RuntimeException When no row holds the key.
	 */
	private function resolved_id( string $table, array $spec, array $row, int $written ): int {
		if ( 1 === $written ) {
			return Core::as_int( $this->handle()->lastInsertId() );
		}
		if ( ! isset( $this->key_positions[ $table ] ) ) {
			$positions                     = \array_flip( \array_keys( $spec['columns'] ) );
			$this->key_positions[ $table ] = \array_map( static fn ( string $column ): int => $positions[ $column ], $spec['key'] ?? [] );
		}
		$stmt = $this->statement( $this->row_sql( 'id', $table, $spec ) );
		$stmt->execute( \array_map( static fn ( int $at ): mixed => $row[ $at ] ?? null, $this->key_positions[ $table ] ) );
		$found = $stmt->fetchAll( \PDO::FETCH_COLUMN );
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; the node wrapping it escapes the message once.
		return Core::as_int( $found[0] ?? throw new \RuntimeException( "{$table}: an ignored row holds no id" ) );
	}

	/**
	 * One statement's SQL for a declared table, built once: `insert`,
	 * `ignore`, `add` and `set` write a row, and `id` reads an existing row's
	 * `autoincrement` id by its key.
	 *
	 * @param string   $op    The statement.
	 * @param string   $table The table.
	 * @param Row_Spec $spec  Its declaration.
	 * @return string The SQL.
	 * @throws \RuntimeException On an op no statement answers, or a `set` on a
	 *                           table declaring no key or no column beside
	 *                           its key and `autoincrement` id.
	 */
	private function row_sql( string $op, string $table, array $spec ): string {
		if ( isset( $this->row_sql[ "{$op} {$table}" ] ) ) {
			return $this->row_sql[ "{$op} {$table}" ];
		}
		$columns  = \array_keys( $spec['columns'] );
		$settable = \array_diff( $columns, $spec['key'] ?? [], [ $spec['autoincrement'] ?? '' ] );
		if ( 'set' === $op && empty( $spec['key'] ) ) {
			throw new \RuntimeException( "{$table}: no key to set by" );
		}
		if ( 'set' === $op && [] === $settable ) {
			throw new \RuntimeException( "{$table}: no column to set" );
		}
		$t       = self::quote( $table );
		$key     = self::quoted_list( $spec['key'] ?? [] );
		$insert  = "INSERT INTO {$t} ( " . self::quoted_list( $columns ) . ' ) VALUES ( ' . \implode( ', ', \array_fill( 0, \count( $columns ), '?' ) ) . ' )';
		return $this->row_sql[ "{$op} {$table}" ] = match ( $op ) {
			'insert'      => $insert,
			'ignore'      => "{$insert} ON CONFLICT ( {$key} ) DO NOTHING",
			'add'         => "{$insert} ON CONFLICT ( {$key} ) DO UPDATE SET " . \implode( ', ', \array_map( static fn ( string $c, string $how ): string => self::fold( $c, $how, $spec['columns'][ $c ] ), \array_keys( $spec['add'] ?? [] ), $spec['add'] ?? [] ) ),
			'set'         => "{$insert} ON CONFLICT ( {$key} ) DO UPDATE SET " . \implode( ', ', \array_map( static fn ( string $c ): string => self::quote( $c ) . ' = excluded.' . self::quote( $c ), $settable ) ),
			'id'          => 'SELECT ' . self::quote( $spec['autoincrement'] ?? '' ) . " FROM {$t} WHERE " . \implode( ' AND ', \array_map( static fn ( string $c ): string => self::quote( $c ) . ' = ?', $spec['key'] ?? [] ) ),
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; the node wrapping it escapes the message once.
			default       => throw new \RuntimeException( "{$table}: no such row op {$op}" ),
		};
	}

	/**
	 * One `add` column's fold onto the row its key names: `sum` adds, `max`
	 * keeps the larger and `min` the smaller. A null never displaces a value,
	 * where SQLite's own two-argument MAX() and MIN() answer null. A numeric
	 * column's incoming value is cast to NUMERIC, which applies the column's
	 * own affinity: on a table keyed by one INTEGER column, its rowid alias,
	 * `excluded` carries the bound text of a float, and text outranks
	 * any number. No other fold has a statement.
	 *
	 * @param string            $column The column.
	 * @param 'sum'|'max'|'min' $how    The fold.
	 * @param string            $type   The column's declared type.
	 * @return string The SET clause.
	 */
	private static function fold( string $column, string $how, string $type ): string {
		$c        = self::quote( $column );
		$numeric  = \str_starts_with( $type, 'INTEGER' ) || \str_starts_with( $type, 'REAL' );
		$incoming = $numeric ? "CAST( excluded.{$c} AS NUMERIC )" : "excluded.{$c}";
		$pick     = static fn ( string $function ): string => "CASE WHEN {$c} IS NULL THEN {$incoming} WHEN {$incoming} IS NULL THEN {$c} ELSE {$function}( {$c}, {$incoming} ) END";
		return "{$c} = " . match ( $how ) {
			'sum' => "{$c} + excluded.{$c}",
			'max' => $pick( 'MAX' ),
			'min' => $pick( 'MIN' ),
		};
	}

	/**
	 * See Durable_Arm::purge(); with what the limit leaves, each row table's
	 * rows past their `retain` window, each table in its own transaction with
	 * the names its purge releases. A table whose purge fails is rolled back
	 * and logged, and the rows earlier tables gave up still count. The purge
	 * is full when any table filled its share, or the limit ran out before a
	 * table was read, because a share is a fraction of the limit and the rows
	 * alone never reach it.
	 *
	 * @param int $now   Epoch second.
	 * @param int $limit Most rows to delete, every table together.
	 * @return array{rows:int, full:bool}
	 */
	public function purge( int $now, int $limit ): array {
		[ 'rows' => $purged, 'full' => $full ] = parent::purge( $now, $limit );
		foreach ( $this->retained() as $table => $retain ) {
			if ( $purged >= $limit ) {
				$full = true;
				break;
			}
			try {
				[ $rows, $filled ] = $this->write_scope( fn (): array => $this->purge_retained( $table, $retain, $now, $limit - $purged ) );
			} catch ( \PDOException $e ) {
				$this->failure = Driver_Error::of( $e );
				Core::print_less_often( 'Table purge failed: ', $this->last_failure() );
				break;
			}
			$purged += $rows;
			$full    = $full || $filled;
		}
		return [
			'rows' => $purged,
			'full' => $full,
		];
	}

	/** See Cache_Backend::last_failure(). */
	public function last_failure(): string {
		return "sqlite {$this->path}: {$this->failure}";
	}

	/**
	 * Delete one table's rows past its `retain` window, then release the
	 * names they named. Only the values the deleted rows returned are
	 * examined, so the work is bounded by what retention deletes, never by
	 * the size of a names table. The table deletes up to `$budget` over one
	 * plus every release its deletions can reach, so the cascade fits too.
	 *
	 * @param string                      $table  The table purged.
	 * @param array{0:string,1:int,2:int} $retain Its `retain`.
	 * @param int                         $now    Epoch second.
	 * @param int                         $budget Most rows, names included.
	 * @return array{0:int, 1:bool} Rows deleted, and whether the table's own
	 *                              filled its share, so more may wait.
	 */
	private function purge_retained( string $table, array $retain, int $now, int $budget ): array {
		$take = \intdiv( $budget, 1 + $this->releases[ $table ]['reach'] );
		if ( 0 === $take ) {
			return [ 0, true ];
		}
		$returning = $this->releases[ $table ]['returning'];
		$stmt      = $this->statement( $this->retain_sql( $table, $retain[0], $returning ) );
		$stmt->bindValue( 1, self::retain_floor( $retain, $now ), \PDO::PARAM_INT );
		$stmt->bindValue( 2, $take, \PDO::PARAM_INT );
		[ $deleted, $gone ] = self::deleted( $stmt, $returning );
		return [ $deleted + $this->release( $table, $gone ), $take === $deleted ];
	}

	/**
	 * Release the names rows the deleted rows of `$table` named and no row
	 * of any table they are `retained_by` still names, then, in turn, the
	 * names the released rows alone named.
	 *
	 * @param string       $table The table rows left.
	 * @param array<mixed> $gone  The deleted rows, as the columns they returned.
	 * @return int Rows released, the cascade's included.
	 */
	private function release( string $table, array $gone ): int {
		$released = 0;
		foreach ( $this->releases[ $table ]['names'] as $names => $by_own ) {
			foreach ( $by_own as $own => $columns ) {
				$ids = [];
				foreach ( $columns as $column ) {
					$ids = [ ...$ids, ...\array_filter( \array_column( $gone, $column ), static fn ( mixed $id ): bool => null !== $id ) ];
				}
				if ( [] === $ids ) {
					continue;
				}
				$stmt = $this->statement( $this->release_sql( $names, $own ) );
				$stmt->bindValue( 1, (string) \wp_json_encode( $ids ) );
				[ $deleted, $freed ] = self::deleted( $stmt, $this->releases[ $names ]['returning'] );
				$released           += $deleted + $this->release( $names, $freed );
			}
		}
		return $released;
	}

	/**
	 * Run a bound DELETE, counting its rows and keeping what it returned.
	 *
	 * @param \PDOStatement $stmt      The bound statement.
	 * @param list<string>  $returning The columns it returns, if any.
	 * @return array{0:int, 1:array<mixed>} The rows deleted, and what they returned.
	 */
	private static function deleted( \PDOStatement $stmt, array $returning ): array {
		$stmt->execute();
		$gone = $stmt->fetchAll( \PDO::FETCH_ASSOC );
		// pdo_sqlite counts no changes for a statement with RETURNING.
		return [ [] === $returning ? $stmt->rowCount() : \count( $gone ), $gone ];
	}

	/**
	 * A names table's release on its own column: delete its rows holding one
	 * of a JSON array of released values that no row of any table it is
	 * `retained_by` still names, returning the columns its own names tables
	 * reference.
	 *
	 * @param string $names The names table.
	 * @param string $own   Its column the values match.
	 * @return string The SQL.
	 */
	private function release_sql( string $names, string $own ): string {
		$n         = self::quote( $names );
		$returning = $this->releases[ $names ]['returning'];
		return $this->row_sql[ "release {$names} {$own}" ] ??= "DELETE FROM {$n} WHERE " . self::quote( $own ) . ' IN ( SELECT value FROM json_each( ? ) )'
			. \implode(
				'',
				\array_map(
					static fn ( array $by ): string => ' AND NOT EXISTS ( SELECT 1 FROM ' . self::quote( $by[0] ) . ' AS ref WHERE ref.' . self::quote( $by[1] ) . " = {$n}." . self::quote( $by[2] ) . ' )',
					$this->rows['tables'][ $names ]['retained_by'] ?? []
				)
			)
			. ( [] === $returning ? '' : ' RETURNING ' . self::quoted_list( $returning ) );
	}

	/**
	 * A table's retention DELETE, returning the columns its names tables
	 * reference; binds the floor, then the most rows.
	 *
	 * @param string       $table     The table.
	 * @param string       $column    Its `retain` column.
	 * @param list<string> $returning Columns names tables reference.
	 * @return string The SQL.
	 */
	private function retain_sql( string $table, string $column, array $returning ): string {
		$t = self::quote( $table );
		return $this->row_sql[ "retain {$table}" ] ??= "DELETE FROM {$t} WHERE rowid IN ( SELECT rowid FROM {$t} WHERE " . self::quote( $column ) . ' < ? LIMIT ? )'
			. ( [] === $returning ? '' : ' RETURNING ' . self::quoted_list( $returning ) );
	}

	/**
	 * Open a reader across row-table files: a `:memory:` main with each
	 * present file at `$version` attached read-only as `p{partition}`, each
	 * with an 8 MiB page cache and mapped, and the connection set
	 * `query_only` with its temporary B-trees in memory. A file absent, or
	 * at another version, is not attached, so the reader's aliases name
	 * only the files it holds. Those B-trees take SQLite's `malloc`, outside
	 * PHP's `memory_limit`: deduplicating 740,000 32-character keys, a day's
	 * distinct URLs across eln's four partitions, grows the process 32 MB.
	 *
	 * @param array<int,string> $files   Partition => file.
	 * @param int               $version The schema version a file must carry.
	 * @return Row_Reader The connection and the aliases it attached.
	 * @throws \LogicException Without pdo_sqlite.
	 * @throws \RuntimeException In a process running as root.
	 * @throws \PDOException When a present file will not attach.
	 * @api The row tables' one read path.
	 */
	public static function open_rows( array $files, int $version ): Row_Reader {
		self::require_driver();
		self::refuse_root_reader( \implode( ', ', $files ) );
		$db = new \PDO( 'sqlite::memory:', null, null, [ \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION ] );
		$db->exec( 'PRAGMA busy_timeout = ' . self::BUSY_TIMEOUT_MS );
		$db->exec( 'PRAGMA temp_store = MEMORY' );
		$aliases = self::attach_all( $db, $files, $version );
		$db->exec( 'PRAGMA query_only = ON' );
		return new Row_Reader( $db, $aliases );
	}

	/**
	 * Open a connection that builds a new SQLite file from the row tables:
	 * `$file` as a writable `main`, journal off, with a 256 MiB page cache and
	 * mapped, each present partition file attached read-only as `open_rows()`
	 * attaches it, and temporary B-trees in memory. The caller publishes the
	 * file; a crash leaves it unpublished.
	 *
	 * @param string            $file    The file to build, absent or empty.
	 * @param array<int,string> $files   Partition => file.
	 * @param int               $version The schema version a partition file must carry.
	 * @return Row_Reader The writable connection and the aliases it attached.
	 * @throws \LogicException Without pdo_sqlite.
	 * @throws \RuntimeException In a process running as root.
	 * @throws \PDOException When `$file` will not open or a partition will not attach.
	 * @api The row tables' one build path.
	 */
	public static function build_rows( string $file, array $files, int $version ): Row_Reader {
		self::require_driver();
		self::refuse_root_reader( \implode( ', ', [ $file, ...\array_values( $files ) ] ) );
		$db = new \PDO( 'sqlite:' . $file, null, null, [ \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION ] );
		$db->exec( 'PRAGMA busy_timeout = ' . self::BUSY_TIMEOUT_MS );
		$db->exec( 'PRAGMA journal_mode = OFF' );
		$db->exec( 'PRAGMA synchronous = OFF' );
		$db->exec( 'PRAGMA main.cache_size = -' . self::BUILD_CACHE_KIB );
		$db->exec( 'PRAGMA main.mmap_size = ' . self::ROWS_MMAP_BYTES );
		$db->exec( 'PRAGMA temp_store = MEMORY' );
		return new Row_Reader( $db, self::attach_all( $db, $files, $version ) );
	}

	/**
	 * Attach each present file at `$version` to `$db` read-only as
	 * `p{partition}`; a file absent, or at another version, is not attached.
	 *
	 * @param \PDO              $db      The connection.
	 * @param array<int,string> $files   Partition => file.
	 * @param int               $version The schema version a file must carry.
	 * @return list<string> The aliases attached, in partition order.
	 * @throws \PDOException When a present file will not attach.
	 */
	private static function attach_all( \PDO $db, array $files, int $version ): array {
		$aliases = [];
		foreach ( $files as $partition => $path ) {
			\clearstatcache( true, $path );
			if ( \file_exists( $path ) && self::attach_read_only( $db, $path, "p{$partition}", $version ) ) {
				$aliases[] = "p{$partition}";
			}
		}
		return $aliases;
	}

	/**
	 * Attach the file at `$path` to `$db` as `$schema`, read-only through
	 * `read_only_uri()`. It creates nothing. A file at another `user_version`
	 * is detached again.
	 *
	 * @param \PDO   $db      The connection.
	 * @param string $path    The database file.
	 * @param string $schema  The name the connection reads it under.
	 * @param int    $version The schema version it must carry.
	 * @return bool Whether the file stays attached.
	 * @throws \PDOException When the file will not attach.
	 */
	private static function attach_read_only( \PDO $db, string $path, string $schema, int $version ): bool {
		$attach = $db->prepare( "ATTACH DATABASE ? AS {$schema}" );
		$attach->execute( [ self::read_only_uri( $path ) ] );
		if ( $version !== self::user_version( $db, $schema ) ) {
			$db->exec( "DETACH DATABASE {$schema}" );
			return false;
		}
		$db->exec( "PRAGMA {$schema}.cache_size = -" . self::ROWS_CACHE_KIB );
		$db->exec( "PRAGMA {$schema}.mmap_size = " . self::ROWS_MMAP_BYTES );
		return true;
	}

	/**
	 * Refuse a sqlite process running as root: SQLite adds files beside a
	 * database it opens, `-wal` and `-shm` beside a WAL file, and a build
	 * writes its own file, and root's would lock the file's worker out.
	 * Running as root is for the operator to fix, never a backend to degrade
	 * past, so the refusal is a plain \RuntimeException.
	 *
	 * @api Read before its arm opens by a mounted Table, or one many processes write.
	 * @param string $path The files the process would open, comma-joined.
	 * @throws \RuntimeException In a process running as root.
	 */
	public static function refuse_root_reader( string $path ): void {
		if ( 0 === CLI::uid() ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; the node wrapping it escapes the message once.
			throw new \RuntimeException( "sqlite refuses to run as root: a root process leaves files beside {$path} that its worker cannot open" );
		}
	}

	/**
	 * Open a file nothing writes again: read-only and `immutable`, so the
	 * reader takes no lock and reads no journal, mapped, and `query_only`.
	 * The one `main` alias names it. `Row_Table_Node::open_snapshot()` is
	 * the snapshot entry, resolving a snapshot's name to the file.
	 *
	 * @param string $file The file.
	 * @return Row_Reader The query-only connection, aliased `main`.
	 * @throws \LogicException Without pdo_sqlite.
	 * @throws \PDOException When the file is absent or no database.
	 * @api Opened by `Row_Table_Node::open_snapshot()`.
	 */
	public static function open_immutable( string $file ): Row_Reader {
		self::require_driver();
		$db = new \PDO( 'sqlite:' . self::read_only_uri( $file ) . '&immutable=1', null, null, [ \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION ] );
		$db->exec( 'PRAGMA main.cache_size = -' . self::ROWS_CACHE_KIB );
		$db->exec( 'PRAGMA main.mmap_size = ' . self::ROWS_MMAP_BYTES );
		$db->exec( 'PRAGMA query_only = ON' );
		// Read a page now, so an absent file or no database throws at open.
		$db->query( 'SELECT 1 FROM sqlite_master LIMIT 1' );
		return new Row_Reader( $db, [ 'main' ] );
	}

	/**
	 * The `file:` URI that opens `$path` read-only, `mode=ro`, with the three
	 * characters a URI path reserves escaped; it creates nothing. Every
	 * connection PDO opens reads a URI, except under `open_basedir`, where
	 * PDO denies it.
	 *
	 * @param string $path The database file.
	 * @return string The URI, ending in its `?mode=ro` query.
	 */
	private static function read_only_uri( string $path ): string {
		return 'file:' . \strtr( $path, [ '%' => '%25', '?' => '%3f', '#' => '%23' ] ) . '?mode=ro';
	}

	/**
	 * Refuse a host without pdo_sqlite, read through the `$available` seam.
	 *
	 * @throws \LogicException Without pdo_sqlite.
	 */
	private static function require_driver(): void {
		if ( ! ( self::$available ?? static fn (): bool => \extension_loaded( 'pdo_sqlite' ) )() ) {
			throw new \LogicException( 'sqlite backend needs the pdo_sqlite extension' );
		}
	}

	/**
	 * Unlink a database with its `-wal` and `-shm`, whichever stand.
	 *
	 * @param string $path The database file.
	 * @return list<string> The files unlinked.
	 * @throws \UnexpectedValueException On a file that will not unlink.
	 */
	public static function remove_database( string $path ): array {
		$sizes = self::file_sizes( $path );
		self::unlink_files( $sizes );
		return \array_keys( $sizes );
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
	 * Every name one row table's DDL takes in the file's one namespace: the
	 * table, its indexes, and with an `fts` shadow the shadow, the tables
	 * FTS5 keeps beside it, and its triggers.
	 *
	 * @api Read by the node that checks a schema before its file opens.
	 * @param string   $table The table.
	 * @param Row_Spec $spec  Its declaration.
	 * @return list<string>
	 */
	public static function declared_names( string $table, array $spec ): array {
		$names = [ $table, ...\array_map( 'strval', \array_keys( $spec['indexes'] ?? [] ) ) ];
		if ( [] !== ( $spec['fts'] ?? [] ) ) {
			foreach ( [ '', ...self::FTS_TABLES, ...\array_map( static fn ( string $name ): string => "_{$name}", \array_keys( self::FTS_TRIGGERS ) ) ] as $suffix ) {
				$names[] = "{$table}_fts{$suffix}";
			}
		}
		return $names;
	}

	/**
	 * Each declared table's releases: the `retained_by` entries naming it,
	 * by names table and own column, the columns they reference, and how
	 * many releases one of its deleted rows reaches down the chain.
	 *
	 * @param array<string,Row_Spec> $tables The declared tables.
	 * @return array<string,array{returning:list<string>,reach:int,names:array<string,array<string,list<string>>>}>
	 */
	private static function releases( array $tables ): array {
		$named_by = [];
		foreach ( $tables as $names => $spec ) {
			foreach ( $spec['retained_by'] ?? [] as [ $ref, $ref_column, $own ] ) {
				$named_by[ $ref ][ $names ][ $own ][] = $ref_column;
			}
		}
		$reach    = static function ( string $table ) use ( &$reach, $named_by ): int {
			$n = 0;
			foreach ( $named_by[ $table ] ?? [] as $names => $by_own ) {
				$n += \count( \array_merge( ...\array_values( $by_own ) ) ) * ( 1 + $reach( $names ) );
			}
			return $n;
		};
		$releases = [];
		foreach ( \array_keys( $tables ) as $table ) {
			$returning = [];
			foreach ( $named_by[ $table ] ?? [] as $by_own ) {
				foreach ( $by_own as $columns ) {
					$returning = [ ...$returning, ...$columns ];
				}
			}
			$releases[ $table ] = [
				'returning' => \array_values( \array_unique( $returning ) ),
				'reach'     => $reach( $table ),
				'names'     => $named_by[ $table ] ?? [],
			];
		}
		return $releases;
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
			$stmt->execute( [ ...$chunk, self::now() ] );
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
			$stmt->execute();
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
		$stmt->execute();
		return 1 === $stmt->rowCount();
	}

	/** See Durable_Arm::delete_key(). */
	protected function delete_key( string $key ): int {
		return $this->run( 'DELETE FROM kv WHERE "key" = ? AND ' . self::LIVE, [ $key, self::now() ] );
	}

	/** See Durable_Arm::purge_rows(). */
	protected function purge_rows( int $now, int $limit ): int {
		return $this->delete_rows( self::KV_PURGE, $now, $limit );
	}

	/**
	 * See Durable_Arm::oldest_expiry(). A retained row expires the second its
	 * column falls below the floor, `( column + window + 1 ) × unit`, and
	 * that column leads an index or the key, so each `MIN()` is one seek.
	 */
	protected function oldest_expiry( int $now ): ?int {
		$expiries = [ $this->oldest( self::OLDEST_EXPIRY, $now, $now ) ];
		foreach ( $this->retained() as $table => $retain ) {
			[ $column, $window, $unit ] = $retain;
			$oldest                     = $this->oldest( 'SELECT MIN( ' . self::quote( $column ) . ' ) FROM ' . self::quote( $table ) );
			if ( null !== $oldest && $oldest < self::retain_floor( $retain, $now ) ) {
				$expiries[] = ( $oldest + $window + 1 ) * $unit;
			}
		}
		$expiries = \array_filter( $expiries, static fn ( ?int $expiry ): bool => null !== $expiry );
		return [] === $expiries ? null : \min( $expiries );
	}

	/**
	 * The lowest column value a `retain` keeps at `$now`; a row below it
	 * purges.
	 *
	 * @param array{0:string,1:int,2:int} $retain A `retain`.
	 * @param int                         $now    Epoch second.
	 * @return int The floor, in the column's unit.
	 */
	private static function retain_floor( array $retain, int $now ): int {
		return \intdiv( $now, $retain[2] ) - $retain[1];
	}

	/**
	 * Each row table that declares a `retain`, with it.
	 *
	 * @return array<string,array{0:string,1:int,2:int}> Table => its `retain`.
	 */
	private function retained(): array {
		$retained = [];
		foreach ( null === $this->rows ? [] : $this->rows['tables'] as $table => $spec ) {
			if ( isset( $spec['retain'] ) ) {
				$retained[ $table ] = $spec['retain'];
			}
		}
		return $retained;
	}

	/**
	 * The one value a `MIN()` answers, read to its end, so a cached
	 * statement holds no read snapshot open past this call.
	 *
	 * @param string $sql     The statement.
	 * @param int    ...$ints The bound values.
	 * @return int|null Null when it found no row.
	 */
	private function oldest( string $sql, int ...$ints ): ?int {
		$value = $this->bound( $sql, ...$ints )->fetchAll( \PDO::FETCH_COLUMN )[0] ?? null;
		return null === $value ? null : Core::as_int( $value );
	}

	/**
	 * See Durable_Arm::discard(): the file, not its rows. A Table partition
	 * owns its file, and its writer is the file's one writer (ADR-6), so the
	 * writer unlinks the database and its `-wal` and `-shm`, drops its
	 * connection and its prepared statements, and opens a new file with the
	 * same pragmas and tables: a cost that never grows with the rows. A mount in
	 * another process that opened the old file keeps reading its rows until
	 * that request ends; one opened after reads the new file. A file many
	 * processes write keeps its inode instead: one transaction deletes every
	 * keyed row and member, so no other writer goes on reading what was
	 * flushed or writing where no one reads.
	 *
	 * @return array{bytes:int}|array{rows:int} What the three files held
	 *         before the unlink, or the rows deleted in place.
	 * @throws \UnexpectedValueException On a reader, or a file that will not unlink.
	 */
	protected function discard(): array {
		if ( $this->read_only ) {
			throw new \UnexpectedValueException( 'a reader cannot flush' );
		}
		if ( $this->many_writers ) {
			return [ 'rows' => Core::as_int( $this->write_scope( fn (): int => (int) $this->handle()->exec( 'DELETE FROM kv' ) + (int) $this->handle()->exec( 'DELETE FROM members' ) ) ) ];
		}
		$sizes = self::file_sizes( $this->path );
		try {
			self::unlink_files( $sizes );
		} finally {
			// Reopen even on a refusal: never write into an unlinked inode.
			$this->statements  = [];
			$this->has_members = null;
			$this->db          = null;
			$this->db          = $this->connect();
		}
		return [ 'bytes' => self::totals( $sizes )['bytes'] ];
	}

	/**
	 * Sum a `file_sizes()` map.
	 *
	 * @param array<string,array{bytes:int,disk:int,mtime:int}> $sizes File => sizes.
	 * @return array{bytes:int,disk:int}
	 */
	private static function totals( array $sizes ): array {
		return [
			'bytes' => \array_sum( \array_column( $sizes, 'bytes' ) ),
			'disk'  => \array_sum( \array_column( $sizes, 'disk' ) ),
		];
	}

	/**
	 * See Durable_Arm::write_scope(): one transaction holding the write lock
	 * from its start, so a read inside sees what it writes over. This arm owns
	 * the file, so no caller's transaction shares the connection.
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

	/** See Durable_Arm::purge_member_rows(); the table has no rowid to name. */
	protected function purge_member_rows( int $now, int $limit ): int {
		return $this->delete_rows( self::MEMBERS_PURGE, $now, $limit );
	}

	/**
	 * Run one purge statement, its values bound as `bound()` binds them.
	 *
	 * @param string $sql     A purge: KV_PURGE or MEMBERS_PURGE.
	 * @param int    ...$ints The bound values, the row limit last.
	 * @return int Rows deleted.
	 */
	private function delete_rows( string $sql, int ...$ints ): int {
		return $this->bound( $sql, ...$ints )->rowCount();
	}

	/**
	 * Run one statement, each value bound as an integer in order.
	 *
	 * @param string $sql     The statement.
	 * @param int    ...$ints The bound values.
	 * @return \PDOStatement The executed statement.
	 */
	private function bound( string $sql, int ...$ints ): \PDOStatement {
		$stmt = $this->statement( $sql );
		$at   = 1;
		foreach ( $ints as $value ) {
			$stmt->bindValue( $at++, $value, \PDO::PARAM_INT );
		}
		$stmt->execute();
		return $stmt;
	}

	/** See Durable_Arm::upsert_members(); a member already there is updated in place. */
	protected function upsert_members( array $rows ): void {
		$stmt = $this->statement( self::MEMBERS_UPSERT );
		foreach ( $rows as [ $set_key, $member, $bytes, $expires ] ) {
			$stmt->bindValue( 1, $set_key );
			$stmt->bindValue( 2, $member );
			$stmt->bindValue( 3, $bytes, \PDO::PARAM_LOB );
			$stmt->bindValue( 4, $expires, \PDO::PARAM_INT );
			$stmt->execute();
		}
	}

	/** See Durable_Arm::select_member_rows(). */
	protected function select_member_rows( string $set_key, int $limit ): array {
		if ( null === $this->db() ) {
			// No file: its writer has not written, so there is nothing to read.
			return [];
		}
		// A file its writer declared before members holds none to read.
		$this->has_members ??= null !== $this->single_row( self::MEMBERS_TABLE );
		if ( ! $this->has_members ) {
			return [];
		}
		$read = $this->statement( self::MEMBERS_ROWS );
		$read->bindValue( 1, $set_key );
		$read->bindValue( 2, self::now(), \PDO::PARAM_INT );
		$read->bindValue( 3, $limit, \PDO::PARAM_INT );
		$read->execute();
		$rows = [];
		foreach ( $read->fetchAll( \PDO::FETCH_NUM ) as $row ) {
			$row    = Core::arr( $row );
			$rows[] = [ Core::as_string( $row[0] ?? null ), Core::as_string( $row[1] ?? null ), Core::as_int( $row[2] ?? null ) ];
		}
		return $rows;
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
		$stmt->execute();
		$rows = $stmt->fetchAll( \PDO::FETCH_NUM );
		return \is_array( $rows[0] ?? null ) ? $rows[0] : null;
	}

	/** See Durable_Arm::delete_member(). */
	protected function delete_member( string $set_key, string $member ): int {
		return $this->run( self::MEMBER_DELETE, [ $set_key, $member ] );
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
		$stmt->execute( $args );
		return $stmt->rowCount();
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
	 * Open the connection: read-only, or as the writer in WAL mode with the
	 * `kv` and `members` tables and any row tables declared. A writer whose
	 * file is stamped with another row version unlinks it and opens anew.
	 *
	 * @return \PDO The connection.
	 * @throws \PDOException When the file cannot open.
	 * @throws \RuntimeException When the writer cannot enter WAL mode.
	 * @throws \UnexpectedValueException When a stale file will not unlink.
	 */
	private function connect(): \PDO {
		$flags = $this->read_only ? [ \PDO::SQLITE_ATTR_OPEN_FLAGS => \PDO::SQLITE_OPEN_READONLY ] : [];
		$db    = new \PDO( 'sqlite:' . $this->path, null, null, [ \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION ] + $flags );
		$db->exec( 'PRAGMA busy_timeout = ' . \max( 1, $this->busy_timeout_ms ) );
		if ( ! $this->read_only && null !== $this->rows && self::stamped_otherwise( $db, $this->rows['version'] ) ) {
			$db = null;
			self::unlink_files( self::file_sizes( $this->path ) );
			return $this->connect();
		}
		if ( $this->read_only ) {
			try {
				$db->exec( self::CACHE_PRAGMA );
			} catch ( \PDOException ) {
				// It reads the schema; a non-database file fails each read.
				return $db;
			}
			return $db;
		}
		$mode = $db->prepare( 'PRAGMA journal_mode = WAL' );
		$mode->execute();
		if ( 'wal' !== $mode->fetchColumn() ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; Table_Node::open() escapes the wrapped message once.
			throw new \RuntimeException( "sqlite backend could not enter WAL mode at {$this->path}" );
		}
		$db->exec( 'PRAGMA synchronous = NORMAL' );
		if ( ! $this->many_writers ) {
			$db->exec( 'PRAGMA wal_autocheckpoint = 0' );
		}
		$db->exec( 'PRAGMA journal_size_limit = ' . self::WAL_LIMIT_BYTES );
		$db->exec( self::CACHE_PRAGMA );
		foreach ( self::KV_DDL as $sql ) {
			$db->exec( $sql );
		}
		$this->has_members = true;
		if ( null !== $this->rows ) {
			self::declare_rows( $db, $this->rows );
		}
		return $db;
	}

	/**
	 * Declare each row table — its columns, key, indexes and FTS5 shadow with
	 * the triggers keeping it in step — then stamp the file's version.
	 *
	 * @param \PDO $db   The writer's connection.
	 * @param Rows $rows The declaration.
	 */
	private static function declare_rows( \PDO $db, array $rows ): void {
		foreach ( $rows['tables'] as $table => $spec ) {
			foreach ( self::table_ddl( $table, $spec ) as $sql ) {
				$db->exec( $sql );
			}
		}
		$db->exec( 'PRAGMA user_version = ' . $rows['version'] );
	}

	/**
	 * One row table's DDL. An `autoincrement` column is its INTEGER PRIMARY
	 * KEY and its key a UNIQUE constraint; without one the key is the
	 * PRIMARY KEY. An FTS5 table `{table}_fts` over the `fts` columns reads
	 * its content from the table by the `autoincrement` id, and triggers on
	 * insert and delete keep its index in step; no op updates those columns.
	 *
	 * @param string   $table The table.
	 * @param Row_Spec $spec  Its declaration.
	 * @return list<string> The statements.
	 * @throws \LogicException On an FTS shadow with no autoincrement column.
	 */
	private static function table_ddl( string $table, array $spec ): array {
		$t    = self::quote( $table );
		$auto = $spec['autoincrement'] ?? null;
		$defs = [];
		foreach ( $spec['columns'] as $column => $type ) {
			$defs[] = self::quote( $column ) . ' ' . ( $column === $auto ? 'INTEGER PRIMARY KEY' : $type );
		}
		if ( [] !== ( $spec['key'] ?? [] ) ) {
			$defs[] = ( null === $auto ? 'PRIMARY KEY' : 'UNIQUE' ) . ' ( ' . self::quoted_list( $spec['key'] ) . ' )';
		}
		$ddl = [ "CREATE TABLE IF NOT EXISTS {$t} ( " . \implode( ', ', $defs ) . ' )' ];
		foreach ( $spec['indexes'] ?? [] as $index => $columns ) {
			$ddl[] = 'CREATE INDEX IF NOT EXISTS ' . self::quote( $index ) . " ON {$t} ( " . self::quoted_list( $columns ) . ' )';
		}
		$fts = $spec['fts'] ?? [];
		if ( [] === $fts ) {
			return $ddl;
		}
		$id      = self::quote( $auto ?? throw new \LogicException( "{$table}: an fts shadow needs an autoincrement column" ) );
		$shadow  = self::quote( "{$table}_fts" );
		$columns = self::quoted_list( $fts );
		$of      = static fn ( string $row ): string => \implode( ', ', \array_map( static fn ( string $c ): string => "{$row}." . self::quote( $c ), $fts ) );
		$add     = "INSERT INTO {$shadow} ( rowid, {$columns} ) VALUES ( new.{$id}, {$of( 'new' )} );";
		$drop    = "INSERT INTO {$shadow} ( {$shadow}, rowid, {$columns} ) VALUES ( 'delete', old.{$id}, {$of( 'old' )} );";
		$ddl[]   = "CREATE VIRTUAL TABLE IF NOT EXISTS {$shadow} USING fts5( {$columns}, content='" . \str_replace( "'", "''", $table ) . "', content_rowid='" . \str_replace( "'", "''", $auto ) . "' )";
		foreach ( self::FTS_TRIGGERS as $name => $when ) {
			$body  = 'insert' === $name ? $add : $drop;
			$ddl[] = 'CREATE TRIGGER IF NOT EXISTS ' . self::quote( "{$table}_fts_{$name}" ) . " {$when} ON {$t} BEGIN {$body} END";
		}
		return $ddl;
	}

	/**
	 * Names as a comma-separated list of quoted identifiers.
	 *
	 * @param list<string> $names The names.
	 * @return string The list.
	 */
	private static function quoted_list( array $names ): string {
		return \implode( ', ', \array_map( self::quote( ... ), $names ) );
	}

	/**
	 * A name as a quoted SQL identifier.
	 *
	 * @param string $name The name.
	 * @return string The identifier.
	 */
	private static function quote( string $name ): string {
		return '"' . \str_replace( '"', '""', $name ) . '"';
	}

	/**
	 * The files one SQLite database is made of — the database, its `-wal` and
	 * its `-shm` — each on disk now, with its `Core::file_footprint()`.
	 *
	 * @param string $path The database file.
	 * @return array<string,array{bytes:int,disk:int,mtime:int}> File => sizes; a file not on disk is absent.
	 */
	public static function file_sizes( string $path ): array {
		$sizes = [];
		foreach ( [ $path, "{$path}-wal", "{$path}-shm" ] as $file ) {
			$footprint = Core::file_footprint( $file );
			if ( null !== $footprint ) {
				$sizes[ $file ] = $footprint;
			}
		}
		return $sizes;
	}

	/**
	 * Unlink the files a `file_sizes()` map names.
	 *
	 * @param array<string,array{bytes:int,disk:int,mtime:int}> $sizes File => sizes.
	 * @throws \UnexpectedValueException On a file that will not unlink.
	 */
	private static function unlink_files( array $sizes ): void {
		foreach ( \array_keys( $sizes ) as $file ) {
			if ( ! @\unlink( $file ) ) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
				throw new \UnexpectedValueException( "could not unlink {$file}" );
			}
		}
	}

	/**
	 * Whether the writer's file is stamped with a version other than
	 * `$version`, so it must be discarded whatever tables it holds. An
	 * unstamped file, 0, holds no row tables and is kept.
	 *
	 * @param \PDO $db      The writer's connection.
	 * @param int  $version The declared version.
	 * @return bool True when it must.
	 */
	private static function stamped_otherwise( \PDO $db, int $version ): bool {
		$at = self::user_version( $db, 'main' );
		return 0 !== $at && $version !== $at;
	}

	/**
	 * The `user_version` an open schema is stamped with; 0 when unstamped.
	 *
	 * @param \PDO   $db     The connection.
	 * @param string $schema `main`, or an attached file's alias.
	 * @return int The version.
	 */
	private static function user_version( \PDO $db, string $schema ): int {
		$read = $db->prepare( "PRAGMA {$schema}.user_version" );
		$read->execute();
		return Core::as_int( $read->fetchColumn() );
	}
}
