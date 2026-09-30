<?php
/**
 * Ledger
 *
 * Write-once rows clustered by time, in ONE SQLite file per Ledger,
 * `{base}/ledgers/{name}.sqlite`, which every partition declaring the Ledger
 * writes. A row is `( t, k, x, w, s, c0… )`: `t` the epoch second of the data
 * point, `k` a whitespace-free key, `x` a text member (`''` when unused), `w`
 * the writing partition, `s` that writer's row sequence, and one REAL per
 * declared column. The primary key `( t, k, x, w, s )` is the whole index, in a
 * `WITHOUT ROWID` table, so rows sit in time order and a flush's rows dirty the
 * few pages at the right edge. A row is never updated: a second row for one
 * `( t, k, x )` is a delta, and every read aggregates the rows it finds by the
 * aggregate its column declares. A Ledger declaring no columns is a set, keyed
 * `( t, k, x )` alone, where an append of a row already there stores nothing.
 *
 * The lineage is Tachikoma's. Its `Table` files each value into the window of
 * its own timestamp (`window_size`, `num_buckets`), which is the time
 * clustering; its `Partition` ages data out by the segment past a lifespan,
 * never by the record, which is the retention: `segment_seconds ×
 * num_segments` on the wall clock. An APPEND row whose `t` is already past
 * the lifespan is dropped and counted, never stored.
 *
 * SQLite serializes the writers on its own lock, so the one-writer-per-file
 * rule for append-by-offset logs (ADR-6) does not bind it: a partition finding
 * the lock held waits BUSY_TIMEOUT_MS. The file opens as its writer in
 * `arguments()`, through `Sqlite_Arm::open_database()`, the one place a SQLite
 * file opens. It answers the TM_REQUEST|TM_STRUCT `APPEND` TO its FROM
 * (ADR-23), one transaction a request; `append()` is the same write for a
 * caller outside a graph.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Ledger node — `make_node Ledger <name> <segment_seconds> <num_segments> <column>[:sum|min|max] …`.
 */
final class Ledger_Node extends Node {
	use Schema_Reflection;
	use Verb_Stats;

	/**
	 * How long a write waits on another partition's write lock, in
	 * milliseconds: the longest flush it may have to wait out.
	 */
	public const BUSY_TIMEOUT_MS = 5000;

	/** What a read may apply to a column; `sum` when a column names none. */
	public const AGGREGATES = [ 'sum', 'min', 'max' ];

	/** The key every row carries, in key order, with its type. */
	private const KEY_COLUMNS = [
		't' => 'INTEGER',
		'k' => 'TEXT',
		'x' => 'TEXT',
	];

	/** The key a row of a Ledger with columns adds, naming its writer. */
	private const WRITER_COLUMNS = [
		'w' => 'INTEGER',
		's' => 'INTEGER',
	];

	/** One APPEND row, as a refusal names it. */
	private const ROW_SHAPE = '[ t, k, x, [ columns… ] ]';

	/** The verbs a Ledger counts. */
	private const ZERO_STATS = [ 'APPEND' => self::ZERO_ROW ];

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

	/** The partition this writer's rows carry as `w`. */
	private int $partition = 0;

	/** The last `s` this writer gave a row, seeded from hrtime at open. */
	private int $sequence = 0;

	/**
	 * `<segment_seconds> <num_segments> [<column>[:sum|min|max] …]`. Both
	 * counts are whole numbers of at least 1. Each column is named once, in
	 * `[A-Za-z_][A-Za-z0-9_]*`, and its aggregate is one of AGGREGATES; no
	 * column makes the Ledger a set. Every token is checked, and the file
	 * opened as its writer, before any field moves, so a refusal leaves the
	 * node as it was.
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
		$names             = self::stored_columns( \count( $values['columns'] ) );
		[ $db, $partition ] = $this->open( $names );
		$this->assign_schema_args( $args, $values );
		$this->db        = $db;
		$this->insert    = $db->prepare( ( [] === $values['columns'] ? 'INSERT OR IGNORE' : 'INSERT' ) . ' INTO rows ( ' . \implode( ', ', \array_keys( $names ) ) . ' ) VALUES ( ' . \implode( ', ', \array_fill( 0, \count( $names ), '?' ) ) . ' )' );
		$this->partition = $partition;
		$this->sequence  = (int) \hrtime( true );
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
	 * Each column token as name => aggregate, in declaration order.
	 *
	 * @param array<string> $tokens `<name>[:sum|min|max]` each.
	 * @return array<string,string> Name => aggregate.
	 * @throws \InvalidArgumentException On a name out of pattern or declared
	 *                                   twice, or an unknown aggregate.
	 */
	private function declared_columns( array $tokens ): array {
		$columns = [];
		foreach ( $tokens as $token ) {
			[ $name, $aggregate ] = \explode( ':', $token, 2 ) + [ 1 => 'sum' ];
			if ( 1 !== \preg_match( '/^[A-Za-z_][A-Za-z0-9_]*$/D', $name ) || isset( $columns[ $name ] ) ) {
				$this->refuse_argument( "column {$token}: a name in [A-Za-z_][A-Za-z0-9_]*, declared once" );
			}
			if ( ! \in_array( $aggregate, self::AGGREGATES, true ) ) {
				$this->refuse_argument( "column {$token}: the aggregate is one of " . \implode( ', ', self::AGGREGATES ) );
			}
			$columns[ $name ] = $aggregate;
		}
		return $columns;
	}

	/**
	 * Every column a row stores, in order, with its type: the key, then for a
	 * Ledger with columns its writer and c0… as REAL.
	 *
	 * @param int $width Declared columns.
	 * @return array<string,string> Name => SQLite type.
	 */
	private static function stored_columns( int $width ): array {
		if ( 0 === $width ) {
			return self::KEY_COLUMNS;
		}
		$values = [];
		for ( $i = 0; $i < $width; ++$i ) {
			$values[ "c{$i}" ] = 'REAL';
		}
		return self::KEY_COLUMNS + self::WRITER_COLUMNS + $values;
	}

	/**
	 * Open the file as its writer and declare its `rows` table, refusing a file
	 * whose table another declaration made: this Ledger's rows would not fit it.
	 *
	 * @param array<string,string> $names Every stored column with its type.
	 * @return array{0: \PDO, 1: int} The writer's connection, and the bound
	 *                                partition its rows carry as `w`.
	 * @throws \RuntimeException Naming the Ledger, on no bound partition, a
	 *                           name no file can carry, a directory or file that
	 *                           will not open, or a table of another shape.
	 */
	private function open( array $names ): array {
		try {
			$partition = $this->bound_partition();
			$file   = self::file( $this->name );
			$key    = \array_keys( \array_intersect_key( $names, self::KEY_COLUMNS + self::WRITER_COLUMNS ) );
			$fields = \implode( ', ', \array_map( static fn ( string $name, string $type ): string => "{$name} {$type} NOT NULL", \array_keys( $names ), $names ) );
			$shape  = "rows ( {$fields}, PRIMARY KEY ( " . \implode( ', ', $key ) . ' ) ) WITHOUT ROWID';
			Config::ensure_path( \dirname( $file ) );
			$db = Sqlite_Arm::open_database( $file, false, self::BUSY_TIMEOUT_MS );
			$db->exec( "CREATE TABLE IF NOT EXISTS {$shape}" );
			$held = $db->prepare( "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rows'" );
			$held->execute();
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
	 * `APPEND` for a caller outside a graph, down the path the request takes:
	 * every row checked first, then each inside the lifespan stored in one
	 * `BEGIN IMMEDIATE … COMMIT`, and each past it dropped. Counted as one
	 * APPEND call: the rows asked, and the rows stored.
	 *
	 * @api Writers outside a graph, and the APPEND request's handler.
	 * @param array<array-key,mixed> $rows `[ t, k, x, [ columns… ] ]` each, one
	 *                                     column per declared column in order.
	 * @return array{stored: int, dropped: int} Rows stored, and rows dropped as
	 *                                          past the lifespan; a set's row
	 *                                          already held is neither.
	 * @throws \InvalidArgumentException On a row of another shape, a key that
	 *                                   is empty or holds whitespace, or a
	 *                                   column count other than the declared.
	 * @throws \PDOException When the write fails, the lock held past
	 *                       BUSY_TIMEOUT_MS among the causes.
	 * @throws \LogicException Before arguments() has opened the file.
	 */
	public function append( array $rows ): array {
		$started = self::monotonic_ns();
		$bytes   = $this->stat_bytes();
		$stored  = 0;
		try {
			$db     = $this->db ?? throw new \LogicException( \esc_html( "Ledger {$this->name} has opened no file" ) );
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
	 * @return list<array{0: int, 1: string, 2: string, 3: list<int|float>}> Rows to store.
	 * @throws \InvalidArgumentException On the first row it refuses, naming it.
	 */
	private function kept_rows( array $rows, int $cutoff ): array {
		$width = \count( $this->columns );
		$kept  = [];
		foreach ( $rows as $i => $row ) {
			[ $t, $k, $x, $columns ] = \is_array( $row ) && [ 0, 1, 2, 3 ] === \array_keys( $row ) ? $row : [ null, null, null, null ];
			$numbers                 = \is_array( $columns ) ? \array_filter( $columns, static fn ( mixed $column ): bool => \is_int( $column ) || \is_float( $column ) ) : [];
			if ( ! \is_int( $t ) || ! \is_string( $k ) || ! \is_string( $x ) || ! \is_array( $columns ) || ! \array_is_list( $columns ) || \count( $numbers ) !== \count( $columns ) ) {
				self::refuse_row( $i, 'needs ' . self::ROW_SHAPE . ', t whole seconds and each column a number' );
			}
			if ( Cache_Backend::refuses_key( $k ) ) {
				self::refuse_row( $i, 'key is empty or holds whitespace' );
			}
			if ( \count( $numbers ) !== $width ) {
				self::refuse_row( $i, \count( $numbers ) . " columns, the Ledger declares {$width}" );
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
	 * @param list<array{0: int, 1: string, 2: string, 3: list<int|float>}> $rows Rows to store.
	 * @return int Rows stored; a set's row already held stores none.
	 */
	private function insert_rows( array $rows ): int {
		$insert = $this->insert ?? throw new \LogicException( \esc_html( "Ledger {$this->name} has opened no file" ) );
		$stored = 0;
		foreach ( $rows as [ $t, $k, $x, $columns ] ) {
			$insert->execute( [] === $this->columns ? [ $t, $k, $x ] : [ $t, $k, $x, $this->partition, ++$this->sequence, ...$columns ] );
			$stored += $insert->rowCount();
		}
		return $stored;
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
				[ 'name' => 'columns', 'type' => 'string', 'variadic' => true, 'description' => 'Numeric columns, each <name>[:sum|min|max], sum by default; none makes the Ledger a set.' ],
			],
			'requests'    => [
				[
					'name'        => 'APPEND',
					'description' => 'Store rows in one transaction; a row past the lifespan is dropped and counted, and a bad row refuses the whole request.',
					'value'       => 'struct',
					'args'        => [ [ 'name' => 'rows', 'type' => 'json', 'required' => true, 'description' => 'list of [ t, k, x, [ columns… ] ]' ] ],
					'handler'     => static fn ( self $ledger, mixed $rows ): array => $ledger->append( \is_array( $rows ) ? $rows : throw new \InvalidArgumentException( 'needs a list of ' . self::ROW_SHAPE . ' rows' ) ),
					'reply_shape' => 'TM_STRUCT|TM_RESPONSE { verb: APPEND, data: { stored, dropped } }, or a TM_ERROR "APPEND: <why>"',
				],
			],
			'has_target'  => false,
		];
	}
}
