<?php
/**
 * Remote_Broker: one spoke's command channel and the durable readers its
 * `<source>:<target>` pairs claim — the half `Remote_Source` (one SSE
 * connection) and `HTTP_Source` (block fetches) share.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Tachikoma's ConsumerBroker shape over the wire. A broker patrons two hidden
 * siblings, an `HTTP_Out_Node` (`<name>:http-out`) that carries its commands
 * and its readers' reads, and a `Null_Node` (`<name>:null`) that HTTP_Out
 * targets so unaddressed reply-leg traffic is discarded. Each stamp a pair
 * claims is read by its own `Remote_Consumer_Node`, published as the sibling
 * `<broker>:<kind>`: the cursor, offsetlog, dead letters and debugger all
 * belong to that reader. Each tick, riding the Router's, builds each exact
 * pair's reader and hands a subclass its housekeeping, and `write_status()`
 * publishes the status snapshot a dashboard reads.
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
	 * The sibling kinds no reader may take, shared by every broker: `parse_pair()`
	 * judges a pair statically against this base, so one TSL line parses alike
	 * in the analyzer and at runtime, whichever broker it names.
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
		'unparseable_lines'       => 0,
		'last_response'           => null,
		'last_rtt'                => null,
	];

	/**
	 * The most stamps a broker's glob pairs claim, counting the readers built
	 * in this process and the reader dirs a glob pair left under the offsetlog
	 * root in an earlier one. A spoke names its stamps, so without it a glob
	 * would build a reader and its nodes for every stamp a spoke invents, and
	 * leave a cursor dir for each across restarts. An exact pair is bounded by
	 * configuration and never counts. One broker carries one spoke's streams,
	 * and a glob over a topic claims one stamp per partition: the cap is the
	 * `num_partitions` maximum, 16, times a 16× margin for globs.
	 */
	public const MAX_READERS = 256;

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

	/** @var list<array{source:string,target:string}> The pairs this broker carries, in declaration order. */
	protected array $pairs = [];

	/** The worker partition this broker runs in, bound at load as Table_Node binds it; null outside a worker, which publishes no status. */
	private ?int $bound_partition = null;

	/** The topology this broker runs in, bound at load beside the partition; null outside a worker, whose readers report under no id. */
	private ?string $bound_topology = null;

	/**
	 * The kinds a glob pair has claimed, each with a reader here or a dir under
	 * the offsetlog root; null until a glob first builds after construction or
	 * a replay, which counts both again.
	 *
	 * @var array<string,true>|null
	 */
	private ?array $glob_kinds = null;

	/** Root under which each reader's offsetlog sits, at `<root>/<kind>`. */
	protected string $offsetlog_root = '';

	/** Root under which each reader's dead letters sit, at `<root>/<kind>`. */
	protected string $deadletter_root = '';

	/** Fanned out to every reader, present or built later. */
	protected bool $assume_clean_shutdown = false;

	/** Tachikoma-parity: no-arg ctor. Auto-wire the `{name}:config` interpreter for the verb table. */
	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	/**
	 * Parse `<vault_id> <offsetlog_root> <deadletter_root> <source:target>…`,
	 * arm the recurring tick, then reconcile the readers with a replay.
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
	 * registration: `fill()` relays anything it does not recognize OUT to a
	 * remote spoke, so control dispatched by name would ride the one entry
	 * point whose fall-through is a third party. A closure mints no message,
	 * and its identity is its provenance.
	 *
	 * A reader no pair matches any more hands its cursor off and is
	 * retracted; each survivor takes its owning pair's target, and its dirs
	 * when the roots moved. A changed source list restarts the stream, so the
	 * next request states the new set; a changed target alone does not.
	 *
	 * @api Dynamic entrypoint.
	 * @param list<string>|null $args Positional tokens, or null to read them.
	 * @return list<string>
	 * @throws \InvalidArgumentException When a pair is malformed or none is named.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->bound_partition = Core::bound_partition();
		$pairs                 = $this->owned_pairs( self::variadic_in( $args ) );
		$previous              = $this->pairs;
		$previous_vault        = $this->vault_id;
		$this->parse_schema_args( $args );
		if ( $previous_vault !== $this->vault_id ) {
			$this->drop_patrons();
		}
		$this->set_timer( self::TICK_INTERVAL_MS );
		// Subscribed where the vault config is captured: one lifetime.
		$this->subscribe( Node_Names::FLEET, 'RELOAD', $this->reload( ... ) );
		$this->bound_topology = Core::bound_topology();
		$this->pairs          = $pairs;
		$this->glob_kinds     = null;
		foreach ( $this->readers() as $stamp => $child ) {
			$pair = $this->pair_for( $stamp );
			if ( null === $pair ) {
				$child->hand_off_cursor();
				$this->retract_sibling( Log_Discovery::kind_of( $stamp ) );
				continue;
			}
			$child->connect_node( $pair['target'] );
			if ( $this->reader_args( $stamp ) !== $child->arguments() ) {
				$child->arguments( $this->reader_args( $stamp ) );
			}
			$child->broker( $this );
		}
		// A target names no stream: only a changed source list restreams.
		if ( \array_column( $previous, 'source' ) !== \array_column( $this->pairs, 'source' ) ) {
			$this->restream();
		}
		return $args;
	}

	/**
	 * Inbound message. A command reply (TM_COMMAND|TM_RESPONSE / |TM_ERROR)
	 * routed back from the spoke settles through `settle_reply()`; anything
	 * else is a command to send().
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
		$this->send( $message );
	}

	/**
	 * Each tick: build each exact pair's reader, then hand the subclass its
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
	 * Build the reader of every exact pair; a glob's readers wait for a stamp
	 * the remote names. `consumer_for()` returns a built reader as it is.
	 */
	private function ensure_exact_readers(): void {
		foreach ( $this->pairs as [ 'source' => $source ] ) {
			if ( ! Log_Discovery::is_glob( $source ) ) {
				$this->consumer_for( $source );
			}
		}
	}

	/**
	 * The pairs this worker reads, each with `{partition}` resolved at its
	 * bound partition, and kept where `Core::owns()` holds for its source as
	 * written: a source naming no partition reads once per fleet, and
	 * elsewhere its pair builds no reader, joins no subscription and leaves no
	 * dir (ADR-33). Every pair is checked wherever it is skipped, so a bad one
	 * fails on every partition. Outside a worker a pair naming `{partition}`
	 * is refused, because no partition's log is that process's own.
	 *
	 * @param list<string> $tokens The pair tokens as written.
	 * @return list<array{source:string,target:string}>
	 * @throws \InvalidArgumentException When a pair is malformed, none is
	 *                                   named, or one names `{partition}`
	 *                                   where none is bound.
	 */
	private function owned_pairs( array $tokens ): array {
		if ( [] === $tokens ) {
			throw new \InvalidArgumentException( self::refusal_prefix() . 'name at least one <source>:<target> pair' );
		}
		$owned = [];
		foreach ( $tokens as $token ) {
			if ( null === $this->bound_partition && Core::has_partition_token( $token ) ) {
				// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
				throw new \InvalidArgumentException( self::refusal_prefix() . "pair '{$token}' names " . Core::PARTITION_TOKEN . ', but no partition is bound' );
			}
			$written = self::split_pair( $token );
			$pair    = self::checked_pair(
				Core::resolve_partition_template( $written['source'], $this->bound_partition ?? 0 ),
				Core::resolve_partition_template( $written['target'], $this->bound_partition ?? 0 ),
				$token
			);
			if ( Core::owns( $written['source'], $this->bound_partition ) ) {
				$owned[] = $pair;
			}
		}
		return $owned;
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
	 * The reader for a stamp, built on first sight when a pair claims it; null
	 * when none does. A spoke names the stamps it sends, and a stamp names a
	 * sibling slot and a directory here, so the one builder refuses four,
	 * rate-limited: a stamp outside the stream name grammar, one naming a slot
	 * the broker keeps, one no pair claims, and a glob's past `MAX_READERS`.
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
		if ( ! Log_Discovery::is_stamp( $stamp ) ) {
			$this->print_less_often( 'refusing a stamp outside the stream name grammar' );
			return null;
		}
		if ( self::is_reserved( $stamp ) ) {
			$this->print_less_often( 'refusing a stamp that names a slot the broker keeps' );
			return null;
		}
		$pair = $this->pair_for( $stamp );
		if ( null === $pair ) {
			$this->print_less_often( 'dropping a line no pair claims: ', $stamp );
			return null;
		}
		if ( Log_Discovery::is_glob( $pair['source'] ) && ! $this->claim_glob_kind( Log_Discovery::kind_of( $stamp ) ) ) {
			$this->print_less_often( 'refusing a reader past MAX_READERS: ', (string) self::MAX_READERS );
			return null;
		}
		$child = new Remote_Consumer_Node();
		$this->publish_sibling( Log_Discovery::kind_of( $stamp ), $child );
		$child->sink( $this->sink );
		$child->arguments( $this->reader_args( $stamp ) );
		$child->connect_node( $pair['target'] );
		$child->broker( $this );
		$child->set_assume_clean_shutdown( $this->assume_clean_shutdown );
		$this->http_out?->allow_replies_to( $child->name() );
		return $child;
	}

	/**
	 * The reader a stamp's kind holds in the sibling map, or null; builds
	 * nothing, and a slot holding anything else is no reader.
	 *
	 * @param string $stamp A record's stamp.
	 */
	protected function reader( string $stamp ): ?Remote_Consumer_Node {
		$sibling = $this->siblings()[ Log_Discovery::kind_of( $stamp ) ] ?? null;
		return $sibling instanceof Remote_Consumer_Node ? $sibling : null;
	}

	/**
	 * Claim a kind for a glob pair's reader: free when the kind holds a reader
	 * or a dir already, refused once `MAX_READERS` kinds are claimed. The
	 * first claim, after construction or a replay, counts the glob readers
	 * built here and the kind dirs a glob pair left under the offsetlog root,
	 * so the cap holds across a replay and a restart alike.
	 *
	 * @param string $kind The kind the reader would take.
	 * @return bool True when the reader may be built.
	 */
	private function claim_glob_kind( string $kind ): bool {
		$this->glob_kinds ??= $this->claimed_glob_kinds();
		if ( ! isset( $this->glob_kinds[ $kind ] ) ) {
			if ( \count( $this->glob_kinds ) >= self::MAX_READERS ) {
				return false;
			}
			$this->glob_kinds[ $kind ] = true;
		}
		return true;
	}

	/**
	 * The kinds a glob pair claims, among the readers built here and the kind
	 * dirs under the offsetlog root. A reader with no checkpoint yet has no
	 * dir, so the readers count as well as the disk.
	 *
	 * @return array<string,true>
	 */
	private function claimed_glob_kinds(): array {
		$stamps = \array_keys( $this->readers() );
		foreach ( \glob( "{$this->offsetlog_root}/*", \GLOB_ONLYDIR ) ?: [] as $dir ) {
			$stamps[] = Log_Discovery::stamp_of( \basename( $dir ) );
		}
		$kinds = [];
		foreach ( $stamps as $stamp ) {
			$pair = $this->pair_for( $stamp );
			if ( null !== $pair && Log_Discovery::is_glob( $pair['source'] ) ) {
				$kinds[ Log_Discovery::kind_of( $stamp ) ] = true;
			}
		}
		return $kinds;
	}

	/**
	 * A reader's tokens: its stamp, then its offsetlog and dead-letter dirs,
	 * each nested under the broker's root at the stamp's kind.
	 *
	 * @param string $stamp A record's stamp.
	 * @return list<string>
	 */
	private function reader_args( string $stamp ): array {
		$kind = Log_Discovery::kind_of( $stamp );
		return [ $stamp, "{$this->offsetlog_root}/{$kind}", "{$this->deadletter_root}/{$kind}" ];
	}

	/**
	 * The first pair, in declaration order, whose source is the stamp or a glob
	 * matching it.
	 *
	 * @param string $stamp A record's stamp.
	 * @return array{source:string,target:string}|null
	 */
	protected function pair_for( string $stamp ): ?array {
		foreach ( $this->pairs as $pair ) {
			if ( Log_Discovery::carries( $pair['source'], $stamp ) ) {
				return $pair;
			}
		}
		return null;
	}

	/**
	 * Restart the readers' feed so the next request states the live set
	 * again. A reader calls it when it pauses, plays or seeks, and a replay
	 * when its source list moves.
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
	 * Default send: relay the message out through the patron HTTP_Out.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	protected function send( array $message ): void {
		$this->ensure_channel()?->fill( $message );
	}

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
		// Arms HTTP_Out's wire-inbound clause; a Null, since the broker relays.
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
	 * One tick's housekeeping, after the exact pairs' readers are built: keep
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
		$kind   = Log_Discovery::kind_of( $stamp );
		$reader = null === $this->bound_topology || null === $this->bound_partition
			? ''
			: self::reader_id( $this->bound_topology, $this->name, $kind, $this->bound_partition );
		return [ Log_Discovery::remote_for( $this->vault_id, $stamp ), $reader ];
	}

	/**
	 * The id a broker's reader reports under on the probe log: its node name,
	 * `<broker>:<kind>`, scoped by the topology and spelled as a worker id at
	 * the worker partition the broker runs in, as a stock Consumer's offsetlog
	 * basename `<topology>.<log>.p{partition}` is. Two spokes' `firehose.p0`
	 * readers then key apart, `CLI::consumer_rows()` reads the partition back
	 * through `CLI::parse_worker_id()`, and a stale row of an active topology
	 * keeps its place. Public because `Aggregator_CI` matches the rows of each
	 * broker it reports through it, with the kind `Log_Discovery::remote_of()`
	 * reads off the row's SOURCE; the Workers dashboard's
	 * `reconstructWorkers()` composes it the same way.
	 *
	 * @param string $topology  The topology the broker runs in.
	 * @param string $broker    The broker's name.
	 * @param string $kind      The reader's kind, `Log_Discovery::kind_of()` of its stamp.
	 * @param int    $partition The worker partition the broker runs in.
	 */
	public static function reader_id( string $topology, string $broker, string $kind, int $partition ): string {
		return CLI::worker_id( "{$topology}." . self::sibling_name_of( $broker, $kind ), $partition );
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
	 * Each pair's target, written through that pair's reader rather than a
	 * target of the broker's own, so the canvas and the analyzer draw one edge
	 * per pair. Only a pair `pairs_of()` accepts names one, so the graph shows
	 * no edge for a pair `make_node` refuses, and each target is as written.
	 *
	 * @param list<string> $args The `make_node` argument tokens, the name excluded.
	 * @return list<string>
	 */
	public static function declared_targets( array $args ): array {
		return \array_column( self::pairs_of( self::variadic_in( $args ) ), 'target' );
	}

	/**
	 * Every pair among `$tokens` the runtime would accept, split as written,
	 * for a reader of the topology that must not fail on a line the runtime
	 * would refuse. A token is judged with its `{partition}` and config tokens
	 * resolved, as the broker reads it, and kept with them, as the TSL names
	 * its nodes; a token already resolved reads the same either way.
	 *
	 * @param list<string> $tokens Pair tokens.
	 * @return list<array{source:string,target:string}>
	 */
	public static function pairs_of( array $tokens ): array {
		$pairs = [];
		foreach ( $tokens as $token ) {
			try {
				self::parse_pair( Core::resolve_partition_template( $token, 0 ) );
			} catch ( \InvalidArgumentException $e ) {
				continue;
			}
			$pairs[] = self::split_pair( $token );
		}
		return $pairs;
	}

	/**
	 * Read one `<source>:<target>` token on its FIRST colon: a source never
	 * carries one (a partition dir or `sources/<name>`), a target may
	 * (`php-errors:partition`). A source no spoke could stream is refused
	 * here, at configuration, rather than failing quietly on every connect.
	 *
	 * @param string $token One pair token.
	 * @return array{source:string,target:string}
	 * @throws \InvalidArgumentException When either half is empty, or the source is no subscription.
	 */
	public static function parse_pair( string $token ): array {
		[ 'source' => $source, 'target' => $target ] = self::split_pair( $token );
		return self::checked_pair( $source, $target, $token );
	}

	/**
	 * Refuse a split pair `parse_pair()` would refuse, naming the token as
	 * written.
	 *
	 * @param string $source The source half.
	 * @param string $target The target half.
	 * @param string $token  The token the halves came from.
	 * @return array{source:string,target:string}
	 * @throws \InvalidArgumentException When either half is empty, or the source is no subscription.
	 */
	private static function checked_pair( string $source, string $target, string $token ): array {
		if ( '' === $source || '' === $target ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
			throw new \InvalidArgumentException( self::refusal_prefix() . "a pair is <source>:<target>, got '{$token}'" );
		}
		// An exact source is the stamp of the one stream it carries.
		$glob = Log_Discovery::is_glob( $source );
		if ( ! ( $glob ? Log_Discovery::is_subscription( $source ) : Log_Discovery::is_stamp( $source ) ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
			throw new \InvalidArgumentException( self::refusal_prefix() . "pair names a source no spoke can stream: '{$token}'" );
		}
		if ( ! $glob && self::is_reserved( $source ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
			throw new \InvalidArgumentException( self::refusal_prefix() . "pair's reader names a slot the broker keeps: '{$token}'" );
		}
		return [ 'source' => $source, 'target' => $target ];
	}

	/**
	 * Whether a stamp's reader would take a sibling slot the broker publishes
	 * itself, which `publish_sibling()` refuses.
	 *
	 * @param string $stamp A record's stamp.
	 */
	private static function is_reserved( string $stamp ): bool {
		return \in_array( Log_Discovery::kind_of( $stamp ), self::RESERVED_KINDS, true );
	}

	/** A pair refusal's opening: the shell name of the broker class refusing it. */
	private static function refusal_prefix(): string {
		return Command_Interpreter_Node::shell_name_for( static::class ) . ': ';
	}

	/**
	 * Split a token at its first colon outside `<…>`, so a `<ns:key>` config
	 * token in the source stays whole. A token with no such colon is all
	 * source; this validates nothing, as `parse_pair()` does.
	 *
	 * @param string $token One pair token.
	 * @return array{source:string,target:string}
	 */
	public static function split_pair( string $token ): array {
		$depth = 0;
		foreach ( \str_split( $token ) as $at => $char ) {
			if ( '<' === $char ) {
				++$depth;
			} elseif ( '>' === $char && $depth > 0 ) {
				--$depth;
			} elseif ( ':' === $char && 0 === $depth ) {
				return [
					'source' => \substr( $token, 0, $at ),
					'target' => \substr( $token, $at + 1 ),
				];
			}
		}
		return [ 'source' => $token, 'target' => '' ];
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

	/** Round-trip the toggles after the `make_node` line. */
	public function dump_config(): string {
		return parent::dump_config() . $this->dump_toggles();
	}

	/**
	 * Configuration form: the vault and the two roots each reader's dirs
	 * nest under, then the pairs, and the two verbs that reach every reader.
	 *
	 * @api Dynamic entrypoint.
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'     => 'Hidden',
			// Each pair names its destination, so Node refuses connect_node.
			'has_target'   => false,
			'description'  => 'Broker base: one spoke\'s command channel and a durable reader per `source:target` pair.',
			'arguments'    => [
				[ 'name' => 'vault_id',        'type' => 'vault_id', 'required' => true, 'description' => 'Which spoke to connect to — a Vault-registered server (URL + credentials).' ],
				[ 'name' => 'offsetlog_root',  'type' => 'string',   'required' => true, 'partition' => 'bound', 'description' => 'Directory each reader\'s durable read-cursor offsetlog nests under, at <root>/<kind>. Carry `<topology>` so two fleets pulling one spoke keep separate cursors.' ],
				[ 'name' => 'deadletter_root', 'type' => 'string',   'required' => true, 'partition' => 'bound', 'description' => 'Directory each reader\'s quarantined poison records nest under, at <root>/<kind>.' ],
				[ 'name' => 'pairs', 'type' => 'string', 'required' => true, 'variadic' => true, 'description' => '`<source>:<target>` pairs: a spoke partition, glob or `sources/<name>`, then the node its lines go to.' ],
			],
			'commands'     => [
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
