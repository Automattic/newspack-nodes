<?php
/**
 * Row_Table
 *
 * A Table whose SQLite file holds the row tables a `Row_Schema` declares
 * rather than keyed entries: `make_node Row_Table <name> <Schema>`, where
 * `<Schema>` is a word naming `<Namespace>\<Schema>_Row_Schema` in a
 * namespace `Command_Interpreter_Node::register_namespace()` registered. Its
 * worker writes one file per partition, `{base}/tables/{name}.p{N}.sqlite`,
 * through the `ROWS` request, one batch of ops in one transaction; every
 * keyed request is refused. `read()` attaches every partition's file
 * read-only into one connection, so a reader queries the fleet's rows in one
 * statement and nothing merges them in PHP.
 *
 * The schema is checked before the file opens: identifiers, the closed set
 * of column types, `add` columns outside the key, an INTEGER
 * `autoincrement`, a `retain` and each `retained_by` reference served by an
 * index or the key, TEXT `fts` columns no `add` folds, every table purged by
 * its own `retain` or by a `retained_by`, and no `retained_by` cycle.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Row_Table node — `make_node Row_Table <name> <Schema>`.
 *
 * @phpstan-import-type Row_Spec from Sqlite_Arm
 */
class Row_Table_Node extends Table_Node {

	/** A table, column or index name a schema may declare. */
	private const IDENTIFIER = '/^[a-z_][a-z0-9_]*$/D';

	/** A column type a schema may declare. */
	private const COLUMN_TYPE = '/^(INTEGER|REAL|TEXT|BLOB)( NOT NULL)?$/D';

	/** A schema word: one name, so it cannot reach into another namespace. */
	private const SCHEMA_WORD = '/^[A-Za-z][A-Za-z0-9_]*$/D';

	/** A fold an `add` column may name; anything else would sum in silence. */
	private const FOLD = '/^(sum|max)$/D';

	/** How a ROWS request is answered. */
	private const ROWS_REPLY = 'one TM_RESPONSE "ROWS <rows written or folded>", or one TM_ERROR "ROWS: <why>", the batch rolled back';

	/**
	 * Build-file sync seam: `build()` syncs the finished build to disk before
	 * the rename publishes it. Tests reassign it to record the order of sync
	 * and publish, or to fail it.
	 * Signature: `function ( string $file ): bool`, true once synced.
	 *
	 * @var (\Closure(string): bool)|null
	 */
	public static ?\Closure $fsync = null;

	/** Joins a snapshot's name to a build's id; no Table or snapshot name holds it. */
	private const BUILD_JOIN = '+';

	/** The schema word this Row_Table was declared with. */
	private string $schema = '';

	/**
	 * `<Schema>`: resolve the word, check the schema, then open the file at
	 * its version with its tables declared. A refusal opens nothing.
	 *
	 * @param list<string>|null $args
	 * @return list<string>
	 * @throws \InvalidArgumentException With no schema word.
	 * @throws \RuntimeException On a word naming no Row_Schema, a schema it
	 *                           refuses, or a file SQLite refuses.
	 * @throws Table_Unavailable When pdo_sqlite is missing.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$values = $this->schema_values( $args );
		$word   = Core::as_string( $values['schema'] );
		$schema = self::schema_class( $word, $this->name );
		$tables = $schema::tables();
		self::check_schema( $word, $tables );
		$this->declare_store( $this->name, null, 'sqlite', [ 'version' => $schema::version(), 'tables' => $tables ] );
		$this->schema    = $word;
		$this->arguments = $args;
		return $args;
	}

	/**
	 * Refuse a keyed INSERT, which a Row_Table has no keyed store for, then
	 * answer a request or forward as a Table does.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 * @throws \RuntimeException With no wired sink to forward or reply through.
	 */
	public function fill( array $message ): void {
		if ( 0 === ( Core::num_int( $message[ Message::TYPE ] ) & Message::TM_REQUEST ) && '' !== Core::as_string( $message[ Message::KEY ], '' ) ) {
			$this->print_less_often( "ERROR: refused an INSERT through Row_Table {$this->name}, which takes ROWS alone - from: ", Core::as_string( $message[ Message::FROM ], '' ) );
			return;
		}
		parent::fill( $message );
	}

	/**
	 * Check every table a schema declares, and that one retains, so a purge
	 * starts. Every name the file's DDL would take — each table, index, FTS
	 * shadow and trigger, and the kv store's own — is taken once, since
	 * `CREATE … IF NOT EXISTS` skips a second in silence.
	 *
	 * @param string                $word   The schema word, for a refusal.
	 * @param array<string,Row_Spec> $tables Its tables.
	 * @throws \RuntimeException Naming the schema and the item it refuses.
	 */
	private static function check_schema( string $word, array $tables ): void {
		if ( [] === $tables ) {
			self::refuse_schema( $word, 'declares no table' );
		}
		$retains = false;
		$taken   = \array_fill_keys( \array_keys( Sqlite_Arm::KV_DDL ), 'the kv store' );
		foreach ( $tables as $table => $spec ) {
			self::check_table( $word, $tables, $table, $spec );
			foreach ( Sqlite_Arm::declared_names( $table, $spec ) as $name ) {
				if ( isset( $taken[ $name ] ) ) {
					self::refuse_schema( $word, "{$name} is taken twice, by {$taken[ $name ]} and by table {$table}" );
				}
				$taken[ $name ] = "table {$table}";
			}
			$retains = $retains || isset( $spec['retain'] );
		}
		if ( ! $retains ) {
			self::refuse_schema( $word, 'retains no table, so no purge ever starts' );
		}
		foreach ( \array_keys( $tables ) as $table ) {
			self::check_acyclic( $word, $tables, [ $table ] );
		}
	}

	/**
	 * Refuse a `retained_by` chain that returns to a table on it, which no
	 * release would ever bound.
	 *
	 * @param string                 $word   The schema word.
	 * @param array<string,Row_Spec> $tables Every table it declares.
	 * @param non-empty-list<string> $chain  The tables followed so far.
	 * @throws \RuntimeException Naming the schema and the cycle.
	 */
	private static function check_acyclic( string $word, array $tables, array $chain ): void {
		foreach ( $tables[ \end( $chain ) ]['retained_by'] ?? [] as [ $names ] ) {
			if ( \in_array( $names, $chain, true ) ) {
				self::refuse_schema( $word, "{$chain[0]} is retained_by a cycle: " . \implode( ', ', [ ...$chain, $names ] ) );
			}
			self::check_acyclic( $word, $tables, [ ...$chain, $names ] );
		}
	}

	/**
	 * Check one table's declaration against the rest of its schema.
	 *
	 * @param string                $word   The schema word.
	 * @param array<string,Row_Spec> $tables Every table it declares.
	 * @param string                $table  This table.
	 * @param Row_Spec              $spec   Its declaration.
	 * @throws \RuntimeException Naming the schema and the item it refuses.
	 */
	private static function check_table( string $word, array $tables, string $table, array $spec ): void {
		$columns = $spec['columns'];
		$add     = $spec['add'] ?? [];
		$auto    = $spec['autoincrement'] ?? null;
		self::check_name( $word, 'table', $table );
		if ( [] === $columns ) {
			self::refuse_schema( $word, "table {$table} declares no columns" );
		}
		foreach ( $columns as $column => $type ) {
			self::check_name( $word, "table {$table} column", $column );
			if ( 1 !== \preg_match( self::COLUMN_TYPE, $type ) ) {
				self::refuse_schema( $word, "{$table}.{$column} type {$type} is not INTEGER, REAL, TEXT or BLOB, optionally NOT NULL" );
			}
		}
		$named = [
			'key' => $spec['key'] ?? [],
			'add' => \array_map( 'strval', \array_keys( $add ) ),
			'fts' => $spec['fts'] ?? [],
		];
		foreach ( $spec['indexes'] ?? [] as $index => $indexed ) {
			self::check_name( $word, "table {$table} index", $index );
			$named[ "index {$index}" ] = $indexed;
		}
		if ( null !== $auto ) {
			$named['autoincrement'] = [ $auto ];
		}
		foreach ( $named as $what => $names ) {
			foreach ( $names as $column ) {
				if ( ! isset( $columns[ $column ] ) ) {
					self::refuse_schema( $word, "{$table} {$what} names {$column}, which it declares no column for" );
				}
			}
		}
		foreach ( $add as $column => $fold ) {
			if ( \in_array( $column, $named['key'], true ) ) {
				self::refuse_schema( $word, "{$table} add folds {$column}, which its key holds" );
			}
			if ( 1 !== \preg_match( self::FOLD, $fold ) ) {
				self::refuse_schema( $word, "{$table} add folds {$column} by {$fold}, not sum or max" );
			}
		}
		if ( null !== $auto && ! \str_starts_with( $columns[ $auto ], 'INTEGER' ) ) {
			self::refuse_schema( $word, "{$table} autoincrement {$auto} is not an INTEGER column" );
		}
		foreach ( $named['fts'] as $column ) {
			if ( ! \str_starts_with( $columns[ $column ], 'TEXT' ) || isset( $add[ $column ] ) ) {
				self::refuse_schema( $word, "{$table} fts indexes {$column}, which is not a TEXT column or is a column an add folds" );
			}
		}
		if ( [] !== $named['fts'] && null === $auto ) {
			self::refuse_schema( $word, "{$table} fts needs an autoincrement column to key its shadow" );
		}
		self::check_purge( $word, $tables, $table, $spec );
	}

	/**
	 * Check how a table purges: a `retain` whose column leads an index or the
	 * key, with a window and a unit of at least one, `retained_by` entries
	 * each a `[ table, column, own ]` list naming a declared table whose referencing column leads one there
	 * and this table's autoincrement column or one-column key, so a released
	 * value deletes one row by a seek, or both.
	 *
	 * @param string                $word   The schema word.
	 * @param array<string,Row_Spec> $tables Every table it declares.
	 * @param string                $table  This table.
	 * @param Row_Spec              $spec   Its declaration.
	 * @throws \RuntimeException Naming the schema and the item it refuses.
	 */
	private static function check_purge( string $word, array $tables, string $table, array $spec ): void {
		$retain      = $spec['retain'] ?? null;
		$retained_by = $spec['retained_by'] ?? [];
		if ( null === $retain && [] === $retained_by ) {
			self::refuse_schema( $word, "{$table} declares neither retain nor retained_by, so nothing ever purges it" );
		}
		if ( null !== $retain ) {
			[ $column, $window, $unit ] = $retain;
			if ( ! self::leads( $spec, $column ) ) {
				self::refuse_schema( $word, "{$table} retains by {$column}, which leads no index or key" );
			}
			if ( $window < 1 || $unit < 1 ) {
				self::refuse_schema( $word, "{$table} retains {$column} for a window or a unit below one" );
			}
		}
		foreach ( $retained_by as $at => $reference ) {
			$malformed = self::malformed_reference( $reference );
			if ( null !== $malformed ) {
				self::refuse_schema( $word, "{$table} retained_by entry {$at} ({$malformed}) is no [ table, column, own ] list: retained_by is a list of them" );
			}
			[ $names, $column, $own ] = $reference;
			if ( ! isset( $tables[ $names ] ) ) {
				self::refuse_schema( $word, "{$table} is retained_by {$names}.{$column}, which it declares no table for" );
			}
			if ( ! self::leads( $tables[ $names ], $column ) ) {
				self::refuse_schema( $word, "{$table} is retained_by {$names}.{$column}, which leads no index or key there" );
			}
			if ( ! isset( $spec['columns'][ $own ] ) ) {
				self::refuse_schema( $word, "{$table} is retained_by {$names}.{$column} on {$own}, which it declares no column for" );
			}
			if ( ( $spec['autoincrement'] ?? null ) !== $own && [ $own ] !== ( $spec['key'] ?? [] ) ) {
				self::refuse_schema( $word, "{$table} is retained_by {$names}.{$column} on {$own}, which is neither its autoincrement column nor a one-column key" );
			}
		}
	}

	/**
	 * What a `retained_by` entry is when it is not the list of three strings,
	 * `[ table, column, own ]`, a release follows: a consumer's schema is
	 * read as declared, whatever its PHPDoc promises.
	 *
	 * @param mixed $reference The entry, as the schema declared it.
	 * @return string|null The entry as a refusal shows it: a scalar's value,
	 *                     else its type; null for a reference.
	 */
	private static function malformed_reference( mixed $reference ): ?string {
		if ( \is_array( $reference ) && \array_is_list( $reference ) && 3 === \count( $reference )
			&& [] === \array_filter( $reference, static fn ( mixed $part ): bool => ! \is_string( $part ) ) ) {
			return null;
		}
		return \is_scalar( $reference ) ? (string) $reference : \get_debug_type( $reference );
	}

	/**
	 * Whether a column leads an index, the key, or is the autoincrement
	 * rowid, so a seek on it costs no scan.
	 *
	 * @param Row_Spec $spec   A table's declaration.
	 * @param string   $column The column.
	 */
	private static function leads( array $spec, string $column ): bool {
		$leading = [ $spec['key'][0] ?? null, $spec['autoincrement'] ?? null ];
		foreach ( $spec['indexes'] ?? [] as $indexed ) {
			$leading[] = $indexed[0] ?? null;
		}
		return \in_array( $column, $leading, true );
	}

	/**
	 * Refuse a name outside the identifier alphabet.
	 *
	 * @param string $word The schema word.
	 * @param string $what What the name names.
	 * @param string $name The name.
	 * @throws \RuntimeException When it is out of the alphabet.
	 */
	private static function check_name( string $word, string $what, string $name ): void {
		if ( 1 !== \preg_match( self::IDENTIFIER, $name ) ) {
			self::refuse_schema( $word, "{$what} {$name} is not a lowercase identifier" );
		}
	}

	/**
	 * Refuse a schema, naming it and why.
	 *
	 * @param string $word The schema word.
	 * @param string $why  Why.
	 * @throws \RuntimeException Always.
	 */
	private static function refuse_schema( string $word, string $why ): never {
		throw new \RuntimeException( \esc_html( "schema {$word}: {$why}" ) );
	}

	/**
	 * The Row_Schema class a word names: `<prefix><word>_Row_Schema` in the
	 * first registered namespace holding one.
	 *
	 * @param string $word  The schema word.
	 * @param string $table The Row_Table, for the refusal.
	 * @return class-string<Row_Schema>
	 * @throws \RuntimeException When no registered namespace holds one.
	 */
	private static function schema_class( string $word, string $table ): string {
		$fqcn = 1 === \preg_match( self::SCHEMA_WORD, $word ) ? Command_Interpreter_Node::resolve_named( $word, '_Row_Schema', Row_Schema::class ) : null;
		return $fqcn ?? throw new \RuntimeException( \esc_html( "Row_Table {$table}: unknown schema {$word}: no registered namespace holds a {$word}_Row_Schema implementing Row_Schema" ) );
	}

	/**
	 * Publish the snapshot `$name`, `{base}/tables/{name}.sqlite`, built from
	 * the Row_Table the active topologies declare with `$schema`: a uniquely
	 * named build file beside it, written through `Sqlite_Arm::build_rows()`
	 * with every partition's file attached read-only, is handed to `$build`
	 * as a Row_Reader and renamed over the snapshot when `$build` answers
	 * anything but false. The build file goes in a `finally`, so a build that
	 * throws or answers false leaves the last publish standing. A fleet with
	 * no `tables` directory, or no partition file to attach, builds nothing
	 * and answers false. One publisher per name: two racing builds of it
	 * each publish, the later rename winning.
	 *
	 * @api The row tables' build path, for a job publishing a derived file.
	 * @template T
	 * @param class-string<Row_Schema> $schema The schema the table holds.
	 * @param string                   $name   The snapshot's name.
	 * @param \Closure(Row_Reader): T  $build  The build.
	 * @return T|false What `$build` returned, or false when nothing attached.
	 * @throws \InvalidArgumentException As `snapshot_file()`.
	 * @throws Table_Unavailable As `read()`, or when the build file will not
	 *                           open.
	 * @throws \RuntimeException As `Bootstrap::row_table()`, when the process
	 *                           runs as root, or when the sync or the rename fails.
	 */
	public static function build( string $schema, string $name, \Closure $build ): mixed {
		$file  = self::snapshot_file( $name );
		$table = Bootstrap::row_table( $schema );
		if ( ! \is_dir( \dirname( $file ) ) ) {
			return false;
		}
		$building = self::snapshot_file( $name, \bin2hex( \random_bytes( 8 ) ) );
		try {
			try {
				$builder = Sqlite_Arm::build_rows( $building, $table['files'], $schema::version() );
			} catch ( \PDOException | \LogicException $e ) {
				throw new Table_Unavailable( \esc_html( "Row_Table {$table['name']}: " . Driver_Error::of( $e ) ), 0, $e );
			}
			if ( [] === $builder->aliases() ) {
				return false;
			}
			$built = $build( $builder );
			unset( $builder );
			if ( false !== $built ) {
				self::sync( $building, $name );
			}
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_rename -- the publish is one atomic rename within the Tables' directory.
			if ( false !== $built && ! @\rename( $building, $file ) ) {
				throw new \RuntimeException( \esc_html( "snapshot {$name} would not publish: " . ( \error_get_last()['message'] ?? 'rename failed' ) ) );
			}
			return $built;
		} finally {
			Sqlite_Arm::remove_database( $building );
		}
	}

	/** Sync the build file to disk, throwing when it will not. */
	private static function sync( string $building, string $name ): void {
		$sync = self::$fsync ?? static function ( string $file ): bool {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen -- the build file sits in the Tables' directory.
			$handle = \fopen( $file, 'r+' );
			if ( false === $handle ) {
				return false;
			}
			$synced = \fsync( $handle );
			\fclose( $handle );
			return $synced;
		};
		if ( ! $sync( $building ) ) {
			throw new \RuntimeException( \esc_html( "snapshot {$name} would not sync" ) );
		}
	}

	/**
	 * Open the published snapshot `$name` as `Sqlite_Arm::open_immutable()`
	 * opens a file, `immutable`, aliased `main`; null when none is published.
	 *
	 * @api The read path of a snapshot `build()` publishes.
	 * @param string $name The snapshot's name.
	 * @return Row_Reader|null The query-only connection, or null.
	 * @throws \InvalidArgumentException As `snapshot_file()`.
	 * @throws Table_Unavailable When the file is not a database, or pdo_sqlite
	 *                           is missing.
	 */
	public static function open_snapshot( string $name ): ?Row_Reader {
		$file = self::snapshot_file( $name );
		\clearstatcache( true, $file );
		if ( ! \file_exists( $file ) ) {
			return null;
		}
		try {
			return Sqlite_Arm::open_immutable( $file );
		} catch ( \PDOException | \LogicException $e ) {
			throw new Table_Unavailable( \esc_html( "snapshot {$name}: " . Driver_Error::of( $e ) ), 0, $e );
		}
	}

	/**
	 * Delete the snapshot `$name` and every build of it a crash left behind.
	 *
	 * @api Uninstall's erasure of a snapshot a job publishes.
	 * @param string $name The snapshot's name.
	 * @return list<string> The files deleted.
	 * @throws \InvalidArgumentException As `snapshot_file()`.
	 * @throws \RuntimeException When a file stands that will not delete.
	 */
	public static function remove_snapshot( string $name ): array {
		$files   = [ self::snapshot_file( $name ), ...( \glob( self::snapshot_file( $name, '*' ) ) ?: [] ) ];
		$deleted = [];
		foreach ( $files as $file ) {
			\array_push( $deleted, ...Sqlite_Arm::remove_database( $file ) );
		}
		return $deleted;
	}

	/**
	 * The file of the snapshot `$name`, `{base}/tables/{name}.sqlite`, or of
	 * one build of it, `{name}+{build}.sqlite`: the one spelling `build()`
	 * writes and `remove_snapshot()` globs. No Table name holds `+`, so a
	 * build is never a published file or a Table's file.
	 *
	 * @param string      $name  The snapshot's name.
	 * @param string|null $build A build's id, or `*` to glob them.
	 * @return string The path.
	 * @throws \InvalidArgumentException On a name `Table_Node::stem()` refuses,
	 *                                   or one ending `.p{N}`, which a Table
	 *                                   partition's file would take.
	 */
	private static function snapshot_file( string $name, ?string $build = null ): string {
		self::file_name( 'snapshot', $name );
		if ( Table_Node::is_partition_stem( $name ) ) {
			throw new \InvalidArgumentException( \esc_html( "snapshot name {$name} is a Table partition's file" ) );
		}
		$stem = null === $build ? $name : $name . self::BUILD_JOIN . $build;
		return self::dir( Bootstrap::base_dir() ) . "/{$stem}.sqlite";
	}

	/**
	 * Read the Row_Table the active topologies declare with `$schema` across
	 * every partition they run (`Bootstrap::row_table()`): each file at the schema's version attached read-only into one
	 * connection as `p{N}`, handed to `$read` as a Row_Reader. The connection
	 * closes when the last reference to the Row_Reader is released, not at a
	 * fixed point: a `$read` that keeps the reader, or throws while the trace
	 * still holds it, keeps the files open as long. A partition with no file
	 * is not attached, so a fleet that has written nothing reads with no
	 * aliases.
	 *
	 * @api The row tables' read path, for a verb answering from them.
	 * @template T
	 * @param class-string<Row_Schema> $schema The schema the table holds.
	 * @param \Closure(Row_Reader): T  $read   The read.
	 * @return T What `$read` returned.
	 * @throws Table_Unavailable When no active topology declares a table of
	 *                           the schema, pdo_sqlite is missing, or a file
	 *                           will not attach or is not a database.
	 * @throws \RuntimeException As `Bootstrap::row_table()`, or when the
	 *                           process runs as root.
	 */
	public static function read( string $schema, \Closure $read ): mixed {
		$table = Bootstrap::row_table( $schema );
		try {
			$reader = Sqlite_Arm::open_rows( $table['files'], $schema::version() );
		} catch ( \PDOException | \LogicException $e ) {
			throw new Table_Unavailable( \esc_html( "Row_Table {$table['name']}: " . Driver_Error::of( $e ) ), 0, $e );
		}
		return $read( $reader );
	}

	/**
	 * `ROWS`, the one structured verb a Row_Table declares: a list of row ops
	 * written in one transaction, answered as every Table write is,
	 * TM_RESPONSE `ROWS <written>`, or a TM_ERROR carrying the arm's message,
	 * the whole batch rolled back. Counted as ROWS: the ops asked, the rows
	 * written or folded.
	 *
	 * @param array<int,mixed>       $request The TM_REQUEST.
	 * @param string                 $verb    `ROWS`.
	 * @param array<array-key,mixed> $items   The ops.
	 * @throws \RuntimeException With no wired sink to reply through.
	 * @throws \LogicException Before the schema opened a file.
	 */
	protected function answer_struct( array $request, string $verb, array $items ): void {
		$batch = \array_values( \array_filter( $items, \is_array( ... ) ) );
		if ( ! \array_is_list( $items ) || \count( $batch ) !== \count( $items ) ) {
			$this->refuse( $request, $verb, Core::as_string( self::requests()[ $verb ] ) );
			return;
		}
		$arm = $this->arm();
		if ( ! $arm instanceof Sqlite_Arm ) {
			throw new \LogicException( \esc_html( "Row_Table {$this->name} holds no file until its schema arrives" ) );
		}
		try {
			$written = $arm->write_rows( $batch );
		} catch ( Worker_Should_Stop $stop ) {
			throw $stop;
		} catch ( \RuntimeException $e ) {
			$this->count_rows( $verb, \count( $batch ), 0 );
			$this->count_error( $verb );
			$this->reply( $request, Message::TM_ERROR, '', "{$verb}: {$e->getMessage()}\n" );
			return;
		}
		$this->count_rows( $verb, \count( $batch ), $written );
		$this->reply_written( $request, $verb, [ (string) $written ] );
	}

	/**
	 * The console's metadata row: the schema word beside the per-verb counters.
	 *
	 * @return array<string,mixed>
	 */
	public function dump_metadata(): array {
		return [ 'schema' => $this->schema ] + parent::dump_metadata();
	}

	/**
	 * Palette entry and argument form. The `:config` verbs are the ones a Table answers;
	 * the one request is ROWS. A Row_Table forwards nothing it stores, so it
	 * declares no target.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'Storage',
			'description' => 'Row tables a Row_Schema declares, one SQLite file per partition; ROWS writes a batch, read() queries every partition at once.',
			'arguments'   => [
				[ 'name' => 'schema', 'type' => 'string', 'required' => true, 'description' => 'Word naming <Namespace>\\<Word>_Row_Schema in a registered namespace.' ],
			],
			'commands'    => parent::node_schema()['commands'],
			'requests'    => [
				[
					'name'        => 'ROWS',
					'description' => 'Write one batch of row ops in one transaction under a TM_REQUEST|TM_STRUCT list; a failed op rolls the batch back.',
					'value'       => 'struct',
					'args'        => [ [ 'name' => 'batch', 'type' => 'json', 'required' => true, 'description' => 'a list of [ op, table, row, then?, ids? ]' ] ],
					'reply_shape' => self::ROWS_REPLY,
				],
			],
			'has_target'  => false,
		];
	}
}
