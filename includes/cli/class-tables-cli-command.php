<?php
/**
 * Tables_CLI_Command: `wp nodes tables list` and `wp nodes tables flush`, the
 * operator's view of every Table the registered topologies declare, active or
 * not, partition by partition, of every Ledger's partition files on disk, and
 * of the command-session store.
 *
 * A partition's rows belong to the worker that owns it, its file's one writer
 * (ADR-6), so neither verb opens a live owner's store: `list` asks the owner
 * for its counters and `flush` asks it to flush, each over the worker's
 * command channel. A partition no worker owns is flushed from here only under
 * the fleet hold, when nothing else can be writing it, when its topology is
 * inactive and nothing will spawn its worker, or, for a Ledger's file, when
 * no topology declares its partition.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Registered as the `nodes tables` group, so each public method is a
 * subcommand; a public instance method added here would list as one too.
 *
 * ## EXAMPLES
 *
 *     wp nodes tables list
 *     wp nodes tables flush flame-stats:url --partition=0
 *
 * @phpstan-type Slot array{name:string,partition:int,backend:string,ttl:string,store:string,file:string|null,declares:list<string>,owners:list<string>,owner:string,here:\Closure(string): string}
 * @phpstan-type Ask array{owner:string,name:string,arguments:list<string>}
 */
class Tables_CLI_Command {

	/** Default seconds a verb waits for the owning workers' replies. */
	public const REPLY_TIMEOUT_S = 10;

	/** The node every command here is sent FROM, so its reply lands there. */
	private const RECEIVER = 'tables-cli';

	/** The backend a Ledger file's row names. */
	private const LEDGER = 'ledger';

	/** The owner of a Ledger file no topology's partitions reach. */
	private const NO_OWNER = '-';

	/**
	 * List every Table the registered topologies declare, one row a partition,
	 * then every Ledger, one row each, then the command-session store.
	 *
	 * Each row names the Table's backend and TTL, the worker owning the
	 * partition and its state as `wp nodes status` reads it — `live`,
	 * `stale`, `held`, `idle`, `down` or `inactive` for a topology outside the
	 * active set — and where the rows live: the SQLite
	 * file and its size, its `-wal` and `-shm` counted, or the shared wpdb
	 * table. A live owner is asked for its per-verb counters
	 * over its command channel; a verb it has never run is left out, and an
	 * owner that does not answer in time, or refuses, says so in their place.
	 * A Ledger lists one row a partition file on disk, the backend `ledger`
	 * and its lifespan as its TTL, owned by that partition's worker, which
	 * counts its own calls; a file no topology's partitions reach lists as
	 * `undeclared`, owned by none.
	 *
	 * ## OPTIONS
	 *
	 * [--format=<format>]
	 * : Output format.
	 * ---
	 * default: table
	 * options:
	 *   - table
	 *   - json
	 * ---
	 *
	 * [--timeout=<seconds>]
	 * : How long to wait for the owners' counters. Default 10.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes tables list
	 *     wp nodes tables list --format=json
	 *
	 * @api WP-CLI subcommand `wp nodes tables list` — invoked by WP-CLI via reflection, not called in PHP.
	 * @subcommand list
	 * @when after_wp_load
	 *
	 * @param array<int,string>   $args       Positional arguments (unused).
	 * @param array<string,mixed> $assoc_args Associative arguments; --format and --timeout.
	 */
	public function list_( array $args, array $assoc_args ): void {
		unset( $args );
		$timeout              = CLI::require_flag_int( $assoc_args, 'timeout', self::REPLY_TIMEOUT_S );
		[ $slots, $states ]   = $this->slots();
		$counted              = \array_filter( $slots, static fn ( array $slot ): bool => [] !== self::live( $slot, $states ) );
		$stats                = $this->ask( \array_map( static fn ( array $slot ): array => self::asking( $slot, $slot['owner'], [] ), $counted ), 'stats', $timeout );
		$rows                 = [];
		foreach ( $slots as $key => $slot ) {
			$rows[] = [
				'Table'     => $slot['name'],
				'Partition' => $slot['partition'],
				'Backend'   => $slot['backend'],
				'TTL'       => $slot['ttl'],
				'Owner'     => $slot['owner'],
				'State'     => $states[ $slot['owner'] ],
				'Store'     => $slot['store'],
				'Bytes'     => null === $slot['file'] ? null : \array_sum( Sqlite_Arm::file_sizes( $slot['file'] ) ),
				'Verbs'     => isset( $counted[ $key ] ) ? self::verbs( $slot, $stats[ $key ] ?? null, $timeout ) : null,
			];
		}
		$rows[]  = [
			'Table'     => Command_Auth::SESSIONS_TABLE,
			'Partition' => 0,
			'Backend'   => Command_Auth::SESSIONS_BACKEND,
			'TTL'       => Command_Auth::SESSION_TTL_MIN_S . '-' . Command_Auth::SESSION_TTL_MAX_S,
			'Owner'     => '-',
			'State'     => '-',
			'Store'     => Wpdb_Arm::table(),
			'Bytes'     => null,
			'Verbs'     => null,
		];
		CLI::print_rows( $assoc_args, $rows, \array_keys( $rows[0] ), self::readable( ... ) );
	}

	/**
	 * A row as the table format prints it: the size in bytes readable, a
	 * missing size or partition a dash, and the counters on one line, or why
	 * there are none.
	 *
	 * @param array<string,mixed> $row A listed row.
	 * @return array<string,mixed>
	 */
	private static function readable( array $row ): array {
		$verbs = [];
		foreach ( \is_array( $row['Verbs'] ) ? $row['Verbs'] : [] as $verb => $counts ) {
			$counts  = Core::arr( $counts );
			$verbs[] = "{$verb} " . Core::as_int( $counts['calls'] ) . ' ' . Core::as_float( $counts['total_ms'] ) . 'ms';
		}
		return [
			'Partition' => $row['Partition'] ?? '-',
			'Bytes'     => null === $row['Bytes'] ? '-' : CLI::format_bytes( Core::as_int( $row['Bytes'] ) ),
			'Verbs'     => \is_string( $row['Verbs'] ) ? $row['Verbs'] : ( [] === $verbs ? '-' : \implode( ', ', $verbs ) ),
		] + $row;
	}

	/**
	 * The calls and total milliseconds of each verb a live owner's `stats`
	 * reply shows having run, by verb; for no reply or a refusal, the line
	 * saying so, which the row shows where the counters go, never as none.
	 *
	 * @param Slot                  $slot    The slot.
	 * @param array<int,mixed>|null $reply   The reply, or null for none.
	 * @param int                   $timeout Seconds waited.
	 * @return array<string,array{calls:int,total_ms:float}>|string
	 */
	private static function verbs( array $slot, ?array $reply, int $timeout ): array|string {
		if ( null === $reply ) {
			return "no answer from {$slot['owner']} within {$timeout}s";
		}
		if ( 0 !== ( Core::int( $reply[ Message::TYPE ] ) & Message::TM_ERROR ) ) {
			return "{$slot['owner']} refused stats: " . \trim( Core::as_string( Core::arr( $reply[ Message::VALUE ] )['payload'] ?? null ) );
		}
		$verbs = [];
		foreach ( Core::arr( Core::arr( $reply[ Message::VALUE ] )['payload'] ?? null ) as $verb => $row ) {
			$row = Core::arr( $row );
			if ( Core::as_int( $row['calls'] ?? 0 ) > 0 ) {
				$verbs[ (string) $verb ] = [
					'calls'    => Core::as_int( $row['calls'] ),
					'total_ms' => Core::as_float( $row['total_ms'] ?? 0 ),
				];
			}
		}
		return $verbs;
	}

	/**
	 * Empty the named Tables, every row and set member. A `sqlite` partition
	 * is replaced by a new file, at a cost that never grows with its rows, and
	 * reports the bytes the old files held; a `wpdb` Table deletes its
	 * namespace's rows and reports how many.
	 *
	 * A partition whose owning worker is live is flushed by that worker, sent
	 * the Table's `flush` verb over its command channel. One no worker owns is
	 * flushed from here, and only under the fleet hold (`wp nodes stop`),
	 * because otherwise a worker may start and write it at the same time; a
	 * partition of an inactive topology needs no hold, since nothing spawns its
	 * worker. The
	 * command-session store is flushed only when named, and flushing it
	 * revokes every issued session.
	 *
	 * A Ledger flushes each partition file on disk: it drops the rows table
	 * and declares it anew from its current declaration, in one transaction,
	 * and reports the rows it held; the file stays, since other partitions
	 * attach it. A file whose worker is live is sent `flush` with the columns
	 * its topology declares now, and a worker running others refuses, naming
	 * the restart. One no worker writes is flushed from here on the Tables'
	 * terms, or with no hold at all when no topology declares its partition.
	 * A Ledger whose declaration changed its columns, whose workers refuse to
	 * open its files, opens once every file is flushed.
	 *
	 * ## OPTIONS
	 *
	 * [<table>...]
	 * : Tables to flush, as their topologies declare them, or
	 * `nodes-sessions`. None flushes every declared Table and asks first.
	 *
	 * [--partition=<partition>]
	 * : Flush one partition (0-based) of each Table and Ledger; every
	 * partition by default.
	 *
	 * [--yes]
	 * : Skip the question flushing every declared Table asks.
	 *
	 * [--timeout=<seconds>]
	 * : How long to wait for the owners' replies. Default 10.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes tables flush flame-stats:url
	 *     wp nodes stop && wp nodes tables flush --yes && wp nodes start
	 *     wp nodes tables flush nodes-sessions
	 *
	 * @api WP-CLI subcommand `wp nodes tables flush` — invoked by WP-CLI via reflection, not called in PHP.
	 * @when after_wp_load
	 *
	 * @param array<int,string>   $args       Positional arguments; the Tables.
	 * @param array<string,mixed> $assoc_args Associative arguments; --partition, --yes and --timeout.
	 */
	public function flush( array $args, array $assoc_args ): void {
		CLI::refuse_root( 'tables flush' );
		$partition          = CLI::require_flag_int( $assoc_args, 'partition', -1 );
		$timeout            = CLI::require_flag_int( $assoc_args, 'timeout', self::REPLY_TIMEOUT_S );
		[ $slots, $states ] = $this->slots();
		$known              = [ ...\array_values( \array_unique( \array_column( $slots, 'name' ) ) ), Command_Auth::SESSIONS_TABLE ];
		foreach ( $args as $name ) {
			if ( ! \in_array( $name, $known, true ) ) {
				\WP_CLI::error( "unknown Table or Ledger {$name}; declared: " . \implode( ', ', $known ) );
			}
		}
		$chosen = \array_filter(
			$slots,
			static fn ( array $slot ): bool => ( [] === $args || \in_array( $slot['name'], $args, true ) ) && ( -1 === $partition || $partition === $slot['partition'] )
		);
		if ( [] === $args ) {
			\WP_CLI::confirm( 'Flush every row of ' . self::counted( $chosen, 'declared ' ) . '? The session store is left alone.', $assoc_args );
		}
		$asks = [];
		foreach ( $chosen as $key => $slot ) {
			foreach ( self::live( $slot, $states ) as $owner ) {
				$asks[ "{$key}@{$owner}" ] = self::asking( $slot, $owner, $slot['declares'] );
			}
		}
		$replies = $this->ask( $asks, 'flush', $timeout );
		$steps   = [];
		foreach ( $chosen as $key => $slot ) {
			$live          = self::live( $slot, $states );
			$state         = $states[ $slot['owner'] ];
			$steps[ $key ] = [] === $live
				? static fn (): string => ( $slot['here'] )( $state )
				: static fn (): string => self::released_by_owners( $key, $live, $replies, $timeout );
		}
		if ( \in_array( Command_Auth::SESSIONS_TABLE, $args, true ) ) {
			$steps[ Command_Auth::SESSIONS_TABLE ] = static fn (): string => self::released( Command_Auth::session_table()->flush() ) . '; every issued session is revoked';
		}
		$flushed  = [];
		$failures = [];
		foreach ( $steps as $name => $step ) {
			try {
				\WP_CLI::log( "{$name}: " . $step() );
				$flushed[] = $chosen[ $name ] ?? [ 'backend' => Command_Auth::SESSIONS_BACKEND ];
			} catch ( Worker_Should_Stop $stop ) {
				throw $stop;
			} catch ( \RuntimeException $e ) {
				$failures[] = "{$name}: " . $e->getMessage();
			}
		}
		if ( [] !== $failures ) {
			\WP_CLI::error( \implode( "\n", $failures ) );
		}
		\WP_CLI::success( 'Flushed ' . self::counted( $flushed ) . '.' );
	}

	/**
	 * What the live workers a slot's `flush` went to released, summed, as the
	 * line says it, naming them: the partition's one owner, or each live
	 * worker of a topology declaring it, each Ledger file flushing only while
	 * its writer runs the columns sent. A worker that did not answer, or
	 * refused, fails the line, naming itself and its reason; one running
	 * other columns names the restart that brings the declared ones in.
	 *
	 * @param string                         $key     The slot's key.
	 * @param list<string>                   $owners  The live workers asked.
	 * @param array<string,array<int,mixed>> $replies `{key}@{owner}` => the reply.
	 * @param int                            $timeout Seconds waited.
	 * @return string `<released> by <worker>, …`.
	 * @throws \RuntimeException On any worker's silence or refusal, naming each.
	 */
	private static function released_by_owners( string $key, array $owners, array $replies, int $timeout ): string {
		$released = [];
		$refusals = [];
		foreach ( $owners as $owner ) {
			$reply = $replies[ "{$key}@{$owner}" ] ?? null;
			if ( null === $reply ) {
				$refusals[] = "{$owner} did not answer flush within {$timeout}s";
				continue;
			}
			$value   = $reply[ Message::VALUE ];
			$payload = \is_array( $value ) ? $value['payload'] ?? null : $value;
			if ( 0 !== ( Core::int( $reply[ Message::TYPE ] ) & Message::TM_ERROR ) ) {
				$refusals[] = "{$owner} refused flush: " . \trim( Core::as_string( $payload ) );
				continue;
			}
			foreach ( Core::arr( $payload ) as $unit => $count ) {
				$released[ $unit ] = ( $released[ $unit ] ?? 0 ) + Core::as_int( $count );
			}
		}
		if ( [] !== $refusals ) {
			throw new \RuntimeException( \esc_html( \implode( '; ', $refusals ) ) );
		}
		return self::released( $released ) . ' by ' . \implode( ', ', $owners );
	}

	/**
	 * Send each ask's store its `:config` verb over the asked worker's
	 * command channel, signed as the attached REPL signs, and wait up to
	 * `$timeout` seconds for the replies. Every command goes FROM
	 * `_output/_cli:{pid}/tables-cli/{key}`, so the channel's gate keeps only
	 * this process's replies and each reaches the one receiver with its key
	 * as the TO left behind.
	 *
	 * @param array<string,Ask> $slots   Key => the ask.
	 * @param string            $verb    The `:config` verb.
	 * @param int               $timeout Seconds to wait.
	 * @return array<string,array<int,mixed>> Key => the reply; an ask whose
	 *                                        worker did not answer is absent.
	 * @throws \Throwable What tearing the channels down threw.
	 */
	private function ask( array $slots, string $verb, int $timeout ): array {
		if ( [] === $slots ) {
			return [];
		}
		$pid         = (string) \getmypid();
		/** @var array<string,array<int,mixed>> $replies */
		$replies     = [];
		$router      = new Router_Node();
		$interpreter = new Command_Interpreter_Node();
		$receiver    = new Callback_Node(
			static function ( array $reply ) use ( &$replies ): void {
				/** @var array<int,mixed> $reply */
				$replies[ Core::as_string( $reply[ Message::TO ] ) ] = $reply;
			}
		);
		$built       = [ $router, $interpreter, $receiver ];
		try {
			$router->name( Node_Names::ROUTER );
			$interpreter->name( Node_Names::COMMAND_INTERPRETER );
			$interpreter->sink( $router );
			$receiver->name( self::RECEIVER );
			$cli    = new CLI( Bootstrap::base_dir() );
			$opened = [];
			foreach ( $slots as $stem => $slot ) {
				if ( ! isset( $opened[ $slot['owner'] ] ) ) {
					$opened[ $slot['owner'] ] = true;
					\array_push( $built, ...CLI::open_channel( $cli->attach_to_worker( $slot['owner'] ), $interpreter, $router, $pid ) );
				}
				$command                   = Message::new_message();
				$command[ Message::TYPE ]  = Message::TM_COMMAND;
				$command[ Message::FROM ]  = CLI::reply_head( $pid ) . '/' . self::RECEIVER . "/{$stem}";
				$command[ Message::TO ]    = "{$slot['owner']}/{$slot['name']}:config";
				$command[ Message::VALUE ] = [
					'name'      => $verb,
					'arguments' => $slot['arguments'],
				];
				Command_Auth::sign( $command );
				$interpreter->fill( $command );
			}
			$deadline = Core::right_now() + $timeout;
			// By reference: an arrow fn holds the empty map it was born with.
			Event_Framework::instance()->drain(
				static function () use ( &$replies, $slots, $deadline ): bool {
					return \count( $replies ) < \count( $slots ) && Core::$now < $deadline;
				}
			);
		} finally {
			Worker_Should_Stop::raise( Worker_Should_Stop::attempt_each( \array_reverse( $built ), static fn ( Node $node ) => $node->remove_node() ) );
		}
		return $replies;
	}

	/**
	 * One worker's ask of a slot: its store's `:config` verb, carrying
	 * `$arguments`: none for `stats`, and for `flush` the columns a Ledger's
	 * topology declares, which a Ledger's `flush` checks.
	 *
	 * @param Slot         $slot      The slot.
	 * @param string       $worker    The worker asked.
	 * @param list<string> $arguments The verb's arguments.
	 * @return Ask
	 */
	private static function asking( array $slot, string $worker, array $arguments ): array {
		return [
			'owner'     => $worker,
			'name'      => $slot['name'],
			'arguments' => $arguments,
		];
	}

	/**
	 * A slot's declaring workers that are live, in order.
	 *
	 * @param Slot                 $slot   The slot.
	 * @param array<string,string> $states Worker id => state.
	 * @return list<string>
	 */
	private static function live( array $slot, array $states ): array {
		return \array_values( \array_filter( $slot['owners'], static fn ( string $worker ): bool => 'live' === $states[ $worker ] ) );
	}

	/**
	 * How many Table partitions and Ledger files `$slots` hold, as a line
	 * says it: `3 Table partitions`, `1 Ledger file`, or both joined by `and`.
	 *
	 * @param array<array-key,array{backend:string}> $slots     The slots; the session store counts as a Table partition.
	 * @param string                                $adjective Before the Tables' noun, with its trailing space.
	 * @return string The count.
	 */
	private static function counted( array $slots, string $adjective = '' ): string {
		$ledgers = \count( \array_filter( $slots, static fn ( array $slot ): bool => self::LEDGER === $slot['backend'] ) );
		$tables  = \count( $slots ) - $ledgers;
		$parts   = $tables > 0 || 0 === $ledgers ? [ "{$tables} {$adjective}Table partition" . ( 1 === $tables ? '' : 's' ) ] : [];
		if ( $ledgers > 0 ) {
			$parts[] = "{$ledgers} Ledger file" . ( 1 === $ledgers ? '' : 's' );
		}
		return \implode( ' and ', $parts );
	}

	/**
	 * Every Table partition and every Ledger the registered topologies
	 * declare, with each declaring worker's state as `wp nodes status` reads
	 * it: one `CLI::worker_states()` pass. A Table partition is keyed by its
	 * stem, `{table}.p{N}`, and owned by the first active topology declaring
	 * the Table with that partition, as `node_tables()` unions the declarers,
	 * else the first inactive one, whose worker nothing spawns. A Ledger file
	 * is keyed `{ledger}.p{N}` too and owned by the first live worker of a
	 * topology declaring partition N, else the first, else by NO_OWNER, whose
	 * state is `undeclared`. An inactive topology that will not read is
	 * warned about and left out.
	 *
	 * @return array{0: array<string,Slot>, 1: array<string,string>} The slots, and worker id => state.
	 * @throws \Throwable As `Bootstrap::node_tables()` and `node_ledgers()`.
	 */
	private function slots(): array {
		[ $readable ] = Bootstrap::active_topologies();
		$parked       = self::parked();
		$slots        = [];

		$declared = Topology_Analyzer::declared_tables( ... );
		$owners   = self::owners( $readable + $parked, $declared );
		$active   = \array_map( 'strval', \array_keys( self::owners( $readable, $declared ) ) );
		$tables   = [] === $active ? [] : Bootstrap::node_tables( ...$active );
		foreach ( Bootstrap::tables_of( $parked, ...\array_map( 'strval', \array_keys( $owners ) ) ) as $name => $partitions ) {
			foreach ( $partitions as $p => $spec ) {
				$tables[ $name ][ $p ] ??= $spec;
			}
		}
		foreach ( $tables as $name => $partitions ) {
			foreach ( $partitions as $p => $spec ) {
				$slots[ Table_Node::stem( $name, $p ) ] = self::table_slot( $name, $p, $spec, $owners[ $name ][ $p ][0] );
			}
		}

		$declared = Topology_Analyzer::declared_ledgers( ... );
		$owners   = self::owners( $readable + $parked, $declared );
		$active   = \array_map( 'strval', \array_keys( self::owners( $readable, $declared ) ) );
		$ledgers  = [] === $active ? [] : Bootstrap::node_ledgers( ...$active );
		foreach ( Bootstrap::ledgers_of( $parked, ...\array_map( 'strval', \array_keys( $owners ) ) ) as $name => $declaration ) {
			$ledgers[ $name ] ??= $declaration;
		}
		foreach ( \array_filter( $ledgers ) as $name => $declaration ) {
			foreach ( Ledger_Node::partition_files( $name ) as $p => $file ) {
				$slots[ "{$name}.p{$p}" ] = self::ledger_slot( $name, $p, $file, $declaration, $owners[ $name ][ $p ] ?? [] );
			}
		}

		$every  = \array_values( \array_unique( \array_merge( ...\array_column( $slots, 'owners' ) ) ) );
		$states = \array_map( static fn ( array $worker ): string => $worker['state'], ( new CLI( Bootstrap::base_dir() ) )->worker_states( $every, Bootstrap::get_topologies(), false ) );
		$states[ self::NO_OWNER ] = 'undeclared';
		foreach ( $slots as $key => $slot ) {
			$live                   = \array_values( \array_filter( $slot['owners'], static fn ( string $worker ): bool => 'live' === $states[ $worker ] ) );
			$slots[ $key ]['owner'] = $live[0] ?? $slot['owner'];
		}
		return [ $slots, $states ];
	}

	/**
	 * One Ledger partition's file as a slot: its lifespan as its TTL, and the
	 * workers of every topology declaring that partition. With none of them
	 * live it is flushed from here, from its declaration alone, on the terms
	 * flush_here() sets.
	 *
	 * @param string                                                             $name        The Ledger.
	 * @param int                                                                $partition   The file's partition.
	 * @param string                                                             $file        The file.
	 * @param array{segment_seconds: int, num_segments: int, columns: list<string>} $declaration Its declaration.
	 * @param list<string>                                                       $owners      The workers declaring the partition; none for a file no topology's partitions reach.
	 * @return Slot
	 */
	private static function ledger_slot( string $name, int $partition, string $file, array $declaration, array $owners ): array {
		$owner = $owners[0] ?? self::NO_OWNER;
		return [
			'name'      => $name,
			'partition' => $partition,
			'backend'   => self::LEDGER,
			'ttl'       => (string) ( $declaration['segment_seconds'] * $declaration['num_segments'] ),
			'store'     => $file,
			'file'      => $file,
			'declares'  => $declaration['columns'],
			'owners'    => $owners,
			'owner'     => $owner,
			'here'      => static fn ( string $state ): string => self::flush_here( static fn (): array => Ledger_Node::flush_file( $name, $partition, $declaration ), $owner, $state ),
		];
	}

	/**
	 * One Table partition as a slot: a `sqlite` Table's rows in its own file,
	 * a `wpdb` Table's in the shared table. With no live owner it is flushed
	 * from here, and only under the fleet hold or while its topology is
	 * inactive.
	 *
	 * @param string                                             $name      The Table.
	 * @param int                                                $partition Its partition.
	 * @param array{namespace: string, ttl: int, backend: string} $spec      Its declaration.
	 * @param string                                             $owner     The worker owning it.
	 * @return Slot
	 */
	private static function table_slot( string $name, int $partition, array $spec, string $owner ): array {
		$file = 'sqlite' === $spec['backend'] ? Table_Node::file( $name, $partition ) : null;
		return [
			'name'      => $name,
			'partition' => $partition,
			'backend'   => $spec['backend'],
			'ttl'       => (string) $spec['ttl'],
			'store'     => $file ?? Wpdb_Arm::table(),
			'file'      => $file,
			'declares'  => [],
			'owners'    => [ $owner ],
			'owner'     => $owner,
			'here'      => static fn ( string $state ): string => self::flush_here( static fn (): array => Table_Node::writer( $name, $partition, $spec )->flush(), $owner, $state ),
		];
	}

	/**
	 * Flush a partition no live worker owns, from this process, when nothing
	 * else can be writing it: the fleet is held, its topology is inactive, or
	 * no topology declares it; the line says which.
	 *
	 * @param \Closure(): array<array-key,mixed> $flush The flush, answering what it released.
	 * @param string                            $owner The worker owning the partition, or NO_OWNER.
	 * @param string                            $state Its owner's state.
	 * @return string What the flush released, and why it ran here.
	 * @throws \RuntimeException When the fleet is not held, or the owner is stale, or the flush fails.
	 */
	private static function flush_here( \Closure $flush, string $owner, string $state ): string {
		$why = match ( $state ) {
			'held'       => ' under the hold',
			'inactive'   => '; ' . ( CLI::parse_worker_id( $owner )[0] ?? $owner ) . ' is inactive',
			'undeclared' => '; no topology declares it',
			default      => throw new \RuntimeException(
				\esc_html(
					'stale' === $state
						? "{$owner} is stale: its lock stands with no heartbeat; restart it, or wait for its lock to clear, and flush again"
						: "{$owner} is {$state}; run `wp nodes stop` to hold the fleet, flush again, then `wp nodes start`"
				)
			),
		};
		return self::released( $flush() ) . $why;
	}

	/**
	 * What a flush released, as its line says it: a `sqlite` Table's bytes,
	 * its old files replaced, or a `wpdb` Table's or a Ledger's rows deleted.
	 *
	 * @param array<array-key,mixed> $released `{ bytes }` or `{ rows }`.
	 * @return string `<size> released` or `<n> rows deleted`.
	 */
	private static function released( array $released ): string {
		return isset( $released['bytes'] )
			? CLI::format_bytes( Core::as_int( $released['bytes'] ) ) . ' released'
			: Core::as_int( $released['rows'] ?? null ) . ' rows deleted';
	}

	/**
	 * Each store's declaring workers across the given topologies, partition
	 * by partition, in the order the topologies come.
	 *
	 * @param array<string,array<array-key,mixed>>      $topologies Name => entry.
	 * @param \Closure(string): array<array-key,mixed> $declared   Topology => its stores, by name.
	 * @return array<array-key,array<int,non-empty-list<string>>> Store name => partition => worker ids.
	 * @throws \RuntimeException As `$declared`.
	 */
	private static function owners( array $topologies, \Closure $declared ): array {
		$owners = [];
		foreach ( $topologies as $topology => $entry ) {
			foreach ( \array_keys( $declared( $topology ) ) as $name ) {
				for ( $p = 0, $n = Bootstrap::partitions_of( $entry ); $p < $n; ++$p ) {
					$owners[ $name ][ $p ][] = CLI::worker_id( $topology, $p );
				}
			}
		}
		return $owners;
	}

	/**
	 * Every registered topology outside the active set whose stores read; one
	 * that will not read is warned about and left out.
	 *
	 * @return array<string,array<array-key,mixed>> Topology name => entry.
	 */
	private static function parked(): array {
		$parked     = [];
		$configured = Bootstrap::get_topologies();
		foreach ( Bootstrap::get_topology_catalog() as $topology => $entry ) {
			if ( isset( $configured[ $topology ] ) ) {
				continue;
			}
			try {
				Topology_Analyzer::declared_tables( (string) $topology );
				Topology_Analyzer::declared_ledgers( (string) $topology );
			} catch ( Worker_Should_Stop $stop ) {
				throw $stop;
			} catch ( \RuntimeException $e ) {
				\WP_CLI::warning( "{$topology}: " . \html_entity_decode( $e->getMessage(), \ENT_QUOTES ) );
				continue;
			}
			$parked[ (string) $topology ] = Core::arr( $entry );
		}
		return $parked;
	}
}
