<?php
/**
 * Remote_Broker: one spoke's command channel and the durable readers its
 * sources claim — the half `Remote_Source` (one SSE connection) and
 * `HTTP_Source` (block fetches) share.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Tachikoma's ConsumerBroker shape over the wire. A broker patrons two hidden
 * siblings, an `HTTP_Out_Node` (`<name>:http-out`) that carries its commands
 * and its readers' reads, and a `Null_Node` (`<name>:null`) that HTTP_Out
 * targets so unaddressed reply-leg traffic is discarded. A source comes by
 * the `add_source <remote_log> <local_node>` verb, and each stamp a source
 * claims is read by its own `Remote_Consumer_Node`, published as the
 * sibling `<broker>:<stamp>`: the cursor, offsetlog, dead letters and
 * debugger all belong to that reader. Each tick, riding the Router's, builds
 * each exact source's reader and hands a subclass its housekeeping, and
 * `write_status()` publishes the status snapshot a dashboard reads.
 *
 * Credentials and URL come from the Vault entry the `<vault-id>` argument
 * names; a missing entry leaves the broker disconnected rather than building
 * patrons that cannot reach a spoke.
 */
abstract class Remote_Broker_Node extends Timer_Node {
	use Schema_Reflection;

	/** Session cadence and status rewrite interval (seconds). */
	public const HEARTBEAT_INTERVAL = 15;

	/** The sibling kind of the SSE_In patron. */
	public const SSE_IN_KIND = 'sse-in';

	/** The sibling kind of the HTTP_Out patron. */
	public const HTTP_OUT_KIND = 'http-out';

	/** The sibling kind of the Null sink HTTP_Out targets. */
	public const NULL_KIND = 'null';

	/**
	 * The sibling kinds no reader may take, shared by every broker:
	 * `fold_source()` judges a source statically against this base, so one
	 * TSL line parses alike in the analyzer and at runtime, whichever broker it
	 * names.
	 */
	public const RESERVED_KINDS = [ self::SSE_IN_KIND, self::HTTP_OUT_KIND, self::NULL_KIND, self::CONFIG_KIND ];

	/** Memcache TTL for the status snapshot (seconds). */
	public const STATUS_TTL = 300;

	/**
	 * The status snapshot's one key set, each key at its value before a
	 * broker fills it: what `Aggregator_CI` and the Status tab read for every
	 * broker. A broker writes only the keys it fills.
	 */
	protected const BLANK_STATUS = [
		'connected'               => false,
		'connecting'              => false,
		'last_connection_attempt' => null,
		'last_http_code'          => null,
		'last_error'              => null,
		'current_backoff'         => null,
		'last_sse_heartbeat'      => null,
		'scheduled_reconnect_at'  => null,
		'last_response'           => null,
		'last_rtt'                => null,
	];

	/**
	 * The most stamps a broker's glob sources claim, counting the readers built
	 * in this process and the reader dirs a glob source left under the offsetlog
	 * root in an earlier one. A spoke names its stamps, so without it a glob
	 * would build a reader and its nodes for every stamp a spoke invents, and
	 * leave a cursor dir for each across restarts. An exact source is bounded by
	 * configuration and never counts. One broker carries one spoke's streams,
	 * and a glob over a topic claims one stamp per partition: the cap is the
	 * `num_partitions` maximum, 16, times a 16× margin for globs.
	 */
	public const MAX_READERS = 256;

	/** The verb that gives a broker a source, spelled once. */
	public const ADD_SOURCE = 'add_source';

	/** The verb that takes a source back, spelled once. */
	public const REMOVE_SOURCE = 'remove_source';

	/** Broker tick (milliseconds): the Router's own, which it hitchhikes. */
	private const TICK_INTERVAL_MS = 1000;

	/** Patron HTTP_Out sibling (`<name>:http-out`); carries commands and reads. */
	protected ?HTTP_Out_Node $http_out = null;

	/**
	 * Sink of last resort: HTTP_Out targets it, so reply-leg traffic the spoke
	 * left unaddressed is discarded instead of routed into this graph.
	 */
	private ?Null_Node $null_sink = null;

	/**
	 * Wall-second the stream's slot lease first existed; only `Remote_Source`
	 * stamps it. `maybe_request_session()` holds the first session request off
	 * half a HEARTBEAT_INTERVAL past it, so the hold-off applies only where it
	 * is stamped: an unstamped 0 lets a broker ask at once.
	 */
	protected int $lease_epoch = 0;

	/** Wall-second of the last session request; its own retry clock. */
	private int $last_session_request = 0;

	/** Vault entry naming the spoke — its URL and credentials. Required. */
	protected string $vault_id = '';

	/**
	 * The status snapshot this broker last wrote: the one copy of what it
	 * publishes, so a write needs no read of the cache first.
	 *
	 * @var array<string,mixed>
	 */
	private array $status = self::BLANK_STATUS;

	/** Wall-second the snapshot was last written; 0 before the first write. */
	private int $status_written_at = 0;

	/**
	 * Whether the spoke logs this pulls are appended by more than one process
	 * (the firehose is, from every request). Unlike Consumer's flag of the same
	 * name it configures the reader on the OTHER end — a pull source has no
	 * segments of its own — because that is where the read happens. The spoke
	 * cannot decide for itself: which of its logs are shared lives in a topology
	 * line, and the spoke opens its readers with no topology in the picture.
	 *
	 * Protected, like Consumer's: the inherited `dump_toggles()` reads it.
	 */
	protected bool $multi_writer = false;

	/** @var list<array{source:string,target:string}> The sources this worker reads, `{partition}` resolved, in declaration order. */
	protected array $sources = [];

	/**
	 * Every source `add_source` took, as written and in order: what the dump
	 * replays and the console draws, whichever partition reads each one.
	 *
	 * @var list<array{source:string,target:string}>
	 */
	private array $declared = [];

	/** The worker partition this broker runs in, bound at load as Table_Node binds it; null outside a worker, which publishes no status. */
	private ?int $bound_partition = null;

	/** The topology this broker runs in, bound at load beside the partition; null outside a worker, whose readers report under no id. */
	private ?string $bound_topology = null;

	/**
	 * The stamps a glob source has claimed, each with a reader here or a dir
	 * under the offsetlog root; null until a glob first builds after
	 * construction or a replay, which counts both again.
	 *
	 * @var array<string,true>|null
	 */
	private ?array $glob_stamps = null;

	/** Root under which each reader's offsetlog sits, at `<root>/<stamp>`. */
	protected string $offsetlog_root = '';

	/** Root under which each reader's dead letters sit, at `<root>/<stamp>`. */
	protected string $deadletter_root = '';

	/** Fanned out to every reader, present or built later. */
	protected bool $assume_clean_shutdown = false;

	/** Tachikoma-parity: no-arg ctor. Auto-wire the `{name}:config` interpreter for the verb table. */
	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	/**
	 * Parse `<vault_id> <offsetlog_root> <deadletter_root>`, arm the recurring
	 * tick, then hand each reader its dirs with a replay. A source comes by
	 * `add_source`, never an argument, so every source outlives a replay.
	 *
	 * A replay that moves the vault supersedes the url and credentials the
	 * live patrons were configured from, and `ensure_channel()` is idempotent
	 * on the property — so an unchecked replay goes on pulling the old spoke
	 * until a fleet RELOAD or a teardown, neither of which a replay reaches.
	 * Dropping the patrons here is the same half-re-read `reload()` does; the
	 * next tick rebuilds. A credential rotated WITHIN a vault_id moves no
	 * argument, and stays `reload()`'s job.
	 *
	 * The fleet's RELOAD reaches `reload()` through a closure, not a name
	 * registration: `fill()` drops anything but a command reply, and a
	 * closure mints no message, so its identity is its provenance.
	 *
	 * @api Dynamic entrypoint.
	 * @param list<string>|null $args Positional tokens, or null to read them.
	 * @return list<string>
	 * @throws \InvalidArgumentException When a token is surplus, missing or mistyped, or a root is its group's.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		static::refuse_surplus( $this->name, $args );
		$this->bound_partition = Core::bound_partition();
		$previous_vault        = $this->vault_id;
		$this->parse_schema_args( $args );
		$this->refuse_group_roots();
		if ( $previous_vault !== $this->vault_id ) {
			$this->drop_patrons();
		}
		$this->set_timer( self::TICK_INTERVAL_MS );
		// Subscribed where the vault config is captured: one lifetime.
		$this->subscribe( Node_Names::FLEET, 'RELOAD', $this->reload( ... ) );
		$this->bound_topology = Core::bound_topology();
		$this->glob_stamps    = null;
		$this->reconcile_readers();
		return $args;
	}

	/**
	 * Inbound message. A command reply (TM_COMMAND|TM_RESPONSE / |TM_ERROR)
	 * routed back from the spoke settles through `settle_reply()`; anything
	 * else is dropped, rate-limited, because a broker relays nothing: what it
	 * sends the spoke it mints and signs itself.
	 *
	 * @api Dynamic entrypoint.
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		++$this->counter;
		$type = Core::int( $message[ Message::TYPE ] );
		if ( ( Message::TM_COMMAND | Message::TM_RESPONSE ) === $type
				|| ( Message::TM_COMMAND | Message::TM_ERROR ) === $type ) {
			$this->settle_reply( $message );
			return;
		}
		// Constant: drop_message keys its throttle on the reason.
		$this->drop_message( $message, 'not a command reply' );
	}

	/**
	 * Each tick: build each exact source's reader, then hand the subclass its
	 * housekeeping, so the readers exist before anything the subclass decides
	 * from them.
	 *
	 * @api Dynamic entrypoint (Timer_Node::fire_cb).
	 */
	public function fire(): void {
		$this->ensure_exact_readers();
		$this->housekeep();
	}

	/**
	 * Refuse a token past the declared positionals, which `parse_schema_args()`
	 * would ignore: a source comes by `add_source`, so a line still carrying
	 * one would load with nothing to read. Static, so the analyzer refuses the
	 * line a load would refuse.
	 *
	 * @param string       $name The node's name, for the refusal.
	 * @param list<string> $args Positional tokens.
	 * @throws \InvalidArgumentException Naming both counts.
	 */
	public static function refuse_surplus( string $name, array $args ): void {
		$accepted = \count( Core::arr( static::node_schema()['arguments'] ?? [] ) );
		if ( \count( $args ) > $accepted ) {
			self::refuse_named( $name, 'too many arguments: ' . \count( $args ) . " given, {$accepted} accepted" );
		}
	}

	/**
	 * Refuse a root that is its group's own: each reader's dir is
	 * `<root>/<stamp>`, so it would land at the group's first level, where a
	 * dir holding the stamp's `:` has no stamp of its own.
	 *
	 * @throws \InvalidArgumentException Naming the group and the fix.
	 */
	private function refuse_group_roots(): void {
		$base = \rtrim( Config::get_base_directory(), '/' );
		foreach ( [ 'offsets' => $this->offsetlog_root, Config::DEADLETTER_SUBDIR => $this->deadletter_root ] as $group => $root ) {
			if ( \rtrim( $root, '/' ) === Log_Discovery::root( $base, $group ) ) {
				// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
				throw new \InvalidArgumentException( self::refusal_prefix() . "a root may not be the {$group} root itself, or each reader's dir lands at its first level; nest it under <topology>, as <config:{$group}_dir>/<topology>.<vault_id>" );
			}
		}
	}

	/**
	 * Build the reader of every exact source; a glob's readers wait for a
	 * stamp the remote names. `consumer_for()` returns a built reader as it is.
	 */
	private function ensure_exact_readers(): void {
		foreach ( $this->sources as [ 'source' => $source ] ) {
			if ( ! Log_Discovery::is_glob( $source ) ) {
				$this->consumer_for( $source );
			}
		}
	}

	/**
	 * Read `$remote_log` into `$local_node`: claim its stamps, its reader
	 * built on the next tick. Every source is kept for the dump, and read only
	 * where `Core::owns()` gives it to this worker (ADR-33). A changed source
	 * list restarts the stream; an identical repeat changes nothing.
	 * `fold_source()` judges the source, as the analyzer judges the line.
	 *
	 * @param string $remote_log A spoke stamp, glob or `sources:<name>`, `{partition}` resolved here.
	 * @param string $local_node The node its lines go to.
	 * @throws \InvalidArgumentException What `fold_source()` refuses.
	 */
	public function add_source( string $remote_log, string $local_node ): void {
		$declared = self::fold_source( $this->declared, self::ADD_SOURCE, $remote_log, $local_node, $this->bound_partition );
		if ( $declared === $this->declared ) {
			return;
		}
		$this->declared = $declared;
		if ( ! Core::owns( $remote_log, $this->bound_partition ) ) {
			return;
		}
		$this->sources[]   = $this->resolved( $remote_log, $local_node );
		$this->glob_stamps = null;
		$this->restream();
	}

	/**
	 * Undo the `add_source` that declared `$remote_log` going to
	 * `$local_node`, both as written: the dump drops it, and where
	 * `Core::owns()` gave it to this worker (ADR-33) its lines stop routing,
	 * each reader it alone claimed hands its cursor off and is retracted, its
	 * dirs left on disk, and the stream restarts without it.
	 *
	 * @param string $remote_log The source, as `add_source` took it.
	 * @param string $local_node Its target, as `add_source` took it.
	 * @throws \InvalidArgumentException What `fold_source()` refuses.
	 */
	public function remove_source( string $remote_log, string $local_node ): void {
		$this->declared = self::fold_source( $this->declared, self::REMOVE_SOURCE, $remote_log, $local_node, $this->bound_partition );
		if ( ! Core::owns( $remote_log, $this->bound_partition ) ) {
			return;
		}
		$this->sources     = Core::without( $this->sources, $this->resolved( $remote_log, $local_node ) );
		$this->glob_stamps = null;
		$this->reconcile_readers();
		$this->restream();
	}

	/**
	 * A source as this worker reads it, `{partition}` resolved at its
	 * partition, or at 0 where none is bound and the source names none.
	 *
	 * @param string $remote_log The source, as written.
	 * @param string $local_node Its target, as written.
	 * @return array{source:string,target:string}
	 */
	private function resolved( string $remote_log, string $local_node ): array {
		return [
			'source' => Core::resolve_partition_template( $remote_log, $this->bound_partition ?? 0 ),
			'target' => Core::resolve_partition_template( $local_node, $this->bound_partition ?? 0 ),
		];
	}

	/**
	 * Retract each reader no source claims any more, its cursor handed off
	 * and its dirs left on disk, and hand each survivor the target, dirs and
	 * names of the source that claims it.
	 */
	private function reconcile_readers(): void {
		foreach ( $this->readers() as $stamp => $child ) {
			$source = $this->source_for( $stamp );
			if ( null === $source ) {
				$child->hand_off_cursor();
				$this->retract_sibling( $stamp );
				continue;
			}
			$child->connect_node( $source['target'] );
			if ( $this->reader_args( $stamp ) !== $child->arguments() ) {
				$child->arguments( $this->reader_args( $stamp ) );
			}
			$child->broker( $this );
		}
	}

	/**
	 * The target of each source the commands leave declared, in order: the
	 * edges a Vault_Group of this class and the analyzer draw.
	 *
	 * @param list<array{0:string,1:list<string>}> $commands Each verb and its argument tokens, in the order sent.
	 * @return list<string>
	 * @throws \InvalidArgumentException What `sources_of()` refuses.
	 */
	public static function command_targets( array $commands ): array {
		return \array_column( static::sources_of( $commands ), 'target' );
	}

	/**
	 * The sources a run of `add_source` and `remove_source` commands leaves
	 * declared, as written and in order, each bound as its verb binds it and
	 * folded by `fold_source()` at partition 0, so a line the load refuses
	 * refuses the run and the analyzer reads the topology as unreadable. The
	 * browser's `sourcesOf()` folds the same, held to this by
	 * `tests/fixtures/broker-sources.json`.
	 *
	 * @param list<array{0:string,1:list<string>}> $commands Each verb and its argument tokens, in the order sent.
	 * @return list<array{source:string,target:string}>
	 * @throws \InvalidArgumentException The first command the verb refuses.
	 */
	public static function sources_of( array $commands ): array {
		$sources = [];
		foreach ( $commands as [ $verb, $tokens ] ) {
			if ( self::ADD_SOURCE !== $verb && self::REMOVE_SOURCE !== $verb ) {
				continue;
			}
			$bound   = Command_Args::bind( Core::arr( Command_Interpreter_Node::declared_verbs( static::class )[ $verb ]['args'] ?? [] ), $tokens );
			$sources = self::fold_source( $sources, $verb, Core::as_string( $bound['remote_log'] ), Core::as_string( $bound['local_node'] ), 0 );
		}
		return $sources;
	}

	/**
	 * The one source rule: the declared sources once one `add_source` or
	 * `remove_source` applies, both as written. A source goes to one target,
	 * compared as written, so a glob and an exact stamp it matches are two
	 * sources; an identical repeat answers `$declared` unchanged; a removal
	 * must name a declared source. An added source must be one a spoke can
	 * stream and whose reader takes no slot the broker keeps, judged with
	 * `{partition}` resolved at `$partition`. The runtime folds at its bound
	 * partition, the analyzer at 0; the browser's `foldSource()` is the twin.
	 *
	 * @param list<array{source:string,target:string}> $declared   The sources declared so far, as written.
	 * @param string                                   $verb       `add_source` or `remove_source`.
	 * @param string                                   $remote_log The source, as written.
	 * @param string                                   $local_node Its target, as written.
	 * @param int|null                                 $partition  The partition `{partition}` resolves at; null where none is bound.
	 * @return list<array{source:string,target:string}>
	 * @throws \InvalidArgumentException When the source already goes elsewhere,
	 *                                   a removal names no declared source, no
	 *                                   spoke can stream it, its reader would
	 *                                   take a kept slot, or it names
	 *                                   `{partition}` where none is bound.
	 */
	public static function fold_source( array $declared, string $verb, string $remote_log, string $local_node, ?int $partition ): array {
		$written = [ 'source' => $remote_log, 'target' => $local_node ];
		if ( self::REMOVE_SOURCE === $verb ) {
			if ( ! \in_array( $written, $declared, true ) ) {
				throw Command_Args::undeclared( $verb, [ $remote_log, $local_node ], 'source', 'node' );
			}
			return Core::without( $declared, $written );
		}
		$taken = \array_column( $declared, 'target', 'source' )[ $remote_log ] ?? null;
		if ( $local_node === $taken ) {
			return $declared;
		}
		$refuse = static function ( string $why ) use ( $verb, $remote_log ): never {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
			throw new \InvalidArgumentException( "{$verb} '{$remote_log}' {$why}" );
		};
		if ( null !== $taken ) {
			$refuse( "already goes to '{$taken}', not '{$local_node}'" );
		}
		if ( null === $partition && ( Core::has_partition_token( $remote_log ) || Core::has_partition_token( $local_node ) ) ) {
			$refuse( "'{$local_node}' names " . Core::PARTITION_TOKEN . ', but no partition is bound' );
		}
		$source = Core::resolve_partition_template( $remote_log, $partition ?? 0 );
		$glob   = Log_Discovery::is_glob( $source );
		if ( ! ( $glob ? Log_Discovery::is_subscription( $source ) : Log_Discovery::fits_a_dir_name( $source ) ) ) {
			$refuse( 'names a source no spoke can stream' );
		}
		if ( ! $glob && self::is_reserved( $source ) ) {
			$refuse( 'names a slot the node keeps for its own' );
		}
		return [ ...$declared, $written ];
	}

	/**
	 * The credentials this node reads live in its patrons, resolved once from
	 * the Vault. Dropping them is HALF the re-read: the Vault memoizes its
	 * entries for the life of the process, so the other half is `Vault::reset()`
	 * on `Config::RESET_ACTION`, which the fleet fires before it announces the
	 * RELOAD. Without that, the next tick rebuilds the patrons from the same
	 * cached entry and a rotated credential reconnects a healthy channel with
	 * the old password. The cursor is restored as on any reconnect.
	 */
	public function reload(): void {
		$this->drop_patrons();
	}

	/**
	 * The reader for a stamp, built on first sight when a source claims it; null
	 * when none does. A spoke names the stamps it sends, and a stamp names a
	 * sibling slot and a directory here, so the one builder refuses four,
	 * rate-limited: a stamp outside the stream name grammar, one naming a slot
	 * the broker keeps, one no source claims, and a glob's past `MAX_READERS`.
	 *
	 * @param string $stamp A record's stamp.
	 */
	protected function consumer_for( string $stamp ): ?Remote_Consumer_Node {
		$built = $this->reader( $stamp );
		if ( null !== $built ) {
			return $built;
		}
		if ( '' === $this->name ) {
			return null;
		}
		if ( ! Log_Discovery::fits_a_dir_name( $stamp ) ) {
			$this->print_less_often( 'refusing a stamp outside the stream name grammar' );
			return null;
		}
		if ( self::is_reserved( $stamp ) ) {
			$this->print_less_often( 'refusing a stamp that names a slot the broker keeps' );
			return null;
		}
		$source = $this->source_for( $stamp );
		if ( null === $source ) {
			$this->print_less_often( 'dropping a line no source claims: ', $stamp );
			return null;
		}
		if ( Log_Discovery::is_glob( $source['source'] ) && ! $this->claim_glob_stamp( $stamp ) ) {
			$this->print_less_often( 'refusing a reader past MAX_READERS: ', (string) self::MAX_READERS );
			return null;
		}
		$child = new Remote_Consumer_Node();
		$child->patron( $this );
		$this->publish_sibling( $stamp, $child );
		$child->sink( $this->sink );
		$child->arguments( $this->reader_args( $stamp ) );
		$child->connect_node( $source['target'] );
		$child->broker( $this );
		$child->set_assume_clean_shutdown( $this->assume_clean_shutdown );
		$this->http_out?->allow_replies_to( $child->name() );
		return $child;
	}

	/**
	 * The reader a stamp's slot holds in the sibling map, or null; builds
	 * nothing, and a slot holding anything else is no reader.
	 *
	 * @param string $stamp A record's stamp.
	 */
	protected function reader( string $stamp ): ?Remote_Consumer_Node {
		$sibling = $this->siblings()[ $stamp ] ?? null;
		return $sibling instanceof Remote_Consumer_Node ? $sibling : null;
	}

	/**
	 * Claim a stamp for a glob source's reader: free when the stamp holds a
	 * reader or a dir already, refused once `MAX_READERS` stamps are claimed.
	 * The first claim, after construction or a replay, counts the glob
	 * readers built here and the reader dirs a glob source left under the
	 * offsetlog root, so the cap holds across a replay and a restart alike.
	 *
	 * @param string $stamp The stamp the reader would read.
	 * @return bool True when the reader may be built.
	 */
	private function claim_glob_stamp( string $stamp ): bool {
		$this->glob_stamps ??= $this->claimed_glob_stamps();
		if ( ! isset( $this->glob_stamps[ $stamp ] ) ) {
			if ( \count( $this->glob_stamps ) >= self::MAX_READERS ) {
				return false;
			}
			$this->glob_stamps[ $stamp ] = true;
		}
		return true;
	}

	/**
	 * The stamps a glob source claims, among the readers built here and the
	 * reader dirs under the offsetlog root, each dir's basename its stamp. A
	 * reader with no checkpoint yet has no dir, so the readers count as well
	 * as the disk.
	 *
	 * @return array<string,true>
	 */
	private function claimed_glob_stamps(): array {
		$stamps = [ ...\array_keys( $this->readers() ), ...\array_map( '\basename', \glob( "{$this->offsetlog_root}/*", \GLOB_ONLYDIR ) ?: [] ) ];
		$claimed = [];
		foreach ( $stamps as $stamp ) {
			$source = $this->source_for( $stamp );
			if ( null !== $source && Log_Discovery::is_glob( $source['source'] ) ) {
				$claimed[ $stamp ] = true;
			}
		}
		return $claimed;
	}

	/**
	 * A reader's tokens: its stamp, then its offsetlog and dead-letter dirs,
	 * each nested under the broker's root at the stamp itself.
	 *
	 * @param string $stamp A record's stamp.
	 * @return list<string>
	 */
	private function reader_args( string $stamp ): array {
		return [ $stamp, "{$this->offsetlog_root}/{$stamp}", "{$this->deadletter_root}/{$stamp}" ];
	}

	/**
	 * The first source, in declaration order, that is the stamp or a glob
	 * matching it.
	 *
	 * @param string $stamp A record's stamp.
	 * @return array{source:string,target:string}|null
	 */
	protected function source_for( string $stamp ): ?array {
		foreach ( $this->sources as $source ) {
			if ( Log_Discovery::carries( $source['source'], $stamp ) ) {
				return $source;
			}
		}
		return null;
	}

	/**
	 * Restart the readers' feed so the next request states the live set
	 * again. A reader calls it when it pauses, plays or seeks, and
	 * `add_source` when the source list moves.
	 */
	abstract public function restream(): void;

	/**
	 * Settle a command reply the spoke routed back to the broker's own name:
	 * whatever this broker sent FROM itself.
	 *
	 * @param array<int,mixed> $message The reply, TM_COMMAND|TM_RESPONSE or |TM_ERROR.
	 */
	abstract protected function settle_reply( array $message ): void;

	/**
	 * Send one reader's read to the spoke's `raw-logs` service, FROM the
	 * reader's own name, so the reply returns to it by TO through HTTP_Out
	 * (whose allowlist names every reader) and `_router`. A spoke this broker
	 * holds no session with gets asked for one at the channel's cadence, and
	 * the reader asks again.
	 *
	 * @param Remote_Consumer_Node $child The reader asking.
	 * @param string               $verb  `read_message` or `read_block`.
	 * @param list<string>         $args  The verb's argument tokens, which the reply echoes.
	 * @return bool True once the command is queued.
	 */
	public function send_read( Remote_Consumer_Node $child, string $verb, array $args ): bool {
		$http    = $this->ensure_channel();
		$message = $this->mint( $child->name(), Remote_Consumer_Node::RAW_LOGS_SERVICE, $verb, $args );
		if ( null === $http || null === $message ) {
			return false;
		}
		$http->fill( $message );
		return true;
	}

	/**
	 * Build and publish the `HTTP_Out` and `:null` siblings on first call;
	 * null while the broker is unnamed or the Vault names no reachable spoke.
	 * HTTP_Out admits the broker's own replies and each reader's.
	 */
	protected function ensure_channel(): ?HTTP_Out_Node {
		if ( null !== $this->http_out ) {
			return $this->http_out;
		}
		if ( '' === $this->name || null === $this->spoke_entry() ) {
			return null;
		}
		$http = new HTTP_Out_Node();
		$http->patron( $this );
		$http->arguments( [ $this->vault_id ] );
		$http->sink( $this->sink );
		// Arms HTTP_Out's wire-inbound clause; unaddressed traffic ends here.
		$null = new Null_Node();
		$null->patron( $this );
		$this->http_out  = $http;
		$this->null_sink = $null;
		$this->publish_patron( self::HTTP_OUT_KIND, $http );
		$this->publish_patron( self::NULL_KIND, $null );
		$this->address_null_sink();
		foreach ( $this->readers() as $child ) {
			$http->allow_replies_to( $child->name() );
		}
		return $http;
	}

	/**
	 * The spoke's Vault entry, once it names a url; null otherwise, said
	 * rate-limited, so the broker stays disconnected rather than building
	 * patrons that cannot reach a spoke.
	 *
	 * @return array<string,mixed>|null
	 */
	protected function spoke_entry(): ?array {
		$entry = Vault::get_instance()->get( $this->vault_id );
		if ( null === $entry ) {
			$this->print_less_often( 'no Vault entry; staying disconnected' );
			return null;
		}
		if ( '' === Vault::url_of( $entry ) ) {
			$this->print_less_often( 'Vault entry has no url; staying disconnected' );
			return null;
		}
		return $entry;
	}

	/**
	 * Mint one command for this broker's spoke through `Command_Auth::mint_for()`,
	 * which asks for a missing session through `maybe_request_session()`, so
	 * every minter on the broker — a heartbeat and a reader's read alike —
	 * asks at the broker's pace. Call it with the channel built.
	 *
	 * @param string       $from      Where the reply returns.
	 * @param string       $to        The path the command addresses.
	 * @param string       $verb      Command name the spoke's interpreter runs.
	 * @param list<string> $arguments Command argument tokens.
	 * @return array<int,mixed>|null The signed command, or null with no egress or session.
	 */
	protected function mint( string $from, string $to, string $verb, array $arguments ): ?array {
		$http_out = $this->http_out;
		if ( null === $http_out ) {
			return null;
		}
		return Command_Auth::mint_for( $http_out, $from, $to, $verb, $arguments, fn () => $this->maybe_request_session( $http_out, (int) Core::$now ) );
	}

	/**
	 * Ask the spoke for a command session: at most one request per
	 * HEARTBEAT_INTERVAL, on this broker's own second of the cadence or the
	 * one after it, since a Router tick drifting late can skip a second.
	 *
	 * @param HTTP_Out_Node $http_out The patron that holds the session.
	 * @param int           $now      Current wall-second.
	 */
	private function maybe_request_session( HTTP_Out_Node $http_out, int $now ): void {
		// intdiv, so a 1s housekeeping tick can actually land on the boundary.
		$offset = \intdiv( self::HEARTBEAT_INTERVAL, 2 );
		if ( $now - $this->lease_epoch < $offset ) {
			return;
		}
		// @longform Each broker owns one second of the cadence, from its name.
		// A spoke restart or key rotation drops every session at once, leaving
		// every broker past its retry gate and asking together. A phase on the
		// absolute clock spreads first boot and mass re-auth alike, and
		// survives both because no session loss resets it.
		if ( 1 < ( $now - $this->session_phase() ) % self::HEARTBEAT_INTERVAL ) {
			return;
		}
		if ( $this->last_session_request > 0
				&& $now - $this->last_session_request < self::HEARTBEAT_INTERVAL ) {
			return;
		}
		$this->last_session_request = $now;
		$http_out->ensure_session();
	}

	/** This broker's second within the cadence. Stable, so it survives re-auth. */
	private function session_phase(): int {
		return \crc32( $this->name ) % self::HEARTBEAT_INTERVAL;
	}

	/**
	 * One tick's housekeeping, after the exact sources' readers are built: keep
	 * the channel and the readers' feed up.
	 */
	abstract protected function housekeep(): void;

	/**
	 * Merge $data into the status snapshot and write it under the per-node key
	 * when it changed, or once a `HEARTBEAT_INTERVAL` has run since the last
	 * write: a broker whose state stands still writes once a heartbeat rather
	 * than once a second, and a key the cache evicted or lost on a restart is
	 * back within one interval instead of reading as down.
	 *
	 * @param array<string,mixed> $data Fields to merge over the snapshot.
	 */
	protected function write_status( array $data ): void {
		$cache = Cache_Backend::shared_first();
		if ( null === $cache || null === $this->bound_partition ) {
			return;
		}
		$status = \array_merge( $this->status, $data );
		$now    = (int) Core::$now;
		if ( $status === $this->status && $now - $this->status_written_at < self::HEARTBEAT_INTERVAL ) {
			return;
		}
		$cache->set( self::status_key_for( $this->name, $this->bound_partition ), $status, self::STATUS_TTL );
		$this->status            = $status;
		$this->status_written_at = $now;
	}

	/**
	 * The cache key one broker publishes its status snapshot under: by NODE
	 * NAME, so two spokes do not collide; by worker PARTITION, because the same
	 * broker line runs once per partition; site-scoped, so two hubs naming a
	 * spoke alike do not either. Public because Aggregator_CI resolves the
	 * writer's exact key through it.
	 *
	 * @param string $name      The broker's name.
	 * @param int    $partition The worker partition it runs in.
	 */
	public static function status_key_for( string $name, int $partition ): string {
		return Cache_Backend::site_key( "remote:{$name}:p{$partition}" );
	}

	/**
	 * Name the siblings through `parent::`, re-address HTTP_Out at the renamed
	 * Null, then admit each reader's replies by its new name and hand it the
	 * names it reports under. A new name is a new status key, which the next
	 * tick writes. An override that drops the `parent::` call stops every
	 * sibling being named, with no other symptom and no gate to catch it.
	 */
	protected function set_sibling_names(): void {
		parent::set_sibling_names();
		$this->address_null_sink();
		$this->status_written_at = 0;
		foreach ( $this->readers() as $child ) {
			$this->http_out?->allow_replies_to( $child->name() );
			$child->broker( $this );
		}
	}

	/**
	 * Point HTTP_Out at the Null by its CURRENT name. `target` is a stored
	 * string, not a reference, so every step that spells the Null's name —
	 * the first build and every rename after it — has to re-address the
	 * writer, or it keeps addressing a name the registry dropped.
	 */
	private function address_null_sink(): void {
		if ( '' !== $this->name && null !== $this->http_out && null !== $this->null_sink ) {
			$this->http_out->target( $this->null_sink->name() );
			// Its own replies self-route here; declare them with the target.
			$this->http_out->allow_replies_to( $this->name );
		}
	}

	/**
	 * Publish one patron into its sibling slot, or drop every patron and
	 * rethrow: a cached unnamed patron would be served on every later tick.
	 *
	 * @param string $kind   The sibling kind.
	 * @param Node   $patron The patron to publish.
	 * @throws \Throwable What `publish_sibling()` threw, after the drop.
	 */
	protected function publish_patron( string $kind, Node $patron ): void {
		try {
			$this->publish_sibling( $kind, $patron );
		} catch ( \Throwable $e ) {
			$this->drop_patrons();
			throw $e;
		}
	}

	/**
	 * The two names a reader of this broker reports under on the probe log:
	 * SOURCE, the spoke's log as `Log_Discovery::remote_for()` names it, and
	 * READER, `reader_id()`, blank outside a worker, where the broker is bound
	 * to no topology or partition.
	 *
	 * @param string $stamp The reader's stamp.
	 * @return array{0:string,1:string} The SOURCE, then the READER.
	 */
	public function probe_names( string $stamp ): array {
		$reader = null === $this->bound_topology || null === $this->bound_partition
			? ''
			: self::reader_id( $this->bound_topology, $this->name, $stamp, $this->bound_partition );
		return [ Log_Discovery::remote_for( $this->vault_id, $stamp ), $reader ];
	}

	/**
	 * The id a broker's reader reports under on the probe log: its node name,
	 * `<broker>:<stamp>`, scoped by the topology and spelled as a worker id at
	 * the worker partition the broker runs in, as a stock Consumer's offsetlog
	 * basename `<topology>.<log>.p{partition}` is. Two spokes' `firehose.p0`
	 * readers then key apart, `CLI::consumer_rows()` reads the partition back
	 * through `CLI::parse_worker_id()`, and a stale row of an active topology
	 * keeps its place. Public because `Aggregator_CI` matches the rows of each
	 * broker it reports through it, with the stamp `Log_Discovery::remote_of()`
	 * reads off the row's SOURCE; the Workers dashboard's
	 * `reconstructWorkers()` composes it the same way.
	 *
	 * @param string $topology  The topology the broker runs in.
	 * @param string $broker    The broker's name.
	 * @param string $stamp     The reader's stamp.
	 * @param int    $partition The worker partition the broker runs in.
	 */
	public static function reader_id( string $topology, string $broker, string $stamp, int $partition ): string {
		return CLI::worker_id( "{$topology}." . self::sibling_name_of( $broker, $stamp ), $partition );
	}

	/**
	 * Fan `assume_clean_shutdown` out to every reader, and to each one built later.
	 *
	 * @param bool $flag True commits past a stopped message on a cooperative stop.
	 */
	public function set_assume_clean_shutdown( bool $flag ): void {
		$this->assume_clean_shutdown = $flag;
		foreach ( $this->readers() as $child ) {
			$child->set_assume_clean_shutdown( $flag );
		}
	}

	/**
	 * An operational stop hands each reader's cursor off — the path a
	 * Vault_Group retraction takes. A cooperative one does nothing here: the
	 * worker's sweep reaches every reader itself, and a second strike would
	 * climb a healthy reader's attempts.
	 *
	 * @param string $stop_reason             `timeout` or `memory` for a cooperative stop.
	 * @param bool   $baseline_near_watermark Memory stop only.
	 * @throws \Throwable What the readers' handoffs threw, combined.
	 */
	public function hand_off_cursor( string $stop_reason = '', bool $baseline_near_watermark = false ): void {
		if ( 'timeout' === $stop_reason || 'memory' === $stop_reason ) {
			return;
		}
		Worker_Should_Stop::raise(
			Worker_Should_Stop::attempt_each( $this->readers(), static fn ( Remote_Consumer_Node $child ) => $child->checkpoint_shutdown() )
		);
	}

	/**
	 * Every reader the sibling map holds, by stamp, in the order they were
	 * built: the map is the one list of them.
	 *
	 * @return array<string,Remote_Consumer_Node>
	 */
	protected function readers(): array {
		return \iterator_to_array( $this->reader_walk() );
	}

	/**
	 * Whether a stamp's reader would take a sibling slot the broker publishes
	 * itself, which `publish_sibling()` refuses.
	 *
	 * @param string $stamp A record's stamp.
	 */
	private static function is_reserved( string $stamp ): bool {
		return \in_array( $stamp, self::RESERVED_KINDS, true );
	}

	/** A source refusal's opening: the shell name of the broker class refusing it. */
	private static function refusal_prefix(): string {
		return Command_Interpreter_Node::shell_name_for( static::class ) . ': ';
	}

	/**
	 * Teardown: tear down the patrons, then remove self.
	 *
	 * @api Dynamic entrypoint.
	 */
	public function remove_node(): void {
		$this->drop_patrons();
		parent::remove_node();
	}

	/**
	 * Retract the channel's siblings and void every request the channel
	 * carried: each reader's step or fetch goes again on its next poll rather
	 * than wait out `REQUEST_TIMEOUT` for a reply that cannot come. A subclass
	 * drops what it adds and calls this.
	 */
	protected function drop_patrons(): void {
		$this->http_out  = null;
		$this->null_sink = null;
		$this->retract_sibling( self::HTTP_OUT_KIND );
		$this->retract_sibling( self::NULL_KIND );
		foreach ( $this->reader_walk() as $child ) {
			$child->drop_requests();
		}
	}

	/**
	 * The one walk of the sibling map for its readers, keyed by stamp; it
	 * builds nothing, so a per-line sum pays for no array.
	 *
	 * @return \Generator<string,Remote_Consumer_Node>
	 */
	protected function reader_walk(): \Generator {
		foreach ( $this->siblings() as $sibling ) {
			if ( $sibling instanceof Remote_Consumer_Node ) {
				yield $sibling->stamp() => $sibling;
			}
		}
	}

	/**
	 * `add_source` verb handler: give the patron a source.
	 *
	 * @param Command_Interpreter_Node $interpreter The auto-wired `:config` interpreter.
	 * @param array<array-key,mixed>   $args        Bound verb arguments: remote_log, local_node.
	 * @return string
	 * @throws \InvalidArgumentException What `add_source()` refused.
	 */
	public static function cmd_add_source( Command_Interpreter_Node $interpreter, array $args ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->add_source( Core::as_string( $args['remote_log'] ), Core::as_string( $args['local_node'] ) );
		return "ok\n";
	}

	/**
	 * `remove_source` verb handler: take a source back from the patron.
	 *
	 * @param Command_Interpreter_Node $interpreter The auto-wired `:config` interpreter.
	 * @param array<array-key,mixed>   $args        Bound verb arguments: remote_log, local_node.
	 * @return string
	 * @throws \InvalidArgumentException What `remove_source()` refused.
	 */
	public static function cmd_remove_source( Command_Interpreter_Node $interpreter, array $args ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->remove_source( Core::as_string( $args['remote_log'] ), Core::as_string( $args['local_node'] ) );
		return "ok\n";
	}

	/**
	 * Each added source's target, as written, so the canvas and the analyzer
	 * draw one `pair` edge per source.
	 *
	 * @return list<string>
	 */
	protected function extra_targets(): array {
		return \array_column( $this->declared, 'target' );
	}

	/**
	 * When the spoke last proved, by word on a live channel, that it has
	 * nothing more to send than it sent, or the hub kept it quiet; null when
	 * no channel says so. A pushed stream's heartbeat does, and keeps its
	 * readers' backlog current while it stays quiet. A pulling broker has
	 * none: its fetches say it.
	 */
	public function heard_at(): ?float {
		return null;
	}

	/**
	 * A refusal's reason for the status snapshot's `last_error`: one bounded
	 * line, never a raw response body.
	 *
	 * @param mixed  $payload  The response payload, a string or an array.
	 * @param string $fallback Reason to report when the payload names none.
	 */
	protected static function failure_reason( mixed $payload, string $fallback ): string {
		$reason = \is_string( $payload ) ? $payload : '';
		if ( \is_array( $payload ) ) {
			foreach ( [ 'error', 'message', 'reason' ] as $key ) {
				if ( isset( $payload[ $key ] ) && \is_string( $payload[ $key ] ) ) {
					$reason = $payload[ $key ];
					break;
				}
			}
		}
		$clean = \preg_replace( '/[\x00-\x1F\x7F]+/', ' ', $reason );
		$clean = \trim( null === $clean ? '' : $clean );
		if ( '' === $clean ) {
			return $fallback;
		}
		if ( \strlen( $clean ) > 512 ) {
			return \substr( $clean, 0, 509 ) . '...';
		}
		return $clean;
	}

	/**
	 * A round trip for the status snapshot's `last_rtt`: milliseconds, as the
	 * Status tab reads it, to the hundredth it shows below one millisecond.
	 *
	 * @param float $seconds The round trip in seconds.
	 */
	protected static function round_trip_ms( float $seconds ): float {
		return \round( $seconds * 1000, 2 );
	}

	/**
	 * A live reader drained under its mark: let its feed resume. A reader
	 * calls it from each refill.
	 *
	 * @param Remote_Consumer_Node $child The reader that drained.
	 */
	abstract public function refill( Remote_Consumer_Node $child ): void;

	/** Whether the spoke reads this broker's logs with the multi-writer seal-grace. */
	public function multi_writer(): bool {
		return $this->multi_writer;
	}

	/**
	 * Ask the spoke to read every log with the multi-writer seal-grace
	 * (`Consumer_Node::SEAL_GRACE_SECONDS`): a peer there can keep appending to
	 * segment N for `Partition_Node::DRIFT_RESCAN_INTERVAL_SECONDS` after N+1
	 * appears, and a reader that advances on sight orphans that straggler —
	 * for the firehose, typically a request's terminal `process (complete)`,
	 * which then never finalizes here.
	 *
	 * @param bool $flag Whether the spoke should apply the seal-grace.
	 */
	public function set_multi_writer( bool $flag ): void {
		$this->multi_writer = $flag;
	}

	/** HTTP_Out's tally: the broker holds no socket of its own to write. */
	public function bytes_written(): int {
		return $this->http_out?->bytes_written() ?? 0;
	}

	/** Round-trip each added source, then the toggles, after the `make_node` line. */
	public function dump_config(): string {
		$out = parent::dump_config();
		foreach ( $this->declared as [ 'source' => $source, 'target' => $target ] ) {
			$out .= $this->config_line( self::ADD_SOURCE, $source, $target );
		}
		return $out . $this->dump_toggles();
	}

	/**
	 * Configuration form: the vault and the two roots each reader's dirs
	 * nest under, and the verbs: `add_source` and `remove_source`, then the
	 * two that reach every reader.
	 *
	 * @api Dynamic entrypoint.
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		$source_args = [
			[ 'name' => 'remote_log', 'type' => 'string', 'required' => true, 'description' => 'A spoke stamp, glob or `sources:<name>`.' ],
			[ 'name' => 'local_node', 'type' => 'string', 'required' => true, 'description' => 'The node its lines go to.' ],
		];
		return [
			'category'     => 'Hidden',
			// Each source names its destination, so Node refuses connect_node.
			'has_target'   => false,
			'description'  => 'Broker base: one spoke\'s command channel and a durable reader per source `add_source` names.',
			'arguments'    => [
				[ 'name' => 'vault_id',        'type' => 'vault_id', 'required' => true, 'description' => 'Which spoke to connect to — a Vault-registered server (URL + credentials).' ],
				[ 'name' => 'offsetlog_root',  'type' => 'string',   'required' => true, 'partition' => 'bound', 'description' => 'Directory each reader\'s durable read-cursor offsetlog nests under, at <root>/<stamp>. Carry `<topology>` so two fleets pulling one spoke keep separate cursors.' ],
				[ 'name' => 'deadletter_root', 'type' => 'string',   'required' => true, 'partition' => 'bound', 'description' => 'Directory each reader\'s quarantined poison records nest under, at <root>/<stamp>.' ],
			],
			'commands'     => [
				[
					'name'        => self::ADD_SOURCE,
					'description' => 'Read a spoke log into a local node: a stamp, a glob or `sources:<name>`, `{partition}` resolved at the worker\'s. A repeat is a no-op; a second target for the source is refused.',
					'args'        => $source_args,
					'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_add_source( $interpreter, $args ),
					// One call per source: the console renders a row each.
					'multiple'    => true,
				],
				[
					'name'        => self::REMOVE_SOURCE,
					'description' => 'Stop reading a source add_source gave, named as add_source took it: its readers go, their cursors and dead letters stay on disk.',
					'args'        => $source_args,
					'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_remove_source( $interpreter, $args ),
					'multiple'    => true,
				],
				[
					'name'        => 'set_multi_writer',
					'description' => 'Ask the spoke to read its logs with the multi-writer seal-grace (shared logs, e.g. the firehose).',
					'args'        => [
						[ 'name' => 'enabled', 'type' => 'bool', 'required' => false, 'description' => '1, true, yes or on enables; 0, false, no or off disables; any other word is refused.' ],
					],
					'toggle'      => 'multi_writer',
				],
				[
					...Remote_Consumer_Node::pump_verbs()[0],
					'description' => 'Treat a plain Worker_Should_Stop like Worker_Should_Stop_Clean in every reader — commit PAST the in-flight message on a cooperative stop instead of replaying it. For a durable-before-stop chain with no snapshot node (aggregator, Consumer→Partition, job-router). Only a true word enables.',
				],
			],
			'requests'     => [],
			'accepts_fill' => false,
		];
	}
}
