<?php
/**
 * Tables_CLI_Command: `wp nodes tables list` and `wp nodes tables flush`, the
 * operator's view of every Table the registered topologies declare, active or
 * not, partition by partition, and of the command-session store.
 *
 * A partition's rows belong to the worker that owns it, its file's one writer
 * (ADR-6), so neither verb opens a live owner's store: `list` asks the owner
 * for its counters and `flush` asks it to flush, each over the worker's
 * command channel. A partition no worker owns is flushed from here only under
 * the fleet hold, when nothing else can be writing it, or when its topology is
 * inactive and nothing will spawn its worker.
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
 * @phpstan-type Slot array{name:string,partition:int,spec:array{namespace:string,ttl:int,backend:string},owner:?string,state:string}
 */
class Tables_CLI_Command {

	/** Default seconds a verb waits for the owning workers' replies. */
	public const REPLY_TIMEOUT_S = 10;

	/** The node every command here is sent FROM, so its reply lands there. */
	private const RECEIVER = 'tables-cli';

	/**
	 * List every Table the registered topologies declare, one row a partition,
	 * then the command-session store.
	 *
	 * Each row names the Table's backend and TTL, the worker owning the
	 * partition and its state as `wp nodes status` reads it — `live`,
	 * `stale`, `held`, `idle` or `down` — and where the rows live: the SQLite
	 * file and its size, its `-wal` and `-shm` counted, in bytes and in the disk
	 * the filesystem allocates it, or the shared wpdb table. A live owner is asked for its per-verb counters
	 * over its command channel; a verb it has never run is left out, and an
	 * owner that does not answer in time is warned about and listed without.
	 * A partition no worker holds and only inactive topologies declare has no
	 * owner, and reads `inactive`.
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
		$timeout = CLI::require_flag_int( $assoc_args, 'timeout', self::REPLY_TIMEOUT_S );
		$slots   = $this->slots();
		$stats   = $this->ask( self::owned_by_live( $slots ), 'stats', $timeout );
		$rows    = [];
		foreach ( $slots as $stem => $slot ) {
			$file   = Table_Node::file( $slot['name'], $slot['partition'] );
			$size   = 'sqlite' === $slot['spec']['backend'] ? Sqlite_Arm::footprint( $file ) : null;
			$rows[] = [
				'Table'     => $slot['name'],
				'Partition' => $slot['partition'],
				'Backend'   => $slot['spec']['backend'],
				'TTL'       => (string) $slot['spec']['ttl'],
				'Owner'     => $slot['owner'] ?? '-',
				'State'     => $slot['state'],
				'Store'     => null === $size ? Wpdb_Arm::table() : $file,
				'Bytes'     => $size['bytes'] ?? null,
				'Disk'      => $size['disk'] ?? null,
				'Verbs'     => 'live' === $slot['state'] ? self::verbs( $slot, $stats[ $stem ] ?? null, $timeout ) : null,
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
			'Disk'      => null,
			'Verbs'     => null,
		];
		CLI::print_rows( $assoc_args, $rows, \array_keys( $rows[0] ), self::readable( ... ) );
	}

	/**
	 * A row as the table format prints it: the size in bytes readable, a
	 * missing one a dash, and the counters on one line.
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
			'Bytes' => null === $row['Bytes'] ? '-' : CLI::format_bytes( Core::as_int( $row['Bytes'] ) ),
			'Disk'  => null === $row['Disk'] ? '-' : CLI::format_bytes( Core::as_int( $row['Disk'] ) ),
			'Verbs' => [] === $verbs ? '-' : \implode( ', ', $verbs ),
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
			\WP_CLI::warning( "{$slot['owner']} refused stats for {$slot['name']}: " . self::refusal( $reply ) );
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
	 * the Table's `flush` verb over its command channel. One whose owner is
	 * not running is flushed from here, and only under the fleet hold (`wp
	 * nodes stop`), because otherwise its worker may start and write it at the
	 * same time; a partition with no owner, which only inactive topologies
	 * declare, needs no hold, since nothing spawns its worker. The
	 * command-session store is flushed only when named, and flushing it
	 * revokes every issued session.
	 *
	 * ## OPTIONS
	 *
	 * [<table>...]
	 * : Tables to flush, as their topologies declare them, or
	 * `nodes-sessions`. None flushes every declared Table.
	 *
	 * [--partition=<partition>]
	 * : Flush one partition (0-based); every partition by default.
	 *
	 * [--timeout=<seconds>]
	 * : How long to wait for the owners' replies. Default 10.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes tables flush flame-stats:url
	 *     wp nodes stop && wp nodes tables flush && wp nodes start
	 *     wp nodes tables flush nodes-sessions
	 *
	 * @api WP-CLI subcommand `wp nodes tables flush` — invoked by WP-CLI via reflection, not called in PHP.
	 * @when after_wp_load
	 *
	 * @param array<int,string>   $args       Positional arguments; the Tables.
	 * @param array<string,mixed> $assoc_args Associative arguments; --partition and --timeout.
	 */
	public function flush( array $args, array $assoc_args ): void {
		CLI::refuse_root( 'tables flush' );
		$partition = CLI::require_flag_int( $assoc_args, 'partition', -1 );
		$timeout   = CLI::require_flag_int( $assoc_args, 'timeout', self::REPLY_TIMEOUT_S );
		$slots     = $this->slots();
		$known     = [ ...\array_values( \array_unique( \array_column( $slots, 'name' ) ) ), Command_Auth::SESSIONS_TABLE ];
		foreach ( $args as $name ) {
			if ( ! \in_array( $name, $known, true ) ) {
				\WP_CLI::error( "unknown Table {$name}; declared: " . \implode( ', ', $known ) );
			}
		}
		$chosen = \array_filter(
			$slots,
			static fn ( array $slot ): bool => ( [] === $args || \in_array( $slot['name'], $args, true ) ) && ( -1 === $partition || $partition === $slot['partition'] )
		);
		$replies = $this->ask( self::owned_by_live( $chosen ), 'flush', $timeout );
		$steps   = [];
		foreach ( $chosen as $stem => $slot ) {
			$state           = $slot['state'];
			$steps[ $stem ]  = 'live' === $state
				? static fn (): string => self::released( self::released_by_owner( $slot, $replies[ $stem ] ?? null, $timeout ) ) . " by {$slot['owner']}"
				: static fn (): string => self::released( self::flush_here( $slot, $state ) ) . ( 'inactive' === $state ? '; no active topology declares it' : ' under the hold' );
		}
		if ( \in_array( Command_Auth::SESSIONS_TABLE, $args, true ) ) {
			$steps[ Command_Auth::SESSIONS_TABLE ] = static fn (): string => self::released( Command_Auth::session_table()->flush() ) . '; every issued session is revoked';
		}
		$flushed  = 0;
		$failures = [];
		foreach ( $steps as $name => $step ) {
			try {
				\WP_CLI::log( "{$name}: " . $step() );
				++$flushed;
			} catch ( Worker_Should_Stop $stop ) {
				throw $stop;
			} catch ( \RuntimeException $e ) {
				$failures[] = "{$name}: " . $e->getMessage();
			}
		}
		if ( [] !== $failures ) {
			\WP_CLI::error( \implode( "\n", $failures ) );
		}
		\WP_CLI::success( "Flushed {$flushed} Table partition" . ( 1 === $flushed ? '' : 's' ) . '.' );
	}

	/**
	 * Flush a partition no live worker owns, from this process, when the
	 * fleet is held or its topology is inactive, and so nothing else can be
	 * writing it.
	 *
	 * @param Slot   $slot  The slot.
	 * @param string $state Its owner's state.
	 * @return array<array-key,mixed> What the flush released.
	 * @throws \RuntimeException When the fleet is not held, or the owner is stale, or the flush fails.
	 */
	private static function flush_here( array $slot, string $state ): array {
		$owner = (string) $slot['owner'];
		if ( 'stale' === $state ) {
			$restart = Bootstrap::is_active( CLI::parse_worker_id( $owner )[0] ?? '' ) ? 'restart it, or ' : '';
			throw new \RuntimeException( \esc_html( "{$owner} is stale: its lock stands with no heartbeat; {$restart}wait for its lock to clear, and flush again" ) );
		}
		if ( ! \in_array( $state, [ 'held', 'inactive' ], true ) ) {
			throw new \RuntimeException( \esc_html( "{$owner} is {$state}; run `wp nodes stop` to hold the fleet, flush again, then `wp nodes start`" ) );
		}
		return Table_Node::writer( $slot['name'], $slot['partition'], $slot['spec'] )->flush();
	}

	/**
	 * What a live owner's `flush` reply reports it released.
	 *
	 * @param Slot                  $slot    The slot.
	 * @param array<int,mixed>|null $reply   The reply, or null for none.
	 * @param int                   $timeout Seconds waited.
	 * @return array<array-key,mixed> `{ bytes }` or `{ rows }`.
	 * @throws \RuntimeException On no reply, or a refusal, naming the owner.
	 */
	private static function released_by_owner( array $slot, ?array $reply, int $timeout ): array {
		if ( null === $reply ) {
			throw new \RuntimeException( \esc_html( "{$slot['owner']} did not answer flush within {$timeout}s" ) );
		}
		if ( 0 !== ( Core::int( $reply[ Message::TYPE ] ) & Message::TM_ERROR ) ) {
			throw new \RuntimeException( \esc_html( "{$slot['owner']} refused flush: " . self::refusal( $reply ) ) );
		}
		return Core::arr( Core::arr( $reply[ Message::VALUE ] )['payload'] ?? null );
	}

	/**
	 * Why a TM_ERROR reply refused: an interpreter carries it as its VALUE's
	 * `payload`, and the Router's `NOT_AVAILABLE` bounce as the bare VALUE.
	 *
	 * @param array<int,mixed> $reply The TM_ERROR reply.
	 */
	private static function refusal( array $reply ): string {
		$value = $reply[ Message::VALUE ];
		return \trim( Core::as_string( \is_array( $value ) ? $value['payload'] ?? null : $value ) );
	}

	/**
	 * What a flush released, as its line says it: a `sqlite` Table's bytes,
	 * its old files replaced, or a `wpdb` Table's rows deleted.
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
	 * The Table and owning worker of each slot whose owner is live.
	 *
	 * @param array<string,Slot> $slots Stem => slot.
	 * @return array<string,array{name:string,owner:string}>
	 */
	private static function owned_by_live( array $slots ): array {
		$live = [];
		foreach ( $slots as $stem => $slot ) {
			if ( null !== $slot['owner'] && 'live' === $slot['state'] ) {
				$live[ $stem ] = [
					'name'  => $slot['name'],
					'owner' => $slot['owner'],
				];
			}
		}
		return $live;
	}

	/**
	 * Send each slot's Table its `:config` verb over the owning worker's
	 * command channel, signed as the attached REPL signs, and wait up to
	 * `$timeout` seconds for the replies. Every command goes FROM
	 * `_output/_cli:{pid}/tables-cli/{stem}`, so the channel's gate keeps only
	 * this process's replies and each reaches the one receiver with its stem
	 * as the TO left behind.
	 *
	 * @param array<string,array{name:string,owner:string}> $slots   Stem => Table and owner.
	 * @param string                                        $verb    The `:config` verb.
	 * @param int                                           $timeout Seconds to wait.
	 * @return array<string,array<int,mixed>> Stem => the reply; a slot whose
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
					'arguments' => [],
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
	 * Every partition of every Table a registered topology declares, keyed by
	 * its stem, `{table}.p{N}`, with the worker owning it and that worker's
	 * state as `wp nodes status` reads it. The owner is the first declarer's
	 * worker holding its lock, active topologies first, since a worker of a
	 * deactivated topology writes until it exits; else the first active
	 * declarer's, as `node_tables()` unions the declarers; else none, read as
	 * `inactive`. An inactive topology that will not read is warned about and
	 * left out.
	 *
	 * @return array<string,Slot>
	 * @throws \Throwable As `Bootstrap::node_tables()`.
	 */
	private function slots(): array {
		$configured   = Bootstrap::get_topologies();
		[ $readable ] = Bootstrap::split_readable( $configured );
		$declarers    = self::declarers( $readable );
		$active_names = \array_map( 'strval', \array_keys( $declarers ) );
		$parked       = [];
		foreach ( Bootstrap::get_topology_catalog() as $topology => $entry ) {
			if ( isset( $configured[ $topology ] ) ) {
				continue;
			}
			try {
				$declared = self::declarers( [ (string) $topology => Core::arr( $entry ) ] );
			} catch ( Worker_Should_Stop $stop ) {
				throw $stop;
			} catch ( \RuntimeException $e ) {
				\WP_CLI::warning( "{$topology}: " . Core::message_of( $e ) );
				continue;
			}
			$parked[ (string) $topology ] = Core::arr( $entry );
			foreach ( $declared as $name => $partitions ) {
				foreach ( $partitions as $p => $ids ) {
					$declarers[ $name ][ $p ] = [ ...$declarers[ $name ][ $p ] ?? [], ...$ids ];
				}
			}
		}
		$tables = [] === $active_names ? [] : Bootstrap::node_tables( ...$active_names );
		foreach ( Bootstrap::tables_of( $parked, ...\array_map( 'strval', \array_keys( $declarers ) ) ) as $name => $partitions ) {
			foreach ( $partitions as $p => $spec ) {
				$tables[ $name ][ $p ] ??= $spec;
			}
		}
		$ids = [];
		foreach ( $declarers as $partitions ) {
			foreach ( $partitions as $workers ) {
				\array_push( $ids, ...$workers );
			}
		}
		$states = ( new CLI( Bootstrap::base_dir() ) )->worker_states( \array_values( \array_unique( $ids ) ), $configured, false );
		$slots  = [];
		foreach ( $tables as $name => $partitions ) {
			foreach ( $partitions as $p => $spec ) {
				$candidates = $declarers[ $name ][ $p ];
				$locked     = \array_filter( $candidates, static fn ( string $id ): bool => null !== $states[ $id ]['lock'] );
				$active     = \array_filter( $candidates, static fn ( string $id ): bool => 'inactive' !== $states[ $id ]['state'] );
				$owner      = \array_values( $locked )[0] ?? \array_values( $active )[0] ?? null;
				$slots[ Table_Node::stem( $name, $p ) ] = [
					'name'      => $name,
					'partition' => $p,
					'spec'      => $spec,
					'owner'     => $owner,
					'state'     => null === $owner ? 'inactive' : $states[ $owner ]['state'],
				];
			}
		}
		return $slots;
	}

	/**
	 * Each Table's partitions and the worker of every given topology declaring
	 * it with that partition, in the topologies' order.
	 *
	 * @param array<string,array<array-key,mixed>> $topologies Name => entry.
	 * @return array<string,array<int,list<string>>> Table name => partition => worker ids.
	 * @throws \RuntimeException As `Topology_Analyzer::declared_tables()`.
	 */
	private static function declarers( array $topologies ): array {
		$declarers = [];
		foreach ( $topologies as $topology => $entry ) {
			foreach ( \array_keys( Topology_Analyzer::declared_tables( $topology ) ) as $name ) {
				for ( $p = 0, $n = Bootstrap::partitions_of( $entry ); $p < $n; ++$p ) {
					$declarers[ $name ][ $p ][] = CLI::worker_id( $topology, $p );
				}
			}
		}
		return $declarers;
	}
}
