<?php
/**
 * Tables_CLI_Command: `wp nodes tables list` and `wp nodes tables flush`, the
 * operator's view of every Table the registered topologies declare, active or
 * not, partition by partition, of every Ledger once, and of the
 * command-session store.
 *
 * A partition's rows belong to the worker that owns it, its file's one writer
 * (ADR-6), so neither verb opens a live owner's store: `list` asks the owner
 * for its counters and `flush` asks it to flush, each over the worker's
 * command channel. A partition no worker owns is flushed from here only under
 * the fleet hold, when nothing else can be writing it, or when its topology is
 * inactive and nothing will spawn its worker. A Ledger is one file every
 * declaring worker writes, serialized by SQLite's lock: `flush` asks every live
 * one, and with none live flushes it from here.
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
 * @phpstan-type Slot array{name:string,partition:int|null,backend:string,ttl:string,store:string,file:string|null,declares:list<string>,owners:list<string>,owner:string,here:\Closure(string): string}
 * @phpstan-type Ask array{owner:string,name:string,arguments:list<string>}
 */
class Tables_CLI_Command {

	/** Default seconds a verb waits for the owning workers' replies. */
	public const REPLY_TIMEOUT_S = 10;

	/** The node every command here is sent FROM, so its reply lands there. */
	private const RECEIVER = 'tables-cli';

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
	 * owner that does not answer in time is warned about and listed without.
	 * A Ledger lists with no partition, the backend `ledger`, its lifespan as
	 * its TTL, its first live declaring worker as its owner, else its first,
	 * and no counters, since each worker counts only its own calls.
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
		$counted              = \array_filter( $slots, static fn ( array $slot ): bool => null !== $slot['partition'] && [] !== self::live( $slot, $states ) );
		$stats                = $this->ask( \array_map( static fn ( array $slot ): array => self::asking( $slot, $slot['owner'] ), $counted ), 'stats', $timeout );
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
	 * missing size or partition a dash, and the counters on one line.
	 *
	 * @param array<string,mixed> $row A listed row.
	 * @return array<string,mixed>
	 */
	private static function readable( array $row ): array {
		$verbs = [];
		foreach ( Core::arr( $row['Verbs'] ) as $verb => $counts ) {
			$counts  = Core::arr( $counts );
			$verbs[] = "{$verb} " . Core::as_int( $counts['calls'] ) . ' ' . Core::as_float( $counts['total_ms'] ) . 'ms';
		}
		return [
			'Partition' => $row['Partition'] ?? '-',
			'Bytes'     => null === $row['Bytes'] ? '-' : CLI::format_bytes( Core::as_int( $row['Bytes'] ) ),
			'Verbs'     => [] === $verbs ? '-' : \implode( ', ', $verbs ),
		] + $row;
	}

	/**
	 * The calls and total milliseconds of each verb a live owner's `stats`
	 * reply shows having run, by verb; null, with a warning naming why, for no
	 * reply or a refusal.
	 *
	 * @param Slot                  $slot    The slot.
	 * @param array<int,mixed>|null $reply   The reply, or null for none.
	 * @param int                   $timeout Seconds waited.
	 * @return array<string,array{calls:int,total_ms:float}>|null
	 */
	private static function verbs( array $slot, ?array $reply, int $timeout ): ?array {
		if ( null === $reply ) {
			\WP_CLI::warning( "{$slot['owner']} did not answer stats for {$slot['name']} within {$timeout}s" );
			return null;
		}
		if ( 0 !== ( Core::int( $reply[ Message::TYPE ] ) & Message::TM_ERROR ) ) {
			\WP_CLI::warning( "{$slot['owner']} refused stats for {$slot['name']}: " . \trim( Core::as_string( Core::arr( $reply[ Message::VALUE ] )['payload'] ?? null ) ) );
			return null;
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
	 * A Ledger drops its rows table and declares it anew from its current
	 * declaration, in one transaction, and reports the rows it held; the file
	 * stays, since every partition holds it open. Every live worker declaring
	 * it is sent `flush` with the columns its topology declares now; one
	 * running those columns flushes, and one running others refuses, naming
	 * the restart, and flushes nothing itself, though another on the current
	 * columns may already have flushed. With none live this process flushes
	 * it, needing no hold, since SQLite's lock serializes it with any writer
	 * that starts. A Ledger whose declaration changed its columns, whose
	 * workers refuse to open its file, opens after the flush.
	 *
	 * ## OPTIONS
	 *
	 * [<table>...]
	 * : Tables to flush, as their topologies declare them, or
	 * `nodes-sessions`. None flushes every declared Table and asks first.
	 *
	 * [--partition=<partition>]
	 * : Flush one Table partition (0-based); every partition by default. A
	 * Ledger has none, and is left out when this is given.
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
			if ( -1 !== $partition && isset( $slots[ $name ] ) && null === $slots[ $name ]['partition'] ) {
				\WP_CLI::error( "{$name} is a Ledger, one file every partition writes; flush it without --partition" );
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
				$asks[ "{$key}@{$owner}" ] = self::asking( $slot, $owner );
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
				$flushed[] = $chosen[ $name ] ?? [ 'partition' => 0 ];
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
	 * line says it, naming them: a Table's one owner, or every live worker
	 * declaring a Ledger, each of which flushes only while it runs the
	 * columns sent. A worker that did not answer, or refused, fails the line,
	 * naming itself and its reason; one running other columns names the
	 * restart that brings the declared ones in.
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
	 * One worker's ask of a slot: its store's `:config` verb, carrying the
	 * columns a Ledger's topology declares, which a Ledger's `flush` checks.
	 *
	 * @param Slot   $slot   The slot.
	 * @param string $worker The worker asked.
	 * @return Ask
	 */
	private static function asking( array $slot, string $worker ): array {
		return [
			'owner'     => $worker,
			'name'      => $slot['name'],
			'arguments' => $slot['declares'],
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
	 * How many Table partitions and Ledgers `$slots` hold, as a line says it:
	 * `3 Table partitions`, `1 Ledger`, or both joined by `and`.
	 *
	 * @param array<array-key,array{partition:int|null}> $slots     The slots; the session store counts as a partition.
	 * @param string                                    $adjective Before each noun, with its trailing space.
	 * @return string The count.
	 */
	private static function counted( array $slots, string $adjective = '' ): string {
		$ledgers = \count( \array_filter( $slots, static fn ( array $slot ): bool => null === $slot['partition'] ) );
		$tables  = \count( $slots ) - $ledgers;
		$parts   = $tables > 0 || 0 === $ledgers ? [ "{$tables} {$adjective}Table partition" . ( 1 === $tables ? '' : 's' ) ] : [];
		if ( $ledgers > 0 ) {
			$parts[] = "{$ledgers} {$adjective}Ledger" . ( 1 === $ledgers ? '' : 's' );
		}
		return \implode( ' and ', $parts );
	}

	/**
	 * Every Table partition and every Ledger the registered topologies
	 * declare, with each declaring worker's state as `wp nodes status` reads
	 * it: one `CLI::worker_states()` pass. A Table partition is keyed by its
	 * stem, `{table}.p{N}`, and owned by the first active topology declaring
	 * the Table with that partition, as `node_tables()` unions the declarers,
	 * else the first inactive one, whose worker nothing spawns. A Ledger is
	 * keyed by its name and owned by the first of its declaring workers that
	 * is live, else the first. An inactive topology that will not read is
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
			$slots[ $name ] = self::ledger_slot( $name, $declaration, \array_merge( ...$owners[ $name ] ) );
		}

		$every  = \array_values( \array_unique( \array_merge( ...\array_column( $slots, 'owners' ) ) ) );
		$states = \array_map( static fn ( array $worker ): string => $worker['state'], ( new CLI( Bootstrap::base_dir() ) )->worker_states( $every, Bootstrap::get_topologies(), false ) );
		foreach ( $slots as $key => $slot ) {
			$live                   = \array_values( \array_filter( $slot['owners'], static fn ( string $worker ): bool => 'live' === $states[ $worker ] ) );
			$slots[ $key ]['owner'] = $live[0] ?? $slot['owner'];
		}
		return [ $slots, $states ];
	}

	/**
	 * A Ledger as one slot with no partition: its one file, its lifespan as
	 * its TTL, and every worker declaring it. With none of them live it is
	 * flushed from here, from its declaration alone.
	 *
	 * @param string                                                             $name        The Ledger.
	 * @param array{segment_seconds: int, num_segments: int, columns: list<string>} $declaration Its declaration.
	 * @param list<string>                                                       $owners      Every worker declaring it.
	 * @return Slot
	 */
	private static function ledger_slot( string $name, array $declaration, array $owners ): array {
		$file = Ledger_Node::file( $name );
		return [
			'name'      => $name,
			'partition' => null,
			'backend'   => 'ledger',
			'ttl'       => (string) ( $declaration['segment_seconds'] * $declaration['num_segments'] ),
			'store'     => $file,
			'file'      => $file,
			'declares'  => $declaration['columns'],
			'owners'    => $owners,
			'owner'     => $owners[0],
			'here'      => static fn (): string => self::released( Ledger_Node::flush_file( $name, $declaration ) ) . '; no worker declaring it is live',
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
			'here'      => static fn ( string $state ): string => self::released( self::flush_here( $name, $partition, $spec, $owner, $state ) ) . ( 'inactive' === $state ? '; ' . ( CLI::parse_worker_id( $owner )[0] ?? $owner ) . ' is inactive' : ' under the hold' ),
		];
	}

	/**
	 * Flush a Table partition no live worker owns, from this process, when the
	 * fleet is held or its topology is inactive, and so nothing else can be
	 * writing it.
	 *
	 * @param string                                             $name      The Table.
	 * @param int                                                $partition Its partition.
	 * @param array{namespace: string, ttl: int, backend: string} $spec      Its declaration.
	 * @param string                                             $owner     The worker owning it.
	 * @param string                                             $state     Its owner's state.
	 * @return array<array-key,mixed> What the flush released.
	 * @throws \RuntimeException When the fleet is not held, or the owner is stale, or the flush fails.
	 */
	private static function flush_here( string $name, int $partition, array $spec, string $owner, string $state ): array {
		if ( ! \in_array( $state, [ 'held', 'inactive' ], true ) ) {
			throw new \RuntimeException(
				\esc_html(
					'stale' === $state
						? "{$owner} is stale: its lock stands with no heartbeat; restart it, or wait for its lock to clear, and flush again"
						: "{$owner} is {$state}; run `wp nodes stop` to hold the fleet, flush again, then `wp nodes start`"
				)
			);
		}
		return Table_Node::writer( $name, $partition, $spec )->flush();
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
