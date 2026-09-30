<?php
/**
 * Ledger
 *
 * Write-once rows clustered by time, in ONE SQLite file per Ledger,
 * `{base}/ledgers/{name}.sqlite`, which every partition declaring the Ledger
 * writes. A row is `( t, k, x, w, s, c0… )`: `t` the epoch second of the data
 * point, `k` a whitespace-free key, `x` a text member (`''` when unused), `w`
 * the writing partition, `s` that writer's row sequence, and one REAL per
 * declared column: NOT NULL for a `sum`, and null in a `min` or `max` for a
 * value not measured, which the aggregate skips. The primary key
 * `( t, k, x, w, s )` is the whole index, in a `WITHOUT ROWID` table, so rows
 * sit in time order and a flush's rows dirty the few pages at the right edge.
 * A row is never updated: a second row for one `( t, k, x )` is a delta, and
 * every read aggregates the rows it finds by the aggregate its column
 * declares. A Ledger declaring no columns is a set, keyed
 * `( t, k, x )` alone, where an append of a row already there stores nothing.
 * Nothing deletes a row but the segment drop and `flush()`, which drops the
 * `rows` table and declares it anew in one transaction, never unlinking the
 * file every partition holds open.
 *
 * The lineage is Tachikoma's. Its `Table` files each value into the window of
 * its own timestamp (`window_size`, `num_buckets`), which is the time
 * clustering; its `Partition` ages data out by the segment past a lifespan,
 * never by the record, which is the retention: `segment_seconds ×
 * num_segments` on the wall clock. An APPEND row whose `t` is already past
 * the lifespan is dropped and counted, never stored.
 *
 * SQLite serializes the writers on its own lock, so the one-writer-per-file
 * rule for append-by-offset logs (ADR-6) does not bind it (ADR-27): a partition
 * finding the lock held waits BUSY_TIMEOUT_MS. The file opens as its writer in
 * `arguments()`, through `Sqlite_Arm::open_database()`, the one place a SQLite
 * file opens. It answers the TM_REQUEST|TM_STRUCT `APPEND` TO its FROM
 * (ADR-23), one transaction a request; `append()` is the same write for a
 * caller outside a graph. The reads `SUM`, `TOP` and `MEMBERS` answer the
 * same way, each over `from ≤ t < to` and every partition's rows, with SQL
 * built from the declaration alone: a column a request names is looked up in
 * it, and a name it does not hold, or a use its aggregate has no meaning
 * for, is refused. A request graph reads through `mount()`, a read-only
 * connection under the Ledger's own name, which answers the reads and
 * refuses APPEND.
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
	 * How long a write waits on another partition's write lock, in
	 * milliseconds: the longest flush it may have to wait out.
	 */
	public const BUSY_TIMEOUT_MS = 5000;

	/**
	 * Rows one segment-drop statement deletes at most: a batch the tick's
	 * budget can stop between, where a whole segment in one statement would
	 * hold the file's write lock, and every other partition's flush, for as
	 * long as its rows take.
	 */
	public const DROP_BATCH_ROWS = 20000;

	/** Most rows one TOP answers: a page, never a dump of every member. */
	public const TOP_LIMIT_MAX = Sqlite_Arm::IN_CHUNK;

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

	/** The key a row of a Ledger with columns adds, naming its writer. */
	private const WRITER_COLUMNS = [
		'w' => 'INTEGER NOT NULL',
		's' => 'INTEGER NOT NULL',
	];

	/** Why a mount refuses an APPEND. */
	private const READS_ONLY = 'a mounted Ledger serves reads only';

	/** One APPEND row, as a refusal names it. */
	private const ROW_SHAPE = '[ t, k, x, [ columns… ] ]';

	/**
	 * Each distinct `t` in `from ≤ t < to`, as `ts.at`, each found by one
	 * primary-key seek past the last: a loose index scan. Binds from, to, to.
	 * The walk's column is `at`, so a bare `t` beside it is the row's.
	 */
	private const WALK = 'WITH RECURSIVE ts ( at ) AS ( SELECT MIN( t ) FROM rows WHERE t >= ? AND t < ? UNION ALL SELECT ( SELECT MIN( t ) FROM rows WHERE t > ts.at AND t < ? ) FROM ts WHERE ts.at IS NOT NULL ) ';

	/** The rows at each walked `t`; CROSS JOIN keeps the walk outer, so each `t` seeks its keys. */
	private const AT_EACH_T = 'FROM ts CROSS JOIN rows WHERE rows.t = ts.at';

	/** A key's distinct members in a `t` range; binds from, to, to, k. */
	private const MEMBERS_READ = self::WALK . 'SELECT DISTINCT x ' . self::AT_EACH_T . ' AND k = ? ORDER BY x';

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

	/** The writer's connection; null until arguments() opens the file. */
	private ?\PDO $db = null;

	/** The one INSERT an APPEND runs per row. */
	private ?\PDOStatement $insert = null;

	/** The one SELECT a MEMBERS runs. */
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

	/** The partition this writer's rows carry as `w`. */
	private int $partition = 0;

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
	 * A writer prepares its writes and a mount its reads alone.
	 *
	 * @param list<string>|null $args
	 * @return list<string>
	 * @throws \InvalidArgumentException On a count below 1, a column it cannot
	 *                                   declare, or a missing count.
	 * @throws \RuntimeException On a file that will not open as this Ledger's,
	 *                           or no bound partition.
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
		[ $db, $partition ] = $this->open( $names );
		$this->assign_schema_args( $args, $values );
		$this->db             = $db;
		$this->select_members = $db->prepare( self::MEMBERS_READ );
		if ( ! $this->mounted ) {
			$this->insert     = $db->prepare( ( [] === $values['columns'] ? 'INSERT OR IGNORE' : 'INSERT' ) . ' INTO rows ( ' . \implode( ', ', \array_keys( $names ) ) . ' ) VALUES ( ' . self::placeholders( $names ) . ' )' );
			$this->checkpoint = $db->prepare( Sqlite_Arm::PASSIVE_CHECKPOINT );
			$this->drop       = $db->prepare( 'DELETE FROM rows WHERE ( ' . self::key( $names ) . ' ) IN ( SELECT ' . self::key( $names ) . ' FROM rows WHERE t < ? LIMIT ? )' );
			$this->partition  = $partition;
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
	 * Open the file and hold its `rows` table to `$names`, refusing a table
	 * another declaration made: this Ledger's rows would not fit it. A writer
	 * opens the file as its writer and declares the table. A mount opens it
	 * read-only and creates nothing; before any writer has made the file it
	 * reads an empty table of this shape, in memory.
	 *
	 * @param array<string,string> $names stored_columns().
	 * @return array{0: \PDO, 1: int} The connection, and the bound partition a
	 *                                writer's rows carry as `w`; 0 for a mount.
	 * @throws \RuntimeException Naming the Ledger, on no bound partition, a
	 *                           name no file can carry, a directory or file that
	 *                           will not open, a mount as root, or a table of
	 *                           another shape.
	 */
	private function open( array $names ): array {
		try {
			$file  = self::file( $this->name );
			$shape = self::shape( $names );
			if ( $this->mounted ) {
				Sqlite_Arm::refuse_root_reader( $file );
				$partition = 0;
				$db        = \is_file( $file ) ? Sqlite_Arm::open_database( $file, true, self::BUSY_TIMEOUT_MS ) : self::in_memory( $shape );
			} else {
				$partition = $this->bound_partition();
				$db        = self::writer_database( $file, $shape );
			}
			$held = $db->prepare( "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rows'" );
			Sqlite_Arm::execute( $held );
			if ( "CREATE TABLE {$shape}" !== $held->fetchColumn() ) {
				throw new \UnexpectedValueException( "{$file} holds a rows table another declaration made; `wp nodes tables flush` drops the rows written under it and declares this one" );
			}
			return [ $db, $partition ];
		} catch ( Worker_Should_Stop $stop ) {
			throw $stop;
		} catch ( \RuntimeException | \LogicException $e ) {
			throw new \RuntimeException( \esc_html( "Ledger {$this->name}: " . $e->getMessage() ), 0, $e );
		}
	}

	/**
	 * An empty `rows` table in memory: what a mount reads before any writer
	 * has made the file, so every read answers empty down its one path.
	 *
	 * @param string $shape shape().
	 * @return \PDO The connection.
	 */
	private static function in_memory( string $shape ): \PDO {
		$db = new \PDO( 'sqlite::memory:', null, null, [ \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION ] );
		$db->exec( "CREATE TABLE {$shape}" );
		return $db;
	}

	/**
	 * The process's bound `<partition>`, which every row this writer stores
	 * carries: never a guess, which would write under another's.
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
			Sqlite_Arm::execute( $insert, [] === $this->columns ? [ $t, $k, $x ] : [ $t, $k, $x, $this->partition, ++$this->sequence, ...$columns ] );
			$stored += $insert->rowCount();
		}
		return $stored;
	}

	/**
	 * One read request, answered and counted as one call of its verb: the
	 * keys it asked, and the rows it answered.
	 *
	 * @param 'SUM'|'TOP'|'MEMBERS' $verb  The read.
	 * @param mixed                 $query The request's map of fields.
	 * @return array<array-key,mixed> The reply's `data`.
	 * @throws \InvalidArgumentException On a query the read refuses.
	 * @throws \PDOException When the read fails.
	 */
	private function read( string $verb, mixed $query ): array {
		$started  = self::monotonic_ns();
		$bytes    = $this->stat_bytes();
		$asked    = 0;
		$answered = 0;
		try {
			$query                       = \is_array( $query ) ? $query : throw new \InvalidArgumentException( 'needs a map of its fields' );
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
		foreach ( \array_chunk( $ks, null === $xs ? Sqlite_Arm::IN_CHUNK : self::PAIRED_CHUNK ) as $k_chunk ) {
			foreach ( null === $xs ? [ [] ] : \array_chunk( $xs, self::PAIRED_CHUNK ) as $x_chunk ) {
				$members = null === $xs ? '' : ' AND x IN ( ' . self::placeholders( $x_chunk ) . ' )';
				$keyed   = self::AT_EACH_T . ' AND k IN ( ' . self::placeholders( $k_chunk ) . " ){$members}";
				$found[] = $this->rows( self::WALK . "SELECT {$pick} " . $this->grouped( $keyed, $by, $by_t, $positive, $each_t ) . " ORDER BY {$order}", [ ...$walk, ...$k_chunk, ...$x_chunk ] );
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
	 * and one read transaction holds the count and the page to one snapshot.
	 * A set ranks by `x` alone.
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
		$groups = $this->grouped( self::AT_EACH_T . ' AND k IN ( ' . self::placeholders( $ks ) . ' )', [ 'x' ], false, $positive, $each_t );
		$page   = self::WALK . 'SELECT ' . \implode( ', ', [ 'x', ...$aggregates ] ) . " {$groups} ORDER BY {$rank} " . \strtoupper( $order ) . ' NULLS LAST, x LIMIT ? OFFSET ?';
		[ $total, $rows ] = Sqlite_Arm::deferred(
			$this->db ?? throw $this->unopened(),
			fn (): array => [
				$this->rows( self::WALK . "SELECT COUNT(*) FROM ( SELECT x {$groups} )", [ ...$walk, ...$ks ] ),
				$this->rows( $page, [ ...$walk, ...$ks, $limit, $offset ] ),
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
	 * The rows a SUM or a TOP aggregates, as SQL after its SELECT list: the
	 * keyed rows at each walked `t`, grouped by `$by`, and by `t` as well with
	 * `$by_t`. Every form keeps each stored column's name, so aggregates()
	 * selects from any of them. `$positive` keeps a group only when its
	 * aggregate of that column over the range is above 0, every `t` of it
	 * with `$by_t`; with `$each_t` it filters each `( t, $by )` group, and
	 * only the groups that pass are aggregated over the range.
	 *
	 * @param string       $keyed    AT_EACH_T and the read's key and member tests.
	 * @param list<string> $by       The grouping, `t` aside.
	 * @param bool         $by_t     Whether each group splits per `t`.
	 * @param string|null  $positive The declared column above 0, or null.
	 * @param bool         $each_t   Whether it is above 0 at each `t`.
	 * @return string `FROM … GROUP BY …`, with the filter where one applies.
	 */
	private function grouped( string $keyed, array $by, bool $by_t, ?string $positive, bool $each_t ): string {
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
		$inner = 'SELECT ' . \implode( ', ', [ ...$per_t, ...self::aliased( $aggregates ) ] );
		$split = ' GROUP BY ' . \implode( ', ', $per_t );
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
	 * `MEMBERS`: the distinct members of one key, in member order.
	 *
	 * @param array<array-key,mixed> $query `{ from, to, k }`.
	 * @return array{0: int, 1: list<string>, 2: int} The one key asked, its
	 *                                                members, and their count.
	 * @throws \InvalidArgumentException On a query it refuses.
	 */
	private function read_members( array $query ): array {
		self::only( $query, 'from', 'to', 'k' );
		$k       = \is_string( $query['k'] ?? null ) ? $query['k'] : throw new \InvalidArgumentException( 'k is a string' );
		$read    = $this->select_members ?? throw $this->unopened();
		$members = \array_map( Core::as_string( ... ), \array_column( self::fetched( $read, [ ...self::walk( $query ), $k ] ), 0 ) );
		return [ 1, $members, \count( $members ) ];
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
	 * The values WALK binds for a query's `t` range.
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
	 * and its trace line while traced. Every partition's writer runs both on
	 * the one file, so a second drop finds nothing and a checkpoint another
	 * partition's write outlasts finishes on a later tick. A mount prepares
	 * neither statement, so it does neither.
	 * See Tick_Housekeeper::tick_steps() for the steps.
	 *
	 * @param int $now The tick, in epoch seconds.
	 */
	public function tick_steps( int $now ): array {
		$db         = $this->db;
		$drop       = $this->drop;
		$checkpoint = $this->checkpoint;
		$purge      = null;
		if ( null !== $db && null !== $drop ) {
			$edge   = $now - $this->segment_seconds * $this->num_segments;
			$cutoff = $edge - $edge % $this->segment_seconds;
			$purge  = $cutoff > $this->dropped_below ? fn ( float $until ) => $this->drop_segments( $db, $drop, $cutoff, $until ) : null;
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
	 * under the backlog budget. Each batch meeting another partition's write
	 * lock waits only what the tick's budget has left when it starts, at
	 * least 1 ms, rather than BUSY_TIMEOUT_MS, which the connection takes
	 * back after the drop; then the
	 * drop is skipped, logged rate-limited, and the next tick tries again.
	 * Every row below the cutoff is past the lifespan, so no drop, whole or
	 * cut short, deletes a row inside it.
	 *
	 * @param \PDO          $db     The writer's connection.
	 * @param \PDOStatement $drop   The prepared DELETE.
	 * @param int           $cutoff Every row whose `t` is below it goes.
	 * @param float         $until  The tick's deadline, shared by every store.
	 */
	private function drop_segments( \PDO $db, \PDOStatement $drop, int $cutoff, float $until ): void {
		$drop->bindValue( 1, $cutoff, \PDO::PARAM_INT );
		$drop->bindValue( 2, self::DROP_BATCH_ROWS, \PDO::PARAM_INT );
		$batch = static function () use ( $db, $drop, $until ): int {
			Sqlite_Arm::busy_timeout( $db, (int) \round( ( $until - Core::right_now() ) * 1000 ) );
			Sqlite_Arm::execute( $drop );
			return $drop->rowCount();
		};
		try {
			[ $dropped, $batches ] = $this->delete_batches( 'DROP', $batch, self::DROP_BATCH_ROWS, $until );
		} catch ( \PDOException $e ) {
			$this->print_less_often( 'WARNING: segment drop skipped: ', $e->getMessage() . '; the next tick tries again' );
			return;
		} finally {
			Sqlite_Arm::busy_timeout( $db, self::BUSY_TIMEOUT_MS );
		}
		$this->drop_behind = $batches * self::DROP_BATCH_ROWS === $dropped;
		if ( $this->drop_behind ) {
			$this->print_less_often( 'WARNING: segment drop is behind: ', "its last batch came back full after {$batches} batches, {$dropped} rows; the next tick drops on under the backlog budget" );
			return;
		}
		$this->dropped_below = $cutoff;
	}

	/**
	 * Empty this Ledger in place: replace_rows() over the writer's connection,
	 * declaring the table this node declares, but only while `$columns`, the
	 * columns its topology declares now, are the ones this node runs. Every
	 * other partition's writer writes on into the same file. The drop and the
	 * checkpoint schedule start over, as they do for a new writer.
	 * Verb-exposed (`flush <column>…`).
	 *
	 * @param list<string> $columns The declared columns, `<name>[:sum|min|max]`.
	 * @return array{rows: int} The rows the Ledger held.
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
	 * Empty a Ledger no live worker holds, from the declaration alone, as
	 * `wp nodes tables flush` does: replace_rows() over a writer's connection
	 * of its own, whatever table the file held. A Ledger whose declaration
	 * changed its columns, and so will not open, opens after it.
	 *
	 * @api Tables_CLI_Command::flush(), for a Ledger no live worker declares.
	 * @param string                                                             $name        The declared Ledger.
	 * @param array{segment_seconds: int, num_segments: int, columns: list<string>} $declaration The resolved declaration.
	 * @return array{rows: int} The rows the file held.
	 * @throws \InvalidArgumentException On a name that cannot name a file.
	 * @throws \RuntimeException On a directory or file that will not open, or
	 *                           a write that fails.
	 */
	public static function flush_file( string $name, array $declaration ): array {
		$shape = self::shape( self::stored_columns( \array_map( static fn ( string $column ): string => self::name_and_aggregate( $column )[1], $declaration['columns'] ) ) );
		return self::replace_rows( self::writer_database( self::file( $name ), $shape ), $shape );
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
	 * then for a Ledger with columns its writer and c0… as REAL, NOT NULL
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
		return self::KEY_COLUMNS + self::WRITER_COLUMNS + $values;
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
	 * The primary key of a row storing `$names`: `t, k, x`, and `w, s` for a
	 * Ledger with columns.
	 *
	 * @param array<string,string> $names stored_columns().
	 * @return string The key's columns, comma-separated.
	 */
	private static function key( array $names ): string {
		return \implode( ', ', \array_keys( \array_intersect_key( $names, self::KEY_COLUMNS + self::WRITER_COLUMNS ) ) );
	}

	/**
	 * The one SQLite file of a Ledger, whatever the partition.
	 *
	 * @param string $name The Ledger.
	 * @return string `{base}/ledgers/{name}.sqlite`.
	 * @throws \InvalidArgumentException On a name that cannot name a file.
	 */
	public static function file( string $name ): string {
		if ( Sqlite_Arm::refuses_file_name( $name ) ) {
			throw new \InvalidArgumentException( \esc_html( "Ledger name {$name} cannot name a file" ) );
		}
		return Bootstrap::base_dir() . "/ledgers/{$name}.sqlite";
	}

	/**
	 * Drop `rows` and declare `$shape` in its place, in one write transaction.
	 * The file stays, so every connection another partition holds writes on
	 * into the new table, and the dropped pages are free for its rows.
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
				$count = $db->prepare( 'SELECT COUNT(*) FROM rows' );
				Sqlite_Arm::execute( $count );
				$rows = Core::as_int( $count->fetchColumn() );
				// A statement still stepping locks the table DROP removes.
				$count->closeCursor();
				$db->exec( 'DROP TABLE rows' );
				$db->exec( "CREATE TABLE {$shape}" );
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
	 * One declared Ledger's file, read-only, named `$name` and sinking into
	 * `$sink`: how a request graph mounts a Ledger outside any topology load.
	 * It answers SUM, TOP and MEMBERS over every partition's rows, refuses
	 * APPEND and `flush`, and neither drops nor checkpoints.
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
			'description' => 'Write-once rows clustered by time, in one SQLite file every partition declaring the Ledger shares; a row past the lifespan drops.',
			'arguments'   => [
				[ 'name' => 'segment_seconds', 'type' => 'int', 'required' => true, 'description' => 'Seconds of t one segment spans, at least 1.' ],
				[ 'name' => 'num_segments', 'type' => 'int', 'required' => true, 'description' => 'Segments kept, at least 1: the lifespan is segment_seconds × num_segments.' ],
				[ 'name' => 'columns', 'type' => 'string', 'variadic' => true, 'description' => 'Numeric columns, each <name>[:sum|min|max], sum by default, never named x; a min or max takes null for a value not measured, a sum never; none makes the Ledger a set.' ],
			],
			'commands'    => [
				[
					'name'        => 'flush',
					'action'      => true,
					'description' => 'Empty the Ledger in place: drop its rows table and declare it anew, one transaction, answering the rows it held. The file stays, since every partition holds it open. Refused, naming the restart, when the columns named are not the ones this worker runs; a mount refuses it.',
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
					'description' => 'Each ( k, x ) group, or with group k each k across its members, and each per t with by_t, over from ≤ t < to, each column by its declared aggregate, which skips a null; xs narrows the members, to at most 250 with group k. positive keeps a group only when that column\'s aggregate over the range is above 0, every t of it with by_t, or with positive_each_t totals only the ( t, group ) rows in which it was.',
					'value'       => 'struct',
					'args'        => [ [ 'name' => 'query', 'type' => 'json', 'required' => true, 'description' => '{ from, to, ks: [ k… ], xs?: [ x… ], by_t?: bool, group?: x|k, positive?: column, positive_each_t?: bool }' ] ],
					'handler'     => static fn ( self $ledger, mixed $query ): array => $ledger->read( 'SUM', $query ),
					'reply_shape' => 'TM_STRUCT|TM_RESPONSE { verb: SUM, data: [ [ k, x|null, t|null, columns… ], … ] }, x null with group k and a min or max null where nothing was measured, or a TM_ERROR "SUM: <why>"',
				],
				[
					'name'        => 'TOP',
					'description' => 'The members across every key in ks over from ≤ t < to, ranked by order_by then x, and paged: a column\'s aggregate, x itself, or [ numerator, denominator ] of two sum columns, a zero denominator or a min or max never measured last. positive keeps a member only when that column\'s aggregate is above 0, or with positive_each_t sums only the t in which it was; a set ranks by x alone.',
					'value'       => 'struct',
					'args'        => [ [ 'name' => 'query', 'type' => 'json', 'required' => true, 'description' => '{ from, to, ks: [ k… ], order_by: x|column|[ sum column, sum column ], order: asc|desc, limit: 1 to TOP_LIMIT_MAX (500), offset, positive?: column, positive_each_t?: bool }' ] ],
					'handler'     => static fn ( self $ledger, mixed $query ): array => $ledger->read( 'TOP', $query ),
					'reply_shape' => 'TM_STRUCT|TM_RESPONSE { verb: TOP, data: { total, rows: [ [ x, columns… ], … ] } }, a min or max null where nothing was measured, or a TM_ERROR "TOP: <why>"',
				],
				[
					'name'        => 'MEMBERS',
					'description' => 'The distinct members of one key over from ≤ t < to, in member order.',
					'value'       => 'struct',
					'args'        => [ [ 'name' => 'query', 'type' => 'json', 'required' => true, 'description' => '{ from, to, k }' ] ],
					'handler'     => static fn ( self $ledger, mixed $query ): array => $ledger->read( 'MEMBERS', $query ),
					'reply_shape' => 'TM_STRUCT|TM_RESPONSE { verb: MEMBERS, data: [ x, … ] }, or a TM_ERROR "MEMBERS: <why>"',
				],
			],
			'has_target'  => false,
		];
	}
}
