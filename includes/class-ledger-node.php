<?php
/**
 * Ledger
 *
 * Write-once rows clustered by time, in one SQLite file per partition,
 * `{base}/ledgers/{name}.p{N}.sqlite`, whose one writer is partition N's
 * worker (ADR-6). A row is `( t, k, x, s, c0… )`: `t` the epoch second of the
 * data point, `k` a whitespace-free key, `x` a text member (`''` when
 * unused), `s` the writer's row sequence, and one REAL per declared column:
 * NOT NULL for a `sum`, and null in a `min` or `max` for a value not
 * measured, which the aggregate skips. The primary key `( t, k, x, s )` is
 * the whole index, in a `WITHOUT ROWID` table, so rows sit in time order and
 * a flush's rows dirty the few pages at the right edge. A row is never
 * updated: a second row for one `( t, k, x )`, in one file or two, is a
 * delta, and every read aggregates the rows it finds by the aggregate its
 * column declares. A Ledger declaring no columns is a set, keyed `( t, k, x )`
 * alone, where an append of a row its file holds stores nothing. Nothing
 * deletes a row but the segment drop and `flush()`, which drops the `rows`
 * table and declares it anew in one transaction, never unlinking the file
 * other partitions attach.
 *
 * The lineage is Tachikoma's. Its `Table` files each value into the window of
 * its own timestamp (`window_size`, `num_buckets`), which is the time
 * clustering; its `Partition` ages data out by the segment past a lifespan,
 * never by the record, which is the retention: `segment_seconds ×
 * num_segments` on the wall clock. An APPEND row whose `t` is already past
 * the lifespan is dropped and counted, never stored.
 *
 * The writer opens its own file as `main` in `arguments()`, through
 * `Sqlite_Arm::open_database()`, and attaches every other partition's file
 * read-only as `p{N}`, so no write of one partition waits on another's lock.
 * It answers the TM_REQUEST|TM_STRUCT `APPEND` TO its FROM (ADR-23), one
 * transaction a request; `append()` is the same write for a caller outside a
 * graph. The reads `SUM`, `TOP` and `MEMBERS` answer the same way, each over
 * `from ≤ t < to` and every partition's rows in one statement: one arm per
 * file, walking its own `t`, the arms joined by UNION ALL and aggregated as
 * one. Each read first brings the attached files to those on disk, so a
 * partition that comes up is read from its first file on, and one gone
 * reads as empty. The SQL is built from the declaration alone: a column a
 * request names is looked up in it, and a name it does not hold, or a use
 * its aggregate has no meaning for, is refused. A request graph reads
 * through `mount()`, an in-memory connection under the Ledger's own name
 * attaching every file, which answers the reads and refuses APPEND.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Ledger node — `make_node Ledger <name> <segment_seconds> <num_segments> <column>[:sum|min|max] …`.
 */
final class Ledger_Node extends Node implements Tick_Housekeeper {
	use Schema_Reflection;
	use Verb_Stats;

	/**
	 * How long a write waits on another connection's write lock, in
	 * milliseconds: a `tables flush` from the CLI under the fleet hold, the
	 * one other writer a partition's file has.
	 */
	public const BUSY_TIMEOUT_MS = 5000;

	/**
	 * Partition files one connection reads at most: SQLite's default
	 * SQLITE_MAX_ATTACHED, which a mount spends whole, one file each. A Ledger
	 * with more refuses to open rather than read a subset.
	 */
	public const ATTACH_LIMIT = 10;

	/**
	 * Rows one segment-drop statement deletes at most: a batch the tick's
	 * budget can stop between, where a whole segment in one statement would
	 * hold the tick for as long as its rows take.
	 */
	public const DROP_BATCH_ROWS = 20000;

	/** Most rows one TOP answers: a page, never a dump of every member. */
	public const TOP_LIMIT_MAX = Sqlite_Arm::IN_CHUNK;

	/**
	 * Most members one MEMBERS answers before it answers over: the Table's
	 * SMEMBERS ceiling, since both serve one reader, event-logger-nodes' URL
	 * search, which shows at most 5,000.
	 */
	public const MEMBERS_LIMIT_MAX = Table_Node::MAX_MEMBERS_LIMIT;

	/** The aggregate a column naming none reads by. */
	public const DEFAULT_AGGREGATE = 'sum';

	/** What a read may apply to a column. */
	public const AGGREGATES = [ self::DEFAULT_AGGREGATE, 'min', 'max' ];

	/** The key every row carries, in key order, with its declaration. */
	private const KEY_COLUMNS = [
		't' => 'INTEGER NOT NULL',
		'k' => 'TEXT NOT NULL',
		'x' => 'TEXT NOT NULL',
	];

	/** The key a row of a Ledger with columns adds: its writer's sequence. */
	private const SEQUENCE_COLUMN = [ 's' => 'INTEGER NOT NULL' ];

	/** Why a mount refuses an APPEND. */
	private const READS_ONLY = 'a mounted Ledger serves reads only';

	/** One APPEND row, as a refusal names it. */
	private const ROW_SHAPE = '[ t, k, x, [ columns… ] ]';

	/**
	 * One file's walk, `ts{i}` over the file attached as `%2$s`: each distinct
	 * `t` in `from ≤ t < to`, as `ts{i}.at`, each found by one primary-key
	 * seek past the last, a loose index scan. Binds from, to, to. The walk's
	 * column is `at`, so a bare `t` beside it is the row's.
	 */
	private const WALK = 'ts%1$d ( at ) AS ( SELECT MIN( t ) FROM %2$s.rows WHERE t >= ? AND t < ? UNION ALL SELECT ( SELECT MIN( t ) FROM %2$s.rows WHERE t > ts%1$d.at AND t < ? ) FROM ts%1$d WHERE ts%1$d.at IS NOT NULL )';

	/** One file's rows at each walked `t`; CROSS JOIN keeps the walk outer, so each `t` seeks its keys. */
	private const AT_EACH_T = 'FROM ts%1$d CROSS JOIN %2$s.rows WHERE %2$s.rows.t = ts%1$d.at';

	/**
	 * A key's distinct members across every file, at most the limit bound,
	 * after with_rows(): binds limit. The files' UNION ALL streams into a
	 * DISTINCT that orders nothing, so it stops at the limit rather than
	 * reading the key's every member; the outer ORDER BY sorts only what it
	 * kept. A UNION would gather every member before its LIMIT applied.
	 */
	private const MEMBERS_READ = 'SELECT x FROM ( SELECT DISTINCT x FROM r LIMIT ? ) ORDER BY x';

	/** Keys, or members, a SUM binds per `IN ( … )` when it binds both lists. */
	private const PAIRED_CHUNK = Sqlite_Arm::IN_CHUNK / 2;

	/**
	 * The verbs a Ledger counts: its requests, and the Router tick's DROP
	 * (asked the batches' room, answered the rows deleted) and CHECKPOINT
	 * (the WAL's frames).
	 */
	private const ZERO_STATS = [
		'APPEND'     => self::ZERO_ROW,
		'SUM'        => self::ZERO_ROW,
		'TOP'        => self::ZERO_ROW,
		'MEMBERS'    => self::ZERO_ROW,
		'DROP'       => self::ZERO_ROW,
		'CHECKPOINT' => self::ZERO_ROW,
	];

	/** Seconds of `t` one segment spans. */
	private int $segment_seconds = 0;

	/** Segments kept, so the lifespan is `segment_seconds × num_segments`. */
	private int $num_segments = 0;

	/**
	 * The declared columns, name => aggregate, stored as c0… in this order.
	 *
	 * @var array<string,string>
	 */
	private array $columns = [];

	/** The connection; null until arguments() opens the file. */
	private ?\PDO $db = null;

	/** The name the Ledger's files carry, which a node renamed after keeps. */
	private string $ledger = '';

	/**
	 * Every other partition's file the connection reads, attached as `p{N}`.
	 *
	 * @var array<int,string> Partition => file, in partition order.
	 */
	private array $attached = [];

	/** The one INSERT an APPEND runs per row. */
	private ?\PDOStatement $insert = null;

	/** The one SELECT a MEMBERS runs over the files attached; null until one runs. */
	private ?\PDOStatement $select_members = null;

	/** The one DELETE a segment drop runs per batch; binds cutoff, limit. */
	private ?\PDOStatement $drop = null;

	/** The one PASSIVE WAL checkpoint the tick runs. */
	private ?\PDOStatement $checkpoint = null;

	/** Every `t` below it is gone: the cutoff the last whole drop reached. */
	private int $dropped_below = 0;

	/** Whether the last drop stopped with a batch still full. */
	private bool $drop_behind = false;

	/** Whether this is a request-graph mount, which only reads. */
	private bool $mounted = false;

	/** The partition whose file the writer writes; null for a mount. */
	private ?int $partition = null;

	/** The last `s` this writer gave a row, seeded from hrtime at open. */
	private int $sequence = 0;

	/** Tachikoma-parity: no-arg ctor; the `{name}:config` interpreter answers `flush`. */
	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	/**
	 * `<segment_seconds> <num_segments> [<column>[:sum|min|max] …]`. Both
	 * counts are whole numbers of at least 1. Each column is named once, in
	 * `[A-Za-z_][A-Za-z0-9_]*` and never `x`, which a TOP orders by as the
	 * member, and its aggregate is one of AGGREGATES; no column makes the
	 * Ledger a set. Every token is checked, and the file opened, before any
	 * field moves, so a refusal leaves the node as it was.
	 * A writer prepares its writes; a mount prepares nothing.
	 *
	 * @param list<string>|null $args
	 * @return list<string>
	 * @throws \InvalidArgumentException On a count below 1, a column it cannot
	 *                                   declare, or a missing count.
	 * @throws \RuntimeException On a file that will not open as this Ledger's,
	 *                           more files than ATTACH_LIMIT, or no bound
	 *                           partition.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$values = $this->schema_values( $args );
		foreach ( [ 'segment_seconds', 'num_segments' ] as $count ) {
			if ( Core::as_int( $values[ $count ] ) < 1 ) {
				$this->refuse_argument( "{$count} must be at least 1" );
			}
		}
		$values['columns'] = $this->declared_columns( \array_map( Core::as_string( ... ), Core::arr( $values['columns'] ) ) );
		$names             = self::stored_columns( $values['columns'] );
		[ $db, $partition, $attached ] = $this->open( $names );
		$this->assign_schema_args( $args, $values );
		$this->db             = $db;
		$this->ledger         = $this->name;
		$this->attached       = $attached;
		$this->select_members = null;
		$this->partition      = $partition;
		if ( null !== $partition ) {
			$this->insert     = $db->prepare( ( [] === $values['columns'] ? 'INSERT OR IGNORE' : 'INSERT' ) . ' INTO main.rows ( ' . \implode( ', ', \array_keys( $names ) ) . ' ) VALUES ( ' . self::placeholders( $names ) . ' )' );
			$this->checkpoint = $db->prepare( Sqlite_Arm::PASSIVE_CHECKPOINT );
			$this->drop       = $db->prepare( 'DELETE FROM main.rows WHERE ( ' . self::key( $names ) . ' ) IN ( SELECT ' . self::key( $names ) . ' FROM main.rows WHERE t < ? LIMIT ? )' );
			$this->sequence   = (int) \hrtime( true );
		}
		return $args;
	}

	/**
	 * Answer a request TO its FROM; a Ledger takes no other traffic, and says
	 * so, rate-limited.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 * @throws \RuntimeException With no wired sink to reply through.
	 */
	public function fill( array $message ): void {
		++$this->counter;
		if ( ! $this->answer_request( $message ) ) {
			$this->print_less_often( 'ERROR: a Ledger answers requests only - from: ', Core::as_string( $message[ Message::FROM ], '' ) );
		}
	}

	/**
	 * Open the connection and hold every `rows` table it reads to `$names`,
	 * refusing one another declaration made: this Ledger's rows would not fit
	 * it. A writer opens its partition's file as its writer, `main`, declaring
	 * the table there. A mount opens an empty table of this shape in memory as
	 * `main`, so a Ledger no writer has made answers empty down the one path.
	 * Either then attaches every other partition's file; see attach().
	 *
	 * @param array<string,string> $names stored_columns().
	 * @return array{0: \PDO, 1: int|null, 2: array<int,string>} The
	 *         connection, the writer's partition or null for a mount, and the
	 *         files attached.
	 * @throws \RuntimeException Naming the Ledger, on no bound partition, a
	 *                           name no file can carry, more files than
	 *                           ATTACH_LIMIT, a directory or file that will
	 *                           not open, a mount as root, or a table of
	 *                           another shape.
	 */
	private function open( array $names ): array {
		try {
			$shape = self::shape( $names );
			if ( $this->mounted ) {
				Sqlite_Arm::refuse_root_reader( self::directory( $this->name ) . "/{$this->name}.p*.sqlite" );
				$partition = null;
				$db        = self::in_memory( $shape );
			} else {
				$partition = $this->bound_partition();
				$file      = self::file( $this->name, $partition );
				// Refuse an extra partition before its file exists.
				self::readable_files( $this->name, $partition );
				$db = self::writer_database( $file, $shape );
				self::holds_rows( $db, 'main', $file, $shape );
			}
			$attached = [];
			self::attach( $db, $this->name, $partition, $attached, $shape );
			return [ $db, $partition, $attached ];
		} catch ( Worker_Should_Stop $stop ) {
			throw $stop;
		} catch ( \RuntimeException | \LogicException $e ) {
			throw new \RuntimeException( \esc_html( "Ledger {$this->name}: " . $e->getMessage() ), 0, $e );
		}
	}

	/**
	 * An empty `rows` table in memory: a mount's `main`, which every read
	 * spans beside the files attached, so a Ledger no writer has made
	 * answers empty down the one path. Its files wait BUSY_TIMEOUT_MS, as a
	 * writer's do, not PDO's 60 s.
	 *
	 * @param string $shape shape().
	 * @return \PDO The connection.
	 */
	private static function in_memory( string $shape ): \PDO {
		$db = new \PDO( 'sqlite::memory:', null, null, [ \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION ] );
		Sqlite_Arm::busy_timeout( $db, self::BUSY_TIMEOUT_MS );
		$db->exec( "CREATE TABLE {$shape}" );
		return $db;
	}

	/**
	 * The process's bound `<partition>`, whose file this writer writes: never
	 * a guess, which would write another's.
	 *
	 * @return int The partition.
	 * @throws \LogicException When nothing bound one.
	 */
	private function bound_partition(): int {
		$bound = \array_key_exists( 'partition', Core::$var ) ? Core::canonical_decimal( Core::$var['partition'] ) : null;
		return $bound ?? throw new \LogicException( 'a writer needs a bound partition' );
	}

	/**
	 * `APPEND` for a caller outside a graph, down the path the request takes:
	 * every row checked first, then each inside the lifespan stored in one
	 * `BEGIN IMMEDIATE … COMMIT`, and each past it dropped. Counted as one
	 * APPEND call: the rows asked, and the rows stored.
	 *
	 * @api Writers outside a graph, and the APPEND request's handler.
	 * @param array<array-key,mixed> $rows `[ t, k, x, [ columns… ] ]` each, one
	 *                                     column per declared column in order:
	 *                                     a number, or null in a min or max
	 *                                     not measured.
	 * @return array{stored: int, dropped: int} Rows stored, and rows dropped as
	 *                                          past the lifespan; a set's row
	 *                                          already held is neither.
	 * @throws \InvalidArgumentException On a mount, a row of another shape, a
	 *                                   key that is empty or holds whitespace,
	 *                                   a column count other than the
	 *                                   declared, or null in a sum column.
	 * @throws \PDOException When the write fails, the lock held past
	 *                       BUSY_TIMEOUT_MS among the causes.
	 * @throws \LogicException Before arguments() has opened the file.
	 */
	public function append( array $rows ): array {
		$started = self::monotonic_ns();
		$bytes   = $this->stat_bytes();
		$stored  = 0;
		try {
			if ( $this->mounted ) {
				throw new \InvalidArgumentException( self::READS_ONLY );
			}
			$db     = $this->db ?? throw $this->unopened();
			$cutoff = (int) Core::right_now() - $this->segment_seconds * $this->num_segments;
			$kept   = $this->kept_rows( \array_values( $rows ), $cutoff );
			$stored = [] === $kept ? 0 : Sqlite_Arm::immediate( $db, fn (): int => $this->insert_rows( $kept ) );
			return [
				'stored'  => $stored,
				'dropped' => \count( $rows ) - \count( $kept ),
			];
		} finally {
			$this->count_rows( 'APPEND', \count( $rows ), $stored );
			$this->count_call( 'APPEND', $started, $bytes );
		}
	}

	/**
	 * The rows inside the lifespan, each checked against the declaration.
	 *
	 * @param list<mixed> $rows   The APPEND's rows.
	 * @param int         $cutoff A row whose `t` is below it is dropped.
	 * @return list<array{0: int, 1: string, 2: string, 3: list<int|float|null>}> Rows to store.
	 * @throws \InvalidArgumentException On the first row it refuses, naming it.
	 */
	private function kept_rows( array $rows, int $cutoff ): array {
		$names = \array_keys( $this->columns );
		$width = \count( $names );
		$kept  = [];
		foreach ( $rows as $i => $row ) {
			[ $t, $k, $x, $columns ] = \is_array( $row ) && [ 0, 1, 2, 3 ] === \array_keys( $row ) ? $row : [ null, null, null, null ];
			$numbers                 = \is_array( $columns ) ? \array_filter( $columns, static fn ( mixed $column ): bool => null === $column || \is_int( $column ) || \is_float( $column ) ) : [];
			if ( ! \is_int( $t ) || ! \is_string( $k ) || ! \is_string( $x ) || ! \is_array( $columns ) || ! \array_is_list( $columns ) || \count( $numbers ) !== \count( $columns ) ) {
				self::refuse_row( $i, 'needs ' . self::ROW_SHAPE . ', t whole seconds and each column a number or null' );
			}
			if ( Cache_Backend::refuses_key( $k ) ) {
				self::refuse_row( $i, 'key is empty or holds whitespace' );
			}
			if ( \count( $numbers ) !== $width ) {
				self::refuse_row( $i, \count( $numbers ) . " columns, the Ledger declares {$width}" );
			}
			foreach ( \array_keys( $numbers, null, true ) as $unmeasured ) {
				if ( self::DEFAULT_AGGREGATE === $this->columns[ $names[ $unmeasured ] ] ) {
					self::refuse_row( $i, "{$names[ $unmeasured ]} is a sum column, which takes a number; null is for a min or max not measured" );
				}
			}
			if ( $t >= $cutoff ) {
				$kept[] = [ $t, $k, $x, \array_values( $numbers ) ];
			}
		}
		return $kept;
	}

	/**
	 * Refuse an APPEND for one of its rows, the whole request with it.
	 *
	 * @param int    $i   The row's position.
	 * @param string $why Why.
	 * @throws \InvalidArgumentException Always.
	 */
	private static function refuse_row( int $i, string $why ): never {
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; answered as a TM_ERROR line, never rendered.
		throw new \InvalidArgumentException( "row {$i}: {$why}" );
	}

	/**
	 * Store rows through the one prepared INSERT, each a new `s`.
	 *
	 * @param list<array{0: int, 1: string, 2: string, 3: list<int|float|null>}> $rows Rows to store.
	 * @return int Rows stored; a set's row already held stores none.
	 */
	private function insert_rows( array $rows ): int {
		$insert = $this->insert ?? throw $this->unopened();
		$stored = 0;
		foreach ( $rows as [ $t, $k, $x, $columns ] ) {
			Sqlite_Arm::execute( $insert, [] === $this->columns ? [ $t, $k, $x ] : [ $t, $k, $x, ++$this->sequence, ...$columns ] );
			$stored += $insert->rowCount();
		}
		return $stored;
	}

	/**
	 * One read request over every partition's file, answered and counted as
	 * one call of its verb: the keys it asked, and the rows it answered.
	 *
	 * @param 'SUM'|'TOP'|'MEMBERS' $verb  The read.
	 * @param mixed                 $query The request's map of fields.
	 * @return array<array-key,mixed> The reply's `data`.
	 * @throws \InvalidArgumentException On a query the read refuses.
	 * @throws \RuntimeException As attach_partitions(), and when the read
	 *                           fails.
	 */
	private function read( string $verb, mixed $query ): array {
		$started  = self::monotonic_ns();
		$bytes    = $this->stat_bytes();
		$asked    = 0;
		$answered = 0;
		try {
			$query = \is_array( $query ) ? $query : throw new \InvalidArgumentException( 'needs a map of its fields' );
			$this->attach_partitions();
			[ $asked, $data, $answered ] = match ( $verb ) {
				'SUM'     => $this->read_sum( $query ),
				'TOP'     => $this->read_top( $query ),
				'MEMBERS' => $this->read_members( $query ),
			};
			return $data;
		} finally {
			$this->count_rows( $verb, $asked, $answered );
			$this->count_call( $verb, $started, $bytes );
		}
	}

	/**
	 * Bring the attached files to those on disk, as attach() does, before a
	 * read; a set that changed drops the MEMBERS statement built over the
	 * set before. One directory read a request, however many rows it reads.
	 *
	 * @throws \LogicException Before arguments() has opened the file.
	 * @throws \RuntimeException As attach().
	 */
	private function attach_partitions(): void {
		$before = $this->attached;
		try {
			self::attach( $this->db ?? throw $this->unopened(), $this->ledger, $this->partition, $this->attached, self::shape( self::stored_columns( $this->columns ) ) );
		} finally {
			if ( $before !== $this->attached ) {
				$this->select_members = null;
			}
		}
	}

	/**
	 * Bring `$attached` to the partition files on disk: each but the writer's
	 * own attached read-only as `p{N}` once its writer has declared its `rows`
	 * table, and each attached file gone from disk detached, so it reads as
	 * empty. Each change lands in `$attached` as it is made, so a refusal
	 * midway leaves the set naming what the connection holds.
	 *
	 * @param \PDO              $db       The connection.
	 * @param string            $ledger   The name the Ledger's files carry.
	 * @param int|null          $own      The writer's partition, its file read
	 *                                    as main; null for a mount.
	 * @param array<int,string> $attached Partition => file attached, brought
	 *                                    up to date in partition order.
	 * @param string            $shape    shape().
	 * @throws \RuntimeException More files than ATTACH_LIMIT, or one holding a
	 *                           rows table another declaration made.
	 */
	private static function attach( \PDO $db, string $ledger, ?int $own, array &$attached, string $shape ): void {
		$files = self::readable_files( $ledger, $own );
		if ( null !== $own ) {
			unset( $files[ $own ] );
		}
		foreach ( \array_keys( \array_diff_key( $attached, $files ) ) as $partition ) {
			$db->exec( "DETACH DATABASE p{$partition}" );
			unset( $attached[ $partition ] );
		}
		foreach ( \array_diff_key( $files, $attached ) as $partition => $file ) {
			if ( self::attach_file( $db, $partition, $file, $shape ) ) {
				$attached[ $partition ] = $file;
			}
		}
		\ksort( $attached );
	}

	/**
	 * Every partition file on disk, and the writer's own, which its writer
	 * may not have made yet.
	 *
	 * @param string   $ledger The name the Ledger's files carry.
	 * @param int|null $own    The writer's partition; null for a mount.
	 * @return array<int,string> Partition => file.
	 * @throws \RuntimeException When they number more than ATTACH_LIMIT.
	 */
	private static function readable_files( string $ledger, ?int $own ): array {
		$files = self::partition_files( $ledger ) + ( null === $own ? [] : [ $own => self::file( $ledger, $own ) ] );
		if ( \count( $files ) > self::ATTACH_LIMIT ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- two numbers; open() escapes what it wraps.
			throw new \RuntimeException( \count( $files ) . ' partition files, more than the ' . self::ATTACH_LIMIT . ' SQLite attaches to one connection' );
		}
		return $files;
	}

	/**
	 * Attach one partition's file as `p{N}`, kept only once its writer has
	 * declared the `rows` table this Ledger reads; one not declared yet
	 * detaches and reads as absent until a later read.
	 *
	 * @param \PDO   $db        The connection.
	 * @param int    $partition The file's partition.
	 * @param string $file      The file.
	 * @param string $shape     shape().
	 * @return bool Whether it stays attached.
	 * @throws \UnexpectedValueException When it holds a rows table another
	 *                                   declaration made, detached.
	 */
	private static function attach_file( \PDO $db, int $partition, string $file, string $shape ): bool {
		Sqlite_Arm::attach_read_only( $db, $file, "p{$partition}" );
		$declared = false;
		try {
			$declared = self::holds_rows( $db, "p{$partition}", $file, $shape );
			return $declared;
		} finally {
			if ( ! $declared ) {
				$db->exec( "DETACH DATABASE p{$partition}" );
			}
		}
	}

	/**
	 * Whether the database attached as `$schema` holds this Ledger's `rows`
	 * table; false for one holding none yet, as a file its writer has made
	 * and not yet declared.
	 *
	 * @param \PDO   $db     The connection.
	 * @param string $schema `main` or `p{N}`.
	 * @param string $file   The file, as a refusal names it.
	 * @param string $shape  shape().
	 * @return bool Whether it holds the table.
	 * @throws \UnexpectedValueException When it holds one another declaration
	 *                                   made.
	 */
	private static function holds_rows( \PDO $db, string $schema, string $file, string $shape ): bool {
		$held = $db->prepare( "SELECT sql FROM {$schema}.sqlite_master WHERE type = 'table' AND name = 'rows'" );
		Sqlite_Arm::execute( $held );
		$sql = $held->fetchColumn();
		// A statement still stepping locks the file against DETACH.
		$held->closeCursor();
		if ( false === $sql || "CREATE TABLE {$shape}" === $sql ) {
			return false !== $sql;
		}
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- open() escapes what it wraps; a read answers it as a line.
		throw new \UnexpectedValueException( "{$file} holds a rows table another declaration made; `wp nodes tables flush` drops the rows written under it and declares this one" );
	}

	/**
	 * `SUM`: each `( k, x )` group, or with `group: 'k'` each `k` across its
	 * members, and each split per `t` with `by_t`, each column by its
	 * declared aggregate, in `( k, x[, t] )` order within each chunk:
	 * IN_CHUNK keys, or PAIRED_CHUNK keys and members. A `k` total reads
	 * every member it names in one chunk, so it takes PAIRED_CHUNK at most.
	 * `positive` and `positive_each_t` filter the groups as grouped() says,
	 * TOP's filter exactly; a group lies whole inside one chunk, so each
	 * chunk filters its own.
	 *
	 * @param array<array-key,mixed> $query `{ from, to, ks, xs?, by_t?,
	 *                                      group?: x|k, positive?,
	 *                                      positive_each_t? }`.
	 * @return array{0: int, 1: list<list<mixed>>, 2: int} Keys asked, the
	 *                                                     `[ k, x|null,
	 *                                                     t|null, columns… ]`
	 *                                                     rows, and their
	 *                                                     count.
	 * @throws \InvalidArgumentException On a query it refuses.
	 */
	private function read_sum( array $query ): array {
		self::only( $query, 'from', 'to', 'ks', 'xs', 'by_t', 'group', 'positive', 'positive_each_t' );
		$walk  = self::walk( $query );
		$ks    = self::strings( $query, 'ks' );
		$xs    = isset( $query['xs'] ) ? self::strings( $query, 'xs' ) : null;
		$by_t  = self::boolean( $query, 'by_t' );
		$per_x = match ( $query['group'] ?? 'x' ) {
			'x'     => true,
			'k'     => false,
			default => throw new \InvalidArgumentException( 'group is x or k' ),
		};
		if ( ! $per_x && \count( $xs ?? [] ) > self::PAIRED_CHUNK ) {
			throw new \InvalidArgumentException( 'xs names at most ' . self::PAIRED_CHUNK . ' members with group k' );
		}
		[ $positive, $each_t ] = $this->positive( $query );
		$by                    = $per_x ? [ 'k', 'x' ] : [ 'k' ];
		$order                 = \implode( ', ', $by_t ? [ ...$by, 't' ] : $by );
		$pick                  = \implode( ', ', [ 'k', $per_x ? 'x' : 'NULL', $by_t ? 't' : 'NULL', ...$this->aggregates() ] );
		$found                 = [];
		$test                  = null === $xs ? ' AND k IN ks' : ' AND k IN ks AND x IN xs';
		foreach ( \array_chunk( $ks, null === $xs ? Sqlite_Arm::IN_CHUNK : self::PAIRED_CHUNK ) as $k_chunk ) {
			foreach ( null === $xs ? [ [] ] : \array_chunk( $xs, self::PAIRED_CHUNK ) as $x_chunk ) {
				[ $with, $values ] = $this->with_rows( $walk, $test, null === $xs ? [ 'ks' => $k_chunk ] : [ 'ks' => $k_chunk, 'xs' => $x_chunk ] );
				$found[]           = $this->rows( $with . "SELECT {$pick} " . $this->grouped( $by, $by_t, $positive, $each_t ) . " ORDER BY {$order}", $values );
			}
		}
		$rows = \array_merge( ...$found );
		return [ \count( $ks ), $rows, \count( $rows ) ];
	}

	/**
	 * `TOP`: the members across every key in `ks`, grouped by `x` and ranked
	 * by `order_by`, then `x`: a column's aggregate, `x` itself, or the
	 * aggregate of one `sum` column over another's, whose zero denominator
	 * ranks last in either order, as does a `min` or `max` never measured.
	 * `positive` and `positive_each_t` filter the members as grouped() says.
	 * `total` counts the members ranked before `offset` and `limit` page them,
	 * and one read transaction holds the count and the page to one snapshot
	 * of every file. A set ranks by `x` alone; no keys rank nothing.
	 *
	 * @param array<array-key,mixed> $query `{ from, to, ks, order_by, order,
	 *                                      limit, offset, positive?,
	 *                                      positive_each_t? }`.
	 * @return array{0: int, 1: array{total: int, rows: list<list<mixed>>}, 2: int}
	 *         Keys asked, the page and its total, and the rows answered.
	 * @throws \InvalidArgumentException On a query it refuses.
	 */
	private function read_top( array $query ): array {
		self::only( $query, 'from', 'to', 'ks', 'order_by', 'order', 'limit', 'offset', 'positive', 'positive_each_t' );
		if ( [] === $this->columns && ( 'x' !== ( $query['order_by'] ?? null ) || isset( $query['positive'] ) ) ) {
			throw new \InvalidArgumentException( 'a Ledger declaring no columns ranks by x alone, with no positive' );
		}
		$walk                  = self::walk( $query );
		$ks                    = self::strings( $query, 'ks' );
		$aggregates            = $this->aggregates();
		$rank                  = $this->rank( $aggregates, $query['order_by'] ?? null );
		[ $positive, $each_t ] = $this->positive( $query );
		$order                 = $query['order'] ?? null;
		if ( 'asc' !== $order && 'desc' !== $order ) {
			throw new \InvalidArgumentException( 'order is asc or desc' );
		}
		$limit  = self::whole( $query, 'limit', 1, self::TOP_LIMIT_MAX );
		$offset = self::whole( $query, 'offset', 0 );
		if ( \count( $ks ) > Sqlite_Arm::IN_CHUNK ) {
			throw new \InvalidArgumentException( 'ks names at most ' . Sqlite_Arm::IN_CHUNK . ' keys' );
		}
		if ( [] === $ks ) {
			return [
				0,
				[
					'total' => 0,
					'rows'  => [],
				],
				0,
			];
		}
		[ $with, $values ] = $this->with_rows( $walk, ' AND k IN ks', [ 'ks' => $ks ] );
		$groups            = $this->grouped( [ 'x' ], false, $positive, $each_t );
		$page              = $with . 'SELECT ' . \implode( ', ', [ 'x', ...$aggregates ] ) . " {$groups} ORDER BY {$rank} " . \strtoupper( $order ) . ' NULLS LAST, x LIMIT ? OFFSET ?';
		[ $total, $rows ]  = Sqlite_Arm::deferred(
			$this->db ?? throw $this->unopened(),
			fn (): array => [
				$this->rows( $with . "SELECT COUNT(*) FROM ( SELECT x {$groups} )", $values ),
				$this->rows( $page, [ ...$values, $limit, $offset ] ),
			]
		);
		return [
			\count( $ks ),
			[
				'total' => Core::as_int( $total[0][0] ),
				'rows'  => $rows,
			],
			\count( $rows ),
		];
	}

	/**
	 * What a TOP ranks by, as SQL over the groups: `x`, a declared column's
	 * aggregate, or `[ numerator, denominator ]`, two distinct `sum`
	 * columns, divided with a zero denominator answering NULL.
	 *
	 * @param array<string,string> $aggregates aggregates().
	 * @param mixed                $order_by   The request's `order_by`.
	 * @return string The ranking expression.
	 * @throws \InvalidArgumentException On anything else, offering a ratio
	 *                                   only where two sum columns allow one.
	 */
	private function rank( array $aggregates, mixed $order_by ): string {
		if ( 'x' === $order_by ) {
			return 'x';
		}
		if ( \is_string( $order_by ) && isset( $aggregates[ $order_by ] ) ) {
			return $aggregates[ $order_by ];
		}
		$sums                        = \array_keys( $this->columns, self::DEFAULT_AGGREGATE, true );
		[ $numerator, $denominator ] = \is_array( $order_by ) && [ 0, 1 ] === \array_keys( $order_by ) ? $order_by : [ null, null ];
		if ( $numerator !== $denominator && \in_array( $numerator, $sums, true ) && \in_array( $denominator, $sums, true ) ) {
			return "{$aggregates[ $numerator ]} / NULLIF( {$aggregates[ $denominator ]}, 0 )";
		}
		$columns = \implode( ', ', \array_keys( $this->columns ) );
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; answered as a TM_ERROR line, never rendered.
		throw new \InvalidArgumentException( \count( $sums ) < 2 ? "order_by is x or one of {$columns}" : "order_by is x, one of {$columns}, or [ numerator, denominator ] naming two sum columns of " . \implode( ', ', $sums ) );
	}

	/**
	 * The rows a SUM or a TOP aggregates, as SQL after its SELECT list: `r`,
	 * with_rows()' keyed rows of every file, grouped by `$by`, and by `t` as
	 * well with `$by_t`. Every form keeps each stored column's name, so aggregates()
	 * selects from any of them. `$positive` keeps a group only when its
	 * aggregate of that column over the range is above 0, every `t` of it
	 * with `$by_t`. With `$each_t` it filters each stored `( t, k, x )`
	 * aggregate, the row grain, and only the rows that pass are grouped: a
	 * member counts in a key and a `t` only where it passed there itself.
	 *
	 * @param list<string> $by       The grouping, `t` aside.
	 * @param bool         $by_t     Whether each group splits per `t`.
	 * @param string|null  $positive The declared column above 0, or null.
	 * @param bool         $each_t   Whether it is above 0 in each stored row.
	 * @return string `FROM … GROUP BY …`, with the filter where one applies.
	 */
	private function grouped( array $by, bool $by_t, ?string $positive, bool $each_t ): string {
		$keyed = 'FROM r';
		$per_t = [ ...$by, 't' ];
		$group = ' GROUP BY ' . \implode( ', ', $by_t ? $per_t : $by );
		if ( null === $positive ) {
			return $keyed . $group;
		}
		$aggregates = $this->aggregates();
		$above      = "{$aggregates[ $positive ]} > 0";
		if ( ! $each_t && ! $by_t ) {
			return "{$keyed}{$group} HAVING {$above}";
		}
		$grain = $each_t ? \array_keys( self::KEY_COLUMNS ) : $per_t;
		$inner = 'SELECT ' . \implode( ', ', [ ...$grain, ...self::aliased( $aggregates ) ] );
		$split = ' GROUP BY ' . \implode( ', ', $grain );
		if ( $each_t ) {
			return "FROM ( {$inner} {$keyed}{$split} HAVING {$above} ){$group}";
		}
		$over_range = \strtoupper( $this->columns[ $positive ] ) . "( {$aggregates[ $positive ]} ) OVER ( PARTITION BY " . \implode( ', ', $by ) . ' )';
		return "FROM ( {$inner}, {$over_range} AS over_range {$keyed}{$split} ) WHERE over_range > 0{$group}";
	}

	/**
	 * The positive filter a SUM or a TOP asks for.
	 *
	 * @param array<array-key,mixed> $query The query.
	 * @return array{0: string|null, 1: bool} The declared column that must be
	 *                                        above 0, or null, and whether at
	 *                                        each `t`.
	 * @throws \InvalidArgumentException On a column not declared, or
	 *                                   `positive_each_t` with no `positive`.
	 */
	private function positive( array $query ): array {
		$each_t = self::boolean( $query, 'positive_each_t' );
		if ( isset( $query['positive'] ) ) {
			return [ $this->column( $query, 'positive' ), $each_t ];
		}
		return $each_t ? throw new \InvalidArgumentException( 'positive_each_t needs positive' ) : [ null, false ];
	}

	/**
	 * Each aggregate named for the stored column it reads, so a query over
	 * pre-aggregated groups applies the same aggregates again.
	 *
	 * @param array<string,string> $aggregates aggregates().
	 * @return list<string> `SUM(c0) AS c0`, … in declaration order.
	 */
	private static function aliased( array $aggregates ): array {
		$aliased = [];
		foreach ( \array_values( $aggregates ) as $i => $sql ) {
			$aliased[] = "{$sql} AS c{$i}";
		}
		return $aliased;
	}

	/**
	 * `MEMBERS`: the distinct members of one key, in member order, or
	 * `{ over: limit }` when the key holds more than `limit` in the range,
	 * as SMEMBERS answers `OVER <limit>`. It reads `limit + 1` members at
	 * most, however many the key holds, a member two files hold counting once.
	 * The statement is prepared once for the files attached.
	 *
	 * @param array<array-key,mixed> $query `{ from, to, k, limit }`.
	 * @return array{0: int, 1: list<string>|array{over: int}, 2: int} The one
	 *         key asked, its members or the over answer, and the members
	 *         answered.
	 * @throws \InvalidArgumentException On a query it refuses.
	 */
	private function read_members( array $query ): array {
		self::only( $query, 'from', 'to', 'k', 'limit' );
		$k       = \is_string( $query['k'] ?? null ) ? $query['k'] : throw new \InvalidArgumentException( 'k is a string' );
		$limit             = self::whole( $query, 'limit', 1, self::MEMBERS_LIMIT_MAX );
		[ $with, $values ] = $this->with_rows( self::walk( $query ), ' AND k = ?', [], [ $k ] );
		$read              = $this->select_members ??= ( $this->db ?? throw $this->unopened() )->prepare( $with . self::MEMBERS_READ );
		$members           = \array_map( Core::as_string( ... ), \array_column( self::fetched( $read, [ ...$values, $limit + 1 ] ), 0 ) );
		return \count( $members ) > $limit ? [ 1, [ 'over' => $limit ], 0 ] : [ 1, $members, \count( $members ) ];
	}

	/**
	 * The WITH clause a read opens with: each list the read binds once, as a
	 * one-column table its test reads (`k IN ks`), each file's walk, and `r`,
	 * every file's rows at its walked `t` that pass `$test`, the files joined
	 * by UNION ALL. The files are `main`, the writer's own or a mount's empty
	 * table, and each attached.
	 *
	 * @param list<int>                  $walk    walk().
	 * @param string                     $test    After each file's AT_EACH_T.
	 * @param array<string,list<string>> $lists   Table => values, each list
	 *                                            non-empty.
	 * @param list<string>               $per_arm What `$test` binds in each
	 *                                            file's arm.
	 * @return array{0: string, 1: list<int|string>} The clause, and the values
	 *                                               it binds, in order.
	 */
	private function with_rows( array $walk, string $test, array $lists = [], array $per_arm = [] ): array {
		$tables = [];
		$values = [];
		foreach ( $lists as $table => $list ) {
			$tables[] = "{$table} ( v ) AS ( VALUES " . \implode( ', ', \array_fill( 0, \count( $list ), '( ? )' ) ) . ' )';
			\array_push( $values, ...$list );
		}
		$columns = \implode( ', ', \array_keys( \array_diff_key( self::stored_columns( $this->columns ), self::SEQUENCE_COLUMN ) ) );
		$arms    = [];
		foreach ( [ 'main', ...\array_map( static fn ( int $partition ): string => "p{$partition}", \array_keys( $this->attached ) ) ] as $i => $schema ) {
			$tables[] = \sprintf( self::WALK, $i, $schema );
			$arms[]   = "SELECT {$columns} " . \sprintf( self::AT_EACH_T, $i, $schema ) . $test;
			\array_push( $values, ...$walk );
		}
		$tables[] = 'r AS ( ' . \implode( ' UNION ALL ', $arms ) . ' )';
		\array_push( $values, ...\array_merge( ...\array_fill( 0, \count( $arms ), $per_arm ) ) );
		return [ 'WITH RECURSIVE ' . \implode( ', ', $tables ) . ' ', $values ];
	}

	/**
	 * Refuse a query naming a field its read does not take.
	 *
	 * @param array<array-key,mixed> $query  The query.
	 * @param string                 ...$names The fields the read takes.
	 * @throws \InvalidArgumentException Naming the fields it takes, never the
	 *                                   one it refused, so the reply stays
	 *                                   one line.
	 */
	private static function only( array $query, string ...$names ): void {
		if ( [] !== \array_diff_key( $query, \array_flip( $names ) ) ) {
			$last = \array_pop( $names );
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; answered as a TM_ERROR line, never rendered.
			throw new \InvalidArgumentException( 'takes the fields ' . \implode( ', ', $names ) . " and {$last} alone" );
		}
	}

	/**
	 * The values each file's WALK binds for a query's `t` range.
	 *
	 * @param array<array-key,mixed> $query The query.
	 * @return list<int> from, to, to.
	 * @throws \InvalidArgumentException When from or to is no whole number.
	 */
	private static function walk( array $query ): array {
		$to = self::whole( $query, 'to' );
		return [ self::whole( $query, 'from' ), $to, $to ];
	}

	/**
	 * A field holding a whole number: any, at least `$floor`, or from
	 * `$floor` to `$ceiling`.
	 *
	 * @param array<array-key,mixed> $query   The query.
	 * @param string                 $name    The field.
	 * @param int                    $floor   The least it may be.
	 * @param int                    $ceiling The most it may be.
	 * @return int The number.
	 * @throws \InvalidArgumentException On anything else, absence included.
	 */
	private static function whole( array $query, string $name, int $floor = \PHP_INT_MIN, int $ceiling = \PHP_INT_MAX ): int {
		$value = $query[ $name ] ?? null;
		if ( \is_int( $value ) && $value >= $floor && $value <= $ceiling ) {
			return $value;
		}
		$bounds = match ( true ) {
			\PHP_INT_MIN === $floor   => '',
			\PHP_INT_MAX === $ceiling => " of at least {$floor}",
			default                   => " from {$floor} to {$ceiling}",
		};
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; answered as a TM_ERROR line, never rendered.
		throw new \InvalidArgumentException( "{$name} is a whole number{$bounds}" );
	}

	/**
	 * A field holding true or false, false where it is absent.
	 *
	 * @param array<array-key,mixed> $query The query.
	 * @param string                 $name  The field.
	 * @return bool The flag.
	 * @throws \InvalidArgumentException On anything else.
	 */
	private static function boolean( array $query, string $name ): bool {
		$value = $query[ $name ] ?? false;
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; answered as a TM_ERROR line, never rendered.
		return \is_bool( $value ) ? $value : throw new \InvalidArgumentException( "{$name} is true or false" );
	}

	/**
	 * A field holding a list of strings, answered with each string once.
	 *
	 * @param array<array-key,mixed> $query The query.
	 * @param string                 $name  The field.
	 * @return list<string> The distinct strings, in first-seen order.
	 * @throws \InvalidArgumentException On anything else, absence included.
	 */
	private static function strings( array $query, string $name ): array {
		$value   = $query[ $name ] ?? null;
		$strings = \is_array( $value ) && \array_is_list( $value ) ? \array_filter( $value, \is_string( ... ) ) : null;
		if ( null !== $strings && \count( $strings ) === \count( $value ) ) {
			return \array_values( \array_unique( $strings ) );
		}
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; answered as a TM_ERROR line, never rendered.
		throw new \InvalidArgumentException( "{$name} is a list of strings" );
	}

	/**
	 * The declared column a field names.
	 *
	 * @param array<array-key,mixed> $query The query.
	 * @param string                 $name  The field naming the column.
	 * @return string The column's name.
	 * @throws \InvalidArgumentException When it names no declared column.
	 */
	private function column( array $query, string $name ): string {
		$column = $query[ $name ] ?? null;
		if ( \is_string( $column ) && isset( $this->columns[ $column ] ) ) {
			return $column;
		}
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain text; answered as a TM_ERROR line, never rendered.
		throw new \InvalidArgumentException( [] === $this->columns ? "{$name} names a column, and a Ledger declaring no columns has none" : "{$name} is one of " . \implode( ', ', \array_keys( $this->columns ) ) );
	}

	/**
	 * Each declared column's aggregate over its stored column, as SQL.
	 *
	 * @return array<string,string> Name => `SUM(c0)`, in declaration order.
	 */
	private function aggregates(): array {
		$sql = [];
		foreach ( \array_keys( $this->columns ) as $i => $name ) {
			$sql[ $name ] = \strtoupper( $this->columns[ $name ] ) . "(c{$i})";
		}
		return $sql;
	}

	/**
	 * One `?` per value, comma-separated.
	 *
	 * @param array<array-key,mixed> $values The values bound.
	 * @return string The placeholders.
	 */
	private static function placeholders( array $values ): string {
		return \implode( ', ', \array_fill( 0, \count( $values ), '?' ) );
	}

	/**
	 * Every row one statement answers, prepared for this call alone.
	 *
	 * @param string      $sql    The statement.
	 * @param list<mixed> $values Bound values.
	 * @return list<list<mixed>> The rows.
	 */
	private function rows( string $sql, array $values ): array {
		$db = $this->db ?? throw $this->unopened();
		return self::fetched( $db->prepare( $sql ), $values );
	}

	/**
	 * Run a statement, each int bound as an integer, and read it to its end,
	 * so a cached statement holds no read snapshot open past the call.
	 *
	 * @param \PDOStatement $statement The statement.
	 * @param list<mixed>   $values    Bound values.
	 * @return list<list<mixed>> The rows.
	 */
	private static function fetched( \PDOStatement $statement, array $values ): array {
		foreach ( $values as $i => $value ) {
			$statement->bindValue( $i + 1, $value, \is_int( $value ) ? \PDO::PARAM_INT : \PDO::PARAM_STR );
		}
		Sqlite_Arm::execute( $statement );
		/** @var list<list<mixed>> $rows FETCH_NUM answers each row as a list. */
		$rows = $statement->fetchAll( \PDO::FETCH_NUM );
		return $rows;
	}

	/**
	 * This Ledger's work on the tick at `$now`, for Table_Node::tick(): its
	 * DROP of every `t` below the lifespan's edge rounded down to a segment
	 * boundary, run once that cutoff passes the last drop's and until a drop
	 * reaches it; its WAL checkpoint, at most once a CHECKPOINT_INTERVAL_S;
	 * and its trace line while traced. The writer runs both on its own file
	 * alone, never on a file it attached. A mount prepares neither statement,
	 * so it does neither.
	 * See Tick_Housekeeper::tick_steps() for the steps.
	 *
	 * @param int $now The tick, in epoch seconds.
	 */
	public function tick_steps( int $now ): array {
		$drop       = $this->drop;
		$checkpoint = $this->checkpoint;
		$purge      = null;
		if ( null !== $drop ) {
			$edge   = $now - $this->segment_seconds * $this->num_segments;
			$cutoff = $edge - $edge % $this->segment_seconds;
			$purge  = $cutoff > $this->dropped_below ? fn ( float $until ) => $this->drop_segments( $drop, $cutoff, $until ) : null;
		}
		return [
			'purge'      => $purge,
			'behind'     => $this->drop_behind,
			'checkpoint' => null !== $checkpoint && $this->checkpoint_due <= $now ? fn ( ?float $until ) => $this->checkpoint_wal( static fn (): ?array => Sqlite_Arm::passive_checkpoint( $checkpoint ), $now, $until ) : null,
			'trace'      => $this->debug_state > 0 ? $this->trace_tick( ... ) : null,
		];
	}

	/**
	 * Delete the rows below `$cutoff` DROP_BATCH_ROWS at a time, counted as
	 * one DROP; see delete_batches(). A drop that stops with its last batch
	 * full leaves the Ledger behind, says so, and runs again on the next tick
	 * under the backlog budget. A batch that outwaits the connection's busy
	 * timeout on a flush from the CLI, the one other writer, skips the drop,
	 * logged rate-limited, and the next tick tries again. Every row below the
	 * cutoff is past the lifespan, so no drop, whole or cut short, deletes a
	 * row inside it.
	 *
	 * @param \PDOStatement $drop   The prepared DELETE.
	 * @param int           $cutoff Every row whose `t` is below it goes.
	 * @param float         $until  The tick's deadline, shared by every store.
	 */
	private function drop_segments( \PDOStatement $drop, int $cutoff, float $until ): void {
		$drop->bindValue( 1, $cutoff, \PDO::PARAM_INT );
		$drop->bindValue( 2, self::DROP_BATCH_ROWS, \PDO::PARAM_INT );
		$batch = static function () use ( $drop ): int {
			Sqlite_Arm::execute( $drop );
			return $drop->rowCount();
		};
		try {
			[ $dropped, $batches ] = $this->delete_batches( 'DROP', $batch, self::DROP_BATCH_ROWS, $until );
		} catch ( \PDOException $e ) {
			$this->print_less_often( 'WARNING: segment drop skipped: ', $e->getMessage() . '; the next tick tries again' );
			return;
		}
		$this->drop_behind = $batches * self::DROP_BATCH_ROWS === $dropped;
		if ( $this->drop_behind ) {
			$this->print_less_often( 'WARNING: segment drop is behind: ', "its last batch came back full after {$batches} batches, {$dropped} rows; the next tick drops on under the backlog budget" );
			return;
		}
		$this->dropped_below = $cutoff;
	}

	/**
	 * Empty this partition's file in place: replace_rows() over the writer's
	 * connection, declaring the table this node declares, but only while
	 * `$columns`, the columns its topology declares now, are the ones this
	 * node runs. Every other partition reads the emptied table on, and its
	 * own file is its own writer's to flush. The drop and the checkpoint
	 * schedule start over, as they do for a new writer.
	 * Verb-exposed (`flush <column>…`).
	 *
	 * @param list<string> $columns The declared columns, `<name>[:sum|min|max]`.
	 * @return array{rows: int} The rows the file held.
	 * @throws \RuntimeException On a mount, which serves reads only, or when
	 *                           `$columns` are not the ones this node runs,
	 *                           naming the restart that brings them in.
	 * @throws \InvalidArgumentException On a column it cannot declare.
	 * @throws \LogicException Before arguments() has opened the file.
	 * @throws \PDOException When the write fails, the lock held past
	 *                       BUSY_TIMEOUT_MS among the causes.
	 */
	public function flush( array $columns ): array {
		if ( $this->mounted ) {
			throw new \RuntimeException( \esc_html( "flush: {$this->name} is a mounted Ledger, which serves reads only" ) );
		}
		$declared = $this->declared_columns( $columns );
		if ( $declared !== $this->columns ) {
			throw new \RuntimeException( \esc_html( "flush: {$this->name} runs " . self::listed( $this->columns ) . ' where its topology declares ' . self::listed( $declared ) . '; restart this worker (`wp nodes restart`), or hold the fleet (`wp nodes stop`), and flush again' ) );
		}
		$released               = self::replace_rows( $this->db ?? throw $this->unopened(), self::shape( self::stored_columns( $this->columns ) ) );
		$this->dropped_below    = 0;
		$this->drop_behind      = false;
		$this->checkpoint_due   = (int) Core::$now + self::CHECKPOINT_INTERVAL_S;
		$this->wal_stalled      = 0;
		$this->wal_stall_frames = 0;
		return $released;
	}

	/**
	 * Each column token as name => aggregate, in declaration order.
	 *
	 * @param array<string> $tokens `<name>[:sum|min|max]` each.
	 * @return array<string,string> Name => aggregate.
	 * @throws \InvalidArgumentException On a name out of pattern, `x`, or
	 *                                   declared twice, or an unknown
	 *                                   aggregate.
	 */
	private function declared_columns( array $tokens ): array {
		$columns = [];
		foreach ( $tokens as $token ) {
			[ $name, $aggregate ] = self::name_and_aggregate( $token );
			if ( 1 !== \preg_match( '/^[A-Za-z_][A-Za-z0-9_]*$/D', $name ) || 'x' === $name || isset( $columns[ $name ] ) ) {
				$this->refuse_argument( "column {$token}: a name in [A-Za-z_][A-Za-z0-9_]* other than x, which TOP orders by as the member, declared once" );
			}
			if ( ! \in_array( $aggregate, self::AGGREGATES, true ) ) {
				$this->refuse_argument( "column {$token}: the aggregate is one of " . \implode( ', ', self::AGGREGATES ) );
			}
			$columns[ $name ] = $aggregate;
		}
		return $columns;
	}

	/**
	 * The refusal of a call made before arguments() has opened the file.
	 *
	 * @return \LogicException Naming the Ledger.
	 */
	private function unopened(): \LogicException {
		return new \LogicException( \esc_html( "Ledger {$this->name} has opened no file" ) );
	}

	/**
	 * Columns as a refusal names them, each spelled whole.
	 *
	 * @param array<string,string> $columns Name => aggregate.
	 * @return string `qty:sum lo:min`, or `no columns`.
	 */
	private static function listed( array $columns ): string {
		$spelled = \array_map( static fn ( string $name, string $aggregate ): string => "{$name}:{$aggregate}", \array_keys( $columns ), $columns );
		return [] === $spelled ? 'no columns' : \implode( ' ', $spelled );
	}

	/**
	 * Empty one partition's file no live worker writes, from the declaration
	 * alone, as `wp nodes tables flush` does: replace_rows() over a writer's
	 * connection of its own, whatever table the file held. A Ledger whose
	 * declaration changed its columns, and so will not open, opens after
	 * every file is flushed.
	 *
	 * @api Tables_CLI_Command::flush(), for a file no live worker writes.
	 * @param string                                                             $name        The declared Ledger.
	 * @param int                                                                $partition   The file's partition.
	 * @param array{segment_seconds: int, num_segments: int, columns: list<string>} $declaration The resolved declaration.
	 * @return array{rows: int} The rows the file held.
	 * @throws \InvalidArgumentException On a name that cannot name a file.
	 * @throws \RuntimeException On a directory or file that will not open, or
	 *                           a write that fails.
	 */
	public static function flush_file( string $name, int $partition, array $declaration ): array {
		$shape = self::shape( self::stored_columns( \array_map( static fn ( string $column ): string => self::name_and_aggregate( $column )[1], $declaration['columns'] ) ) );
		return self::replace_rows( self::writer_database( self::file( $name, $partition ), $shape ), $shape );
	}

	/**
	 * A column token read as its name and its aggregate, DEFAULT_AGGREGATE
	 * where it names none: the one reading of `<name>[:sum|min|max]`.
	 *
	 * @param string $token `<name>[:sum|min|max]`.
	 * @return array{0: string, 1: string} The name, and the aggregate.
	 */
	private static function name_and_aggregate( string $token ): array {
		[ $name, $aggregate ] = \explode( ':', self::spelled( $token ), 2 );
		return [ $name, $aggregate ];
	}

	/**
	 * A column token spelled whole, `<name>:<aggregate>`, DEFAULT_AGGREGATE
	 * where it names none: the form two declarations of a column compare in.
	 *
	 * @api Bootstrap::node_ledgers(), which compares declarations so spelled.
	 * @param string $token `<name>[:sum|min|max]`.
	 * @return string `<name>:<aggregate>`.
	 */
	public static function spelled( string $token ): string {
		return \str_contains( $token, ':' ) ? $token : $token . ':' . self::DEFAULT_AGGREGATE;
	}

	/**
	 * Every column a row stores, in order, with its declaration: the key,
	 * then for a Ledger with columns its sequence and c0… as REAL, NOT NULL
	 * for a sum and nullable for a min or max, which skips a null.
	 *
	 * @param array<array-key,string> $aggregates Each declared column's
	 *                                            aggregate, in order.
	 * @return array<string,string> Name => SQLite declaration.
	 */
	private static function stored_columns( array $aggregates ): array {
		if ( [] === $aggregates ) {
			return self::KEY_COLUMNS;
		}
		$values = [];
		foreach ( \array_values( $aggregates ) as $i => $aggregate ) {
			$values[ "c{$i}" ] = self::DEFAULT_AGGREGATE === $aggregate ? 'REAL NOT NULL' : 'REAL';
		}
		return self::KEY_COLUMNS + self::SEQUENCE_COLUMN + $values;
	}

	/**
	 * The `rows` table a row storing `$names` needs, as SQLite records it
	 * after `CREATE TABLE `.
	 *
	 * @param array<string,string> $names stored_columns().
	 * @return string `rows ( … ) WITHOUT ROWID`.
	 */
	private static function shape( array $names ): string {
		$fields = \implode( ', ', \array_map( static fn ( string $name, string $declaration ): string => "{$name} {$declaration}", \array_keys( $names ), $names ) );
		return "rows ( {$fields}, PRIMARY KEY ( " . self::key( $names ) . ' ) ) WITHOUT ROWID';
	}

	/**
	 * The file opened as a writer, its directory made and a `rows` table
	 * declared where it has none.
	 *
	 * @param string $file  The Ledger's file.
	 * @param string $shape shape().
	 * @return \PDO The writer's connection.
	 * @throws \RuntimeException On a directory or file that will not open.
	 */
	private static function writer_database( string $file, string $shape ): \PDO {
		Config::ensure_path( \dirname( $file ) );
		$db = Sqlite_Arm::open_database( $file, false, self::BUSY_TIMEOUT_MS );
		$db->exec( "CREATE TABLE IF NOT EXISTS {$shape}" );
		return $db;
	}

	/**
	 * The primary key of a row storing `$names`: `t, k, x`, and `s` for a
	 * Ledger with columns.
	 *
	 * @param array<string,string> $names stored_columns().
	 * @return string The key's columns, comma-separated.
	 */
	private static function key( array $names ): string {
		return \implode( ', ', \array_keys( \array_intersect_key( $names, self::KEY_COLUMNS + self::SEQUENCE_COLUMN ) ) );
	}

	/**
	 * The SQLite file partition `$partition` of a Ledger writes.
	 *
	 * @param string $name      The Ledger.
	 * @param int    $partition The partition.
	 * @return string `{base}/ledgers/{name}.p{partition}.sqlite`.
	 * @throws \InvalidArgumentException On a name that cannot name a file.
	 */
	public static function file( string $name, int $partition ): string {
		return self::directory( $name ) . "/{$name}.p{$partition}.sqlite";
	}

	/**
	 * Every partition's file of a Ledger on disk, found by its name alone: the
	 * one list every reader, the mount and `wp nodes tables` read.
	 *
	 * @api Tables_CLI_Command, which lists and flushes each file.
	 * @param string $name The Ledger.
	 * @return array<int,string> Partition => file, in partition order; none
	 *                           before any writer has made the directory.
	 * @throws \InvalidArgumentException On a name that cannot name a file.
	 * @throws \RuntimeException When the directory will not read.
	 */
	public static function partition_files( string $name ): array {
		$directory = self::directory( $name );
		if ( ! \is_dir( $directory ) ) {
			return [];
		}
		$entries = \scandir( $directory );
		if ( false === $entries ) {
			throw new \RuntimeException( \esc_html( "{$directory} will not read" ) );
		}
		$pattern = '/^' . \preg_quote( $name, '/' ) . '\.p(0|[1-9]\d*)\.sqlite$/D';
		$files   = [];
		foreach ( $entries as $entry ) {
			if ( 1 === \preg_match( $pattern, $entry, $partition ) ) {
				$files[ (int) $partition[1] ] = "{$directory}/{$entry}";
			}
		}
		\ksort( $files );
		return $files;
	}

	/**
	 * The directory every file of a Ledger sits in.
	 *
	 * @param string $name The Ledger.
	 * @return string `{base}/ledgers`.
	 * @throws \InvalidArgumentException On a name that cannot name a file.
	 */
	private static function directory( string $name ): string {
		if ( Sqlite_Arm::refuses_file_name( $name ) ) {
			throw new \InvalidArgumentException( \esc_html( "Ledger name {$name} cannot name a file" ) );
		}
		return Bootstrap::base_dir() . '/ledgers';
	}

	/**
	 * Drop `rows` and declare `$shape` in its place, in one write transaction.
	 * The file stays, so every connection attaching it reads on from the new
	 * table, and the dropped pages are free for its rows.
	 *
	 * @param \PDO   $db    A writer's connection.
	 * @param string $shape shape().
	 * @return array{rows: int} The rows the dropped table held.
	 * @throws \PDOException When the write fails.
	 */
	private static function replace_rows( \PDO $db, string $shape ): array {
		return Sqlite_Arm::immediate(
			$db,
			static function () use ( $db, $shape ): array {
				$count = $db->prepare( 'SELECT COUNT(*) FROM main.rows' );
				Sqlite_Arm::execute( $count );
				$rows = Core::as_int( $count->fetchColumn() );
				// A statement still stepping locks the table DROP removes.
				$count->closeCursor();
				$db->exec( 'DROP TABLE main.rows' );
				$db->exec( "CREATE TABLE main.{$shape}" );
				return [ 'rows' => $rows ];
			}
		);
	}

	/**
	 * A Ledger stores numbers, not encoded values, so it counts no bytes.
	 *
	 * @return int 0.
	 */
	private function stat_bytes(): int {
		return 0;
	}

	/**
	 * Every partition's file of one declared Ledger, attached read-only to an
	 * in-memory connection named `$name` and sinking into `$sink`: how a
	 * request graph mounts a Ledger outside any topology load. It answers
	 * SUM, TOP and MEMBERS over every partition's rows, refuses APPEND and
	 * `flush`, and neither drops nor checkpoints.
	 *
	 * @api Bootstrap::mount_ledger().
	 * @param string                                                             $name        The declared Ledger.
	 * @param array{segment_seconds: int, num_segments: int, columns: list<string>} $declaration The resolved declaration.
	 * @param Node                                                               $sink        Where replies go.
	 * @return self The mount.
	 * @throws \Throwable As arguments(); nothing stays registered, and a
	 *                    teardown that also throws escapes beside the cause.
	 */
	public static function mount( string $name, array $declaration, Node $sink ): self {
		$node          = new self();
		$node->mounted = true;
		$node->name( $name );
		try {
			$node->arguments( [ (string) $declaration['segment_seconds'], (string) $declaration['num_segments'], ...$declaration['columns'] ] );
		} catch ( \Throwable $e ) {
			// name() registers first, so a refusal would orphan the node.
			Worker_Should_Stop::raise( [ $e, ...Worker_Should_Stop::attempt( $node->remove_node( ... ) ) ] );
		}
		$node->sink( $sink );
		return $node;
	}

	/**
	 * Palette entry, argument form, and the requests a Ledger answers.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'Storage',
			'description' => 'Write-once rows clustered by time, in one SQLite file per partition, every read spanning them all; a row past the lifespan drops.',
			'arguments'   => [
				[ 'name' => 'segment_seconds', 'type' => 'int', 'required' => true, 'description' => 'Seconds of t one segment spans, at least 1.' ],
				[ 'name' => 'num_segments', 'type' => 'int', 'required' => true, 'description' => 'Segments kept, at least 1: the lifespan is segment_seconds × num_segments.' ],
				[ 'name' => 'columns', 'type' => 'string', 'variadic' => true, 'description' => 'Numeric columns, each <name>[:sum|min|max], sum by default, never named x; a min or max takes null for a value not measured, a sum never; none makes the Ledger a set.' ],
			],
			'commands'    => [
				self::stats_command( 'Ledger' ),
				[
					'name'        => 'flush',
					'action'      => true,
					'description' => 'Empty this partition\'s file in place: drop its rows table and declare it anew, one transaction, answering the rows it held. The file stays, since other partitions attach it. Refused, naming the restart, when the columns named are not the ones this worker runs; a mount refuses it.',
					'args'        => [ [ 'name' => 'columns', 'type' => 'string', 'variadic' => true, 'description' => 'The columns the topology declares now, each <name>[:sum|min|max].' ] ],
					'handler'     => static function ( Command_Interpreter_Node $interpreter, array $args ): array {
						$patron = $interpreter->patron();
						return $patron instanceof self ? $patron->flush( \array_values( \array_map( Core::as_string( ... ), Core::arr( $args['columns'] ) ) ) ) : throw new \RuntimeException( 'no ledger patron' );
					},
				],
			],
			'requests'    => [
				[
					'name'        => 'APPEND',
					'description' => 'Store rows in one transaction; a row past the lifespan is dropped and counted, and a bad row refuses the whole request.',
					'value'       => 'struct',
					'args'        => [ [ 'name' => 'rows', 'type' => 'json', 'required' => true, 'description' => 'list of [ t, k, x, [ columns… ] ], each column a number, or null in a min or max not measured' ] ],
					'handler'     => static fn ( self $ledger, mixed $rows ): array => $ledger->append( \is_array( $rows ) ? $rows : throw new \InvalidArgumentException( 'needs a list of ' . self::ROW_SHAPE . ' rows' ) ),
					'reply_shape' => 'TM_STRUCT|TM_RESPONSE { verb: APPEND, data: { stored, dropped } }, or a TM_ERROR "APPEND: <why>"',
				],
				[
					'name'        => 'SUM',
					'description' => 'Each ( k, x ) group, or with group k each k across its members, and each per t with by_t, over from ≤ t < to, each column by its declared aggregate, which skips a null; xs narrows the members, to at most 250 with group k. positive keeps a group only when that column\'s aggregate over the range is above 0, every t of it with by_t; positive_each_t filters each stored ( t, k, x ) row instead and totals only the rows that passed, so a member counts in a key and a t only where it passed there itself.',
					'value'       => 'struct',
					'args'        => [ [ 'name' => 'query', 'type' => 'json', 'required' => true, 'description' => '{ from, to, ks: [ k… ], xs?: [ x… ], by_t?: bool, group?: x|k, positive?: column, positive_each_t?: bool }' ] ],
					'handler'     => static fn ( self $ledger, mixed $query ): array => $ledger->read( 'SUM', $query ),
					'reply_shape' => 'TM_STRUCT|TM_RESPONSE { verb: SUM, data: [ [ k, x|null, t|null, columns… ], … ] }, x null with group k and a min or max null where nothing was measured, or a TM_ERROR "SUM: <why>"',
				],
				[
					'name'        => 'TOP',
					'description' => 'The members across every key in ks over from ≤ t < to, ranked by order_by then x, and paged: a column\'s aggregate, x itself, or [ numerator, denominator ] of two sum columns, a zero denominator or a min or max never measured last. positive keeps a member only when that column\'s aggregate is above 0; positive_each_t filters each stored ( t, k, x ) row instead and sums only the rows that passed, so a member counts under a key and at a t only where it passed there itself; a set ranks by x alone.',
					'value'       => 'struct',
					'args'        => [ [ 'name' => 'query', 'type' => 'json', 'required' => true, 'description' => '{ from, to, ks: [ k… ], order_by: x|column|[ sum column, sum column ], order: asc|desc, limit: 1 to TOP_LIMIT_MAX (500), offset, positive?: column, positive_each_t?: bool }' ] ],
					'handler'     => static fn ( self $ledger, mixed $query ): array => $ledger->read( 'TOP', $query ),
					'reply_shape' => 'TM_STRUCT|TM_RESPONSE { verb: TOP, data: { total, rows: [ [ x, columns… ], … ] } }, a min or max null where nothing was measured, or a TM_ERROR "TOP: <why>"',
				],
				[
					'name'        => 'MEMBERS',
					'description' => 'The distinct members of one key over from ≤ t < to, in member order, or { over: limit } when the key holds more than limit in the range; it reads limit + 1 members at most.',
					'value'       => 'struct',
					'args'        => [ [ 'name' => 'query', 'type' => 'json', 'required' => true, 'description' => '{ from, to, k, limit: 1 to MEMBERS_LIMIT_MAX (10000) }' ] ],
					'handler'     => static fn ( self $ledger, mixed $query ): array => $ledger->read( 'MEMBERS', $query ),
					'reply_shape' => 'TM_STRUCT|TM_RESPONSE { verb: MEMBERS, data: [ x, … ] }, or data { over: limit } past the limit, or a TM_ERROR "MEMBERS: <why>"',
				],
			],
			'has_target'  => false,
		];
	}
}
