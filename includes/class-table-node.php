<?php
/**
 * Table
 *
 * The keyed store (Tachikoma Table vocabulary), kept in a Cache_Backend arm
 * the Table names: `auto` (memcached, else APCu, chosen per call), `memcache`,
 * `apcu`, or the durable `sqlite` and `wpdb`. That is the documented
 * divergence: Tachikoma's Table holds windowed in-memory buckets, but this
 * substrate's dashboards, REST handlers and CLI have no efficient way to query
 * a live worker, so values land where ANY process reads them via `lookup()`.
 * TTL replaces the bucket window, and every entry expires: a Table refuses a
 * TTL below one second, so nothing it holds is stored forever.
 *
 * A named backend opens once, when the Table's arguments arrive — at topology
 * load for a `make_node` Table — so a backend that cannot open throws there,
 * naming the Table, rather than inside some request's first write. A `sqlite`
 * Table keeps one file per partition, `{base}/tables/{table}.p{N}.sqlite`,
 * which its worker creates; a mount opens that file read-only and creates
 * nothing, and reads nothing from a partition whose worker has not written.
 *
 * fill() stores KEY→VALUE write-through (the message passes on), so the
 * table composes mid-graph: `… → Table → …`. An INSERT (TM_STRUCT or
 * TM_BYTESTREAM) whose KEY is empty or holds whitespace is refused, neither
 * stored nor forwarded; any other keyless message passes through.
 * `lookup()` / `store()` / `forget()` are the same table reached
 * from outside a graph — a REST handler, wp-admin, a CLI command — and are
 * how a caller stays out of the key convention's business. Nothing about them
 * needs a graph: `Table_Node::table( $ns, $ttl )` builds one anywhere.
 *
 * A BACKING, off until a caller opts in, is the durable system of record a
 * miss falls through to, which makes the table a cache of that record rather
 * than the record itself (ADR-18). See backed_by().
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Table node — `make_node Table <name> <namespace> <ttl> [ auto|memcache|apcu|sqlite|wpdb ]`.
 *
 * @phpstan-import-type Rows from Sqlite_Arm
 */
class Table_Node extends Node {
	use Schema_Reflection;

	/** Every backend a Table may name; `auto` is memcached, else APCu, per call. */
	public const BACKENDS = [ 'auto', 'memcache', 'apcu', 'sqlite', 'wpdb' ];

	/**
	 * Most members one members_of() read answers for a set, or one SMOVE
	 * moves: a ceiling on what one call may cost.
	 */
	public const MAX_MEMBERS_LIMIT = 10000;

	/** The limits SMOVE and members_of() admit, for a refusal to name. */
	private const MEMBERS_LIMIT_RANGE = 'a whole number from 1 to ' . self::MAX_MEMBERS_LIMIT;

	/** Seconds between one Table's purges. */
	public const PURGE_INTERVAL_S = 60;

	/** Rows one purge statement deletes at most. */
	public const PURGE_BATCH_ROWS = 5000;

	/** Seconds one tick's purges may spend, all Tables together, before a batch waits. */
	private const PURGE_BUDGET_S = 0.05;

	/**
	 * Seconds one tick's purges spend, all Tables together, while any Table is
	 * behind, until each comes back short. A 5,000-row SQLite batch cost 7 to
	 * 16 ms on a small local file, but 597 ms on staging's 15.9 M-row file,
	 * where 250 ms buys the one batch every due Table runs anyway: 5,000 rows
	 * a minute against the ~5,300 one partition's aggregate Table in
	 * event-logger-nodes expires, ~4,200 of them search-index members. Whether
	 * the purge keeps pace there is unmeasured; the behind line says when it
	 * does not. The drain loop is held a quarter-second a minute, and only
	 * while behind.
	 */
	public const PURGE_BACKLOG_BUDGET_S = 0.25;

	/**
	 * Seconds between one Table's WAL checkpoints. A checkpoint copies each
	 * page in the WAL back once, however many writes dirtied it since the
	 * last, so a hot page costs one copy an interval rather than one a tick.
	 * Checkpointing every tick, staging's aggregate Table spent 1,686 ms in
	 * 133 checkpoints, 39% of its time, beside 1,879 ms of SADD and 614 ms of
	 * MSET. At its ~630 frames a second, 30 s leaves ~19,000 frames, ~75 MB,
	 * to one checkpoint, and bounds what a crash replays from the WAL. It is
	 * half of PURGE_INTERVAL_S, so every other checkpoint shares a purge tick.
	 */
	public const CHECKPOINT_INTERVAL_S = 30;

	/**
	 * Checkpoints in a row that may leave frames behind, while the WAL grows,
	 * before the Table warns. A PASSIVE checkpoint stops at the oldest open
	 * reader's snapshot, and a reader here is one request's mount, which PHP
	 * ends inside its 30-second max_execution_time. Checkpoints sit
	 * CHECKPOINT_INTERVAL_S apart, so one request straddles two of them at
	 * most; four in a row spans at least 90 seconds, three times what one
	 * request can hold, so it means readers overlapping without a gap, or one
	 * stuck, and the WAL grows until one lets go.
	 */
	public const WAL_STALL_CHECKPOINTS = 4;

	/** Most bytes of a refused verb a log line or its throttle key shows. */
	private const SHOWN_VERB_BYTES = 64;

	/** How a GET request is answered. */
	private const READ_REPLY = 'one message per value found, KEY set: TM_STRUCT for an array, TM_BYTESTREAM (a string) otherwise; then TM_INFO "GET <n>", or one TM_ERROR "GET: backend read failed"';

	/** How a SMOVE request is answered. */
	private const MOVED_REPLY = 'one TM_STRUCT, KEY the from set, VALUE a list of [ member, value ] moved, lowest member first, then TM_INFO "SMOVE 1", or one TM_ERROR "SMOVE: backend write failed"';

	/**
	 * The verbs a mount answers: its declaring worker is the file's one writer
	 * (ADR-6), and a request carries no authority beyond the mount (ADR-23).
	 */
	private const READ_VERBS = [ 'GET' ];

	/** Why a mount refuses any other verb. */
	private const READS_ONLY = 'a mounted Table serves reads only';

	/** How every write request is answered. */
	private const WRITE_REPLY = 'one TM_RESPONSE "<VERB> <keys…>" naming the keys it took effect on';

	/** A verb's calls, in its counter row. */
	private const CALLS = 0;

	/** Keys or rows a verb's calls asked for. */
	private const ASKED = 1;

	/** Keys or rows a verb's calls answered or took effect on. */
	private const ANSWERED = 2;

	/** Encoded bytes a durable arm stored or returned for a verb. */
	private const BYTES = 3;

	/** A verb's nanoseconds on the monotonic clock, all calls together. */
	private const TOTAL_NS = 4;

	/** A verb's longest call, in nanoseconds. */
	private const MAX_NS = 5;

	/** Requests a verb answered with a TM_ERROR. */
	private const ERRORS = 6;

	/** A verb's longest call since the probe last drained, in nanoseconds. */
	private const WINDOW_MAX_NS = 7;

	/** The verbs counted beside the requests: INSERT, members_of()'s SMEMBERS, and the tick's. */
	private const COUNTED = [ 'INSERT', 'SMEMBERS', 'PURGE', 'CHECKPOINT' ];

	/**
	 * Each class's declared requests, read once from its node_schema(): verb
	 * => what a structure must carry, or null for a string verb.
	 *
	 * @var array<string,array<string,string|null>>
	 */
	private static array $requests = [];

	/**
	 * Monotonic-clock seam behind the per-verb timings, replacing
	 * `hrtime( true )`. Tests pin it to set what one verb measures.
	 * Signature: `function (): int`, nanoseconds from an arbitrary origin.
	 *
	 * @var (\Closure(): int)|null
	 */
	public static ?\Closure $hrtime = null;

	/** Key scope. Every entry key derives from it, so changing it orphans the table. */
	private string $namespace = '';

	/** Lifetime in seconds of every write that states none; at least 1. */
	private int $ttl;

	/** The backend this Table names. */
	private string $backend = 'auto';

	/** The arm a named backend opened; null for `auto`, which resolves per call. */
	private ?Cache_Backend $arm = null;

	/** The declared Table this node answers for; its own name unless mounted. */
	private string $table = '';

	/** The partition its file belongs to; the bound partition unless mounted. */
	private ?int $partition = null;

	/** Whether this is a request-graph mount, which serves reads only. */
	private bool $mounted = false;

	/** The tick this Table's next purge is due, in epoch seconds. */
	private int $purge_due = 0;

	/** Whether this Table's last purge stopped with a batch still full. */
	private bool $purge_behind = false;

	/** The tick this Table's next WAL checkpoint is due, in epoch seconds. */
	private int $checkpoint_due = 0;

	/** Consecutive WAL checkpoints that left frames behind. */
	private int $wal_stalled = 0;

	/** WAL frames at the first checkpoint of the current stall. */
	private int $wal_stall_frames = 0;

	/**
	 * Per-verb counters since the node was built or last reset; see stats().
	 *
	 * @var array<string,array{int,int,int,int,int,int,int,int}>
	 */
	private array $verb_stats;

	/**
	 * The counters as the last trace line left them, held only while traced,
	 * carried negative across a reset.
	 *
	 * @var array<string,array{int,int,int,int,int,int,int,int}>|null
	 */
	private ?array $traced = null;

	/**
	 * The counters as the last probe sweep left them, carried negative across
	 * a reset; null before the first sweep.
	 *
	 * @var array<string,array{int,int,int,int,int,int,int,int}>|null
	 */
	private ?array $probed = null;

	/** When the probe's window opened: construction, then each sweep; a reset leaves it. */
	private float $probe_ts = 0.0;

	/** The partition bound when the arguments arrived; null with none bound. */
	private ?int $bound_partition = null;

	/** The SQLite file the arm opened; '' on any other backend. */
	private string $sqlite_path = '';

	/**
	 * Durable system of record behind this table, or null until backed_by()
	 * opts in. Invoked with the keys a read missed on.
	 *
	 * @var (\Closure(list<string>): ?array<array-key,array{value: mixed,ttl?: int}>)|null
	 */
	private ?\Closure $backing = null;

	/**
	 * Wire the sibling `:config` interpreter that serves `stats`, `flush` and `vacuum`.
	 *
	 * Takes no arguments, for Tachikoma parity and because `make_node`
	 * constructs first and calls `arguments()` after (ADR-11) — the namespace
	 * and the TTL arrive there, not here.
	 */
	public function __construct() {
		parent::__construct();
		$this->verb_stats = self::zero_stats();
		$this->probe_ts   = Core::$now;
		$this->auto_wire_interpreter();
	}

	/**
	 * `<namespace> <ttl> [backend]` — namespace is required (it scopes
	 * lookup()); ttl is required, in whole seconds, at least 1, so every entry
	 * expires; backend one of BACKENDS, `auto` by default. Every token is
	 * checked, and a named backend opened, before any field moves, so a
	 * refusal leaves the table as it was.
	 *
	 * Re-calling this moves a live table, which is how a caller carries a
	 * generation: name the table `pyrobase:g47` and a schema bump renames it to
	 * `pyrobase:g48`, orphaning every key at once. That works
	 * because entries are keyed by the derived `key()`, not the bare key.
	 *
	 * @param list<string>|null $args
	 * @return list<string>
	 * @throws \InvalidArgumentException On a namespace that is empty or holds
	 *                                   whitespace, a ttl that is missing or not
	 *                                   a whole number of at least 1, or an
	 *                                   unknown backend.
	 * @throws \RuntimeException On a declaration a named backend refuses.
	 * @throws Table_Unavailable When the backend cannot open on this host,
	 *                           `auto` with neither memcached nor APCu included.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		if ( null === Core::canonical_decimal( $args[1] ?? '', false ) ) {
			$this->refuse_ttl( $args[1] ?? '' );
		}
		$values    = $this->schema_values( $args );
		$namespace = Core::as_string( $values['namespace'] );
		$backend   = Core::as_string( $values['backend'] );
		if ( Cache_Backend::refuses_key( $namespace ) ) {
			throw new \InvalidArgumentException( 'Table requires a non-empty namespace holding no whitespace' );
		}
		if ( ! \in_array( $backend, self::BACKENDS, true ) ) {
			throw new \InvalidArgumentException( \esc_html( 'Table backend must be one of ' . \implode( ', ', self::BACKENDS ) . ", not {$backend}" ) );
		}
		$this->declare_store( $namespace, Core::as_int( $values['ttl'] ), $backend, null );
		$this->arguments = $args;
		return $args;
	}

	/**
	 * Store the message's KEY→VALUE write-through, then pass the message on.
	 *
	 * A TM_REQUEST is answered instead of forwarded: it is a question for this
	 * node, not traffic in transit. An INSERT whose KEY no string request could
	 * name — empty, or holding whitespace — is refused and dropped. Everything
	 * else stores when it carries a KEY and forwards either way, so a table
	 * splices into a live path without diverting it. An empty VALUE deletes the
	 * entry rather than storing an empty one.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 * @throws \RuntimeException With no wired sink to forward through.
	 */
	public function fill( array $message ): void {
		$type = Core::num_int( $message[ Message::TYPE ] );
		if ( 0 !== ( $type & Message::TM_REQUEST ) ) {
			$this->handle_request( $message );
			return;
		}
		$key = Core::as_string( $message[ Message::KEY ], '' );
		if ( $this->mounted && '' !== $key ) {
			$this->print_less_often( 'ERROR: refused an INSERT through a mounted Table - from: ', Core::as_string( $message[ Message::FROM ], '' ) );
			return;
		}
		if ( 0 !== ( $type & ( Message::TM_STRUCT | Message::TM_BYTESTREAM ) ) && Cache_Backend::refuses_key( $key ) ) {
			$this->print_less_often( 'ERROR: refused an INSERT whose KEY is empty or holds whitespace' );
			return;
		}
		if ( '' !== $key ) {
			$this->insert( $key, $message[ Message::VALUE ] );
		}
		parent::fill( $message );
	}

	/**
	 * Open the store a declaration names and take it on: the arm first, so a
	 * backend that will not open leaves the Table as it was, then its scope.
	 * `$rows` declares a Row_Schema's tables in a `sqlite` file.
	 *
	 * @param string    $namespace The namespace keys derive from.
	 * @param int|null  $ttl       Lifetime of a write stating none, at least 1;
	 *                             null beside `$rows`, a store with no keyed write.
	 * @param string    $backend   One of BACKENDS.
	 * @param Rows|null $rows      The row tables, or none.
	 * @throws \RuntimeException On a declaration the backend refuses.
	 * @throws Table_Unavailable When the backend cannot open on this host.
	 */
	protected function declare_store( string $namespace, ?int $ttl, string $backend, ?array $rows ): void {
		$this->bound_partition = Core::bound_partition();
		$file                  = 'sqlite' === $backend ? $this->sqlite_file() : '';
		$arm                   = $this->open( $backend, $namespace, $file, $rows );
		$this->namespace       = $namespace;
		if ( null !== $ttl ) {
			$this->ttl = $ttl;
		}
		$this->backend         = $backend;
		$this->arm             = $arm;
		$this->sqlite_path     = $file;
	}

	/**
	 * INSERT: store the value under its key, or delete the entry when the
	 * value is empty, counted as one key asked.
	 *
	 * @param string $key   The message's KEY.
	 * @param mixed  $value The message's VALUE.
	 */
	private function insert( string $key, mixed $value ): void {
		$started = self::monotonic_ns();
		$bytes   = $this->arm_bytes();
		try {
			// Empty deletes (Table.pm:313); a bare terminator counts as empty.
			$empty  = null === $value || [] === $value
				|| ( \is_string( $value ) && '' === \rtrim( $value, "\r\n" ) );
			$landed = $empty ? $this->forget( $key ) : $this->store( $key, $value );
			$this->count_rows( 'INSERT', 1, true === $landed ? 1 : 0 );
		} finally {
			$this->count_call( 'INSERT', $started, $bytes );
		}
	}

	/**
	 * The arm a named backend opens, once: a Table whose backend cannot open
	 * throws when its arguments arrive, naming itself. Resolving the `sqlite`
	 * file, and an arm refusing an invalid argument, are the declaration's
	 * fault; any other refusal while an arm opens is the host's.
	 *
	 * @param string    $backend   One of BACKENDS.
	 * @param string    $namespace The namespace a `wpdb` arm scopes its rows by.
	 * @param string    $file      The `sqlite` file `sqlite_file()` resolved; '' otherwise.
	 * @param Rows|null $rows      The row tables a `sqlite` file declares, or none.
	 * @return Cache_Backend|null The arm; null for `auto`, which resolves per call.
	 * @throws \RuntimeException On a namespace the arm cannot hold.
	 * @throws Table_Unavailable When the backend cannot open on this host.
	 */
	private function open( string $backend, string $namespace, string $file, ?array $rows ): ?Cache_Backend {
		try {
			// arguments() admits BACKENDS alone, so the default arm is `auto`.
			return match ( $backend ) {
				'memcache' => Cache_Backend::memcache_arm() ?? throw new \LogicException( 'memcache backend has no memcached handle' ),
				'apcu'     => Cache_Backend::apcu_arm() ?? throw new \LogicException( 'apcu backend is not usable here' ),
				'sqlite'   => new Sqlite_Arm( $file, $namespace, read_only: $this->mounted, rows: $rows ),
				'wpdb'     => new Wpdb_Arm( $namespace ),
				default    => null === Cache_Backend::shared_first() ? throw new \LogicException( 'auto backend finds neither memcached nor APCu' ) : null,
			};
		} catch ( Worker_Should_Stop $stop ) {
			throw $stop;
		} catch ( \InvalidArgumentException $e ) {
			throw new \RuntimeException( $this->refusal( $e ), 0, $e );
		} catch ( \RuntimeException | \LogicException $e ) {
			throw new Table_Unavailable( $this->refusal( $e ), 0, $e );
		}
	}

	/**
	 * The `sqlite` file this Table opens, its directory resolved through
	 * `ensure_path()`, so a base or `{base}/tables` that is unusable refuses
	 * the declaration before any arm opens. A mount creates nothing: it adopts
	 * a directory that is there, and with none the mount reads as empty. A
	 * mount refuses a process running as root, which is the operator's to fix
	 * as a foreign `{base}/tables` is: SQLite can add `-wal` and `-shm` files
	 * beside a WAL database, and root's would lock its worker out.
	 *
	 * @return string The file.
	 * @throws \RuntimeException On a base directory or `{base}/tables` that
	 *                           will not resolve, a name that cannot name a
	 *                           file, no bound partition, or a mount as root.
	 */
	private function sqlite_file(): string {
		try {
			$file = self::file( $this->table_name(), $this->file_partition() );
			if ( $this->mounted ) {
				Sqlite_Arm::refuse_root_reader( $file );
			}
			if ( ! $this->mounted || \is_dir( \dirname( $file ) ) ) {
				Config::ensure_path( \dirname( $file ) );
			}
			return $file;
		} catch ( Worker_Should_Stop $stop ) {
			throw $stop;
		} catch ( \RuntimeException | \LogicException $e ) {
			throw new \RuntimeException( $this->refusal( $e ), 0, $e );
		}
	}

	/**
	 * A refusal's message, naming this Table, escaped once.
	 *
	 * @param \Throwable $e What refused.
	 * @return string `Table <name>: <why>`.
	 */
	private function refusal( \Throwable $e ): string {
		return \esc_html( "Table {$this->table_name()}: " . $e->getMessage() );
	}

	/**
	 * Answer one request, TO its FROM, FROM this Table, its ID echoed (ADR-7).
	 * Reads send a message per value and a TM_INFO count, or one TM_ERROR when
	 * a key went unread, so a failure never reads as absence. Writes send one
	 * string TM_RESPONSE naming the keys they took effect on. ADD and SADD
	 * alone carry a structure, under TM_REQUEST|TM_STRUCT. Anything else
	 * the Table cannot answer is refused out loud, through refuse().
	 *
	 * @param array<int,mixed> $request The TM_REQUEST.
	 * @throws \RuntimeException With no wired sink to reply through.
	 */
	private function handle_request( array $request ): void {
		++$this->counter;
		$value   = $request[ Message::VALUE ];
		$words   = \is_array( $value ) ? [] : ( \preg_split( '/\s+/', \trim( Core::as_string( $value, '' ) ), -1, \PREG_SPLIT_NO_EMPTY ) ?: [] );
		$verb    = \is_array( $value ) ? Core::as_string( \array_key_first( $value ), '' ) : (string) \array_shift( $words );
		$started = self::monotonic_ns();
		$bytes   = $this->arm_bytes();
		try {
			$this->answer_verb( $request, $verb, $words );
		} finally {
			$this->count_call( $verb, $started, $bytes );
		}
	}

	/**
	 * Answer one request's verb: a mount refuses any write, a structure goes
	 * to handle_struct(), a string verb this class does not declare is
	 * refused, and a declared one goes to its reply.
	 *
	 * @param array<int,mixed> $request The TM_REQUEST.
	 * @param string           $verb    The verb: the first word, or the map's key.
	 * @param list<string>     $words   A string request's words after the verb.
	 * @throws \RuntimeException With no wired sink to reply through.
	 */
	private function answer_verb( array $request, string $verb, array $words ): void {
		$value  = $request[ Message::VALUE ];
		$struct = 0 !== ( Core::num_int( $request[ Message::TYPE ] ) & Message::TM_STRUCT );
		if ( $this->mounted && ( \is_array( $value ) || ! \in_array( $verb, self::READ_VERBS, true ) ) ) {
			$this->refuse( $request, $verb, self::READS_ONLY );
			return;
		}
		if ( \is_array( $value ) ) {
			$this->handle_struct( $request, $verb, $value, $struct );
			return;
		}
		if ( $struct ) {
			$this->refuse( $request, $verb, 'a string request carries no TM_STRUCT bit' );
			return;
		}
		if ( ! \array_key_exists( $verb, self::requests() ) ) {
			$this->refuse( $request, $verb, 'unknown verb' );
			return;
		}
		match ( $verb ) {
			'GET'   => $this->reply_value( $request, $words ),
			'SMOVE' => $this->reply_moved( $request, $words ),
			'SREM'  => $this->reply_unmembered( $request, $words ),
			'RM'    => $this->reply_removed( $request, $words ),
			default => $this->refuse( $request, $verb, self::requests()[ $verb ] ?? 'declared but not answered' ),
		};
	}

	/**
	 * A structured request: one verb this class declares a `struct` value
	 * for, naming what it carries, under the TM_STRUCT bit, answered by
	 * answer_struct().
	 *
	 * @param array<int,mixed>       $request The TM_REQUEST.
	 * @param string                 $verb    The map's one key.
	 * @param array<array-key,mixed> $value   The request's VALUE.
	 * @param bool                   $struct  Whether TYPE carries TM_STRUCT.
	 * @throws \RuntimeException With no wired sink to reply through.
	 */
	private function handle_struct( array $request, string $verb, array $value, bool $struct ): void {
		$items = $value[ $verb ] ?? null;
		$usage = \array_filter( self::requests(), static fn ( ?string $carries ): bool => null !== $carries );
		$verbs = \array_keys( $usage );
		$fault = match ( true ) {
			! $struct                    => 'a structured request needs the TM_STRUCT bit',
			1 !== \count( $value )       => 'a structured request names one verb',
			! isset( $usage[ $verb ] )   => 1 === \count( $verbs ) ? "only {$verbs[0]} takes a structure" : 'only ' . \implode( ', ', \array_slice( $verbs, 0, -1 ) ) . ' and ' . \end( $verbs ) . ' take a structure',
			! \is_array( $items )        => $usage[ $verb ],
			default                      => null,
		};
		if ( null !== $fault ) {
			$this->refuse( $request, $verb, $fault );
			return;
		}
		$this->answer_struct( $request, $verb, Core::arr( $items ) );
	}

	/**
	 * `ADD`/`SADD`: a map of key => [ value, ttl ]; a SADD value is its set's
	 * member map.
	 *
	 * @param array<int,mixed>       $request The TM_REQUEST.
	 * @param string                 $verb    A structured verb this class declares.
	 * @param array<array-key,mixed> $items   What the verb carries.
	 * @throws \RuntimeException With no wired sink to reply through.
	 */
	protected function answer_struct( array $request, string $verb, array $items ): void {
		if ( 'SADD' === $verb ) {
			$this->reply_added( $request, $items );
			return;
		}
		$landed = $this->add_items( $items );
		$this->count_rows( $verb, \count( $items ), \count( $landed ) );
		$this->reply_written( $request, $verb, $landed );
	}

	/**
	 * `SADD`: each set's members under the set's TTL, or the Table's, answered
	 * with the set keys that landed. Only a durable backend holds members, so
	 * any other refuses the request, naming the Table and its backend.
	 *
	 * @param array<int,mixed>       $request The TM_REQUEST.
	 * @param array<array-key,mixed> $items   Set key => [ [ member => value, … ], ttl? ].
	 * @throws \RuntimeException With no wired sink to reply through.
	 */
	private function reply_added( array $request, array $items ): void {
		if ( ! $this->arm instanceof Durable_Arm ) {
			$this->refuse( $request, 'SADD', $this->needs_durable() );
			return;
		}
		$this->reply_written( $request, 'SADD', $this->add_sets( $this->arm, $items ) );
	}

	/**
	 * `SADD` for a caller outside a graph: each set's members under its own
	 * TTL, or the Table's, down the path the request takes.
	 *
	 * @api Non-graph writers indexing entries, a command session's labels among them.
	 * @param array<array-key,mixed> $sets Set key => [ [ member => value, … ], ttl? ].
	 * @return list<string> The set keys that landed.
	 * @throws \RuntimeException On a volatile backend, which holds no members.
	 */
	public function add_members( array $sets ): array {
		return $this->add_sets( $this->durable( 'add_members' ), $sets );
	}

	/**
	 * Every well-formed set in one arm call; an item TTL below one second, or
	 * a value that is no member map, leaves the set out. A failed call is
	 * re-sent set by set, except on an arm whose call lands whole or not at
	 * all. SADD counts member rows, not sets.
	 *
	 * @param Durable_Arm            $arm   The Table's arm.
	 * @param array<array-key,mixed> $items Set key => [ [ member => value, … ], ttl? ].
	 * @return list<string> The set keys that landed.
	 */
	private function add_sets( Durable_Arm $arm, array $items ): array {
		$sets  = [];
		$names = [];
		foreach ( $items as $set_key => $item ) {
			$item = Core::arr( $item );
			$ttl  = $this->item_ttl( $item );
			if ( Cache_Backend::refuses_key( (string) $set_key ) || ! \is_array( $item[0] ?? null ) || null === $ttl ) {
				$this->print_less_often( 'ERROR: refused a set: ', (string) $set_key, ' needs a KEY without whitespace, a member map, and a ttl in whole seconds, at least 1' );
				continue;
			}
			$entry           = $this->key( (string) $set_key );
			$sets[ $entry ]  = [ $item[0], $ttl ];
			$names[ $entry ] = (string) $set_key;
		}
		if ( $arm->add_members( $sets ) ) {
			$landed = $names;
		} elseif ( $arm->batch_is_atomic() ) {
			$landed = [];
		} else {
			$landed = \array_filter( $names, static fn ( string $entry ): bool => $arm->add_members( [ $entry => $sets[ $entry ] ] ), \ARRAY_FILTER_USE_KEY );
		}
		$this->count_rows( 'SADD', self::member_rows( $sets ), self::member_rows( \array_intersect_key( $sets, $landed ) ) );
		return \array_values( $landed );
	}

	/**
	 * How many member rows some sets carry.
	 *
	 * @param array<array-key,array{0: array<array-key,mixed>, 1: int}> $sets Entry key => [ members, ttl ].
	 * @return int Rows.
	 */
	private static function member_rows( array $sets ): int {
		$rows = 0;
		foreach ( $sets as [ $members ] ) {
			$rows += \count( $members );
		}
		return $rows;
	}

	/**
	 * `SMOVE <count> <from_set> <to_set>`: move up to count members, lowest
	 * first, and answer them as one TM_STRUCT keyed by the from set, a list
	 * of `[ member, value ]` pairs, then the count of value messages sent. A count that is not a whole number from 1 to
	 * MAX_MEMBERS_LIMIT is refused, and so are a move naming one set twice
	 * and a backend that is not durable; a failed write answers one error.
	 * Counted as SMOVE: the members asked for, the members moved.
	 *
	 * @param array<int,mixed> $request The TM_REQUEST.
	 * @param list<string>     $words   Count, from set, to set.
	 * @throws \RuntimeException With no wired sink to reply through.
	 */
	private function reply_moved( array $request, array $words ): void {
		$count = Core::canonical_decimal( $words[0] ?? '', false );
		$from  = $words[1] ?? '';
		$to    = $words[2] ?? '';
		if ( null === $count || $count > self::MAX_MEMBERS_LIMIT || '' === $from || '' === $to ) {
			$this->refuse( $request, 'SMOVE', 'usage: SMOVE <count> <from_set> <to_set>, count ' . self::MEMBERS_LIMIT_RANGE );
			return;
		}
		if ( $from === $to ) {
			$this->refuse( $request, 'SMOVE', 'from_set and to_set must differ' );
			return;
		}
		if ( ! $this->arm instanceof Durable_Arm ) {
			$this->refuse( $request, 'SMOVE', $this->needs_durable() );
			return;
		}
		$moved = $this->arm->move_members( $this->key( $from ), $this->key( $to ), $count );
		if ( false === $moved ) {
			$this->count_error( 'SMOVE' );
			$this->reply( $request, Message::TM_ERROR, '', "SMOVE: backend write failed\n" );
			return;
		}
		$this->count_rows( 'SMOVE', $count, \count( $moved ) );
		$this->reply( $request, Message::TM_STRUCT, $from, self::member_pairs( $moved ) );
		$this->reply( $request, Message::TM_INFO, '', "SMOVE 1\n" );
	}

	/**
	 * A set's members as the `[ member, value ]` pairs a TM_STRUCT answer
	 * carries, in the order given.
	 *
	 * @param array<array-key,mixed> $members Member => value.
	 * @return list<array{0: string, 1: mixed}>
	 */
	private static function member_pairs( array $members ): array {
		$pairs = [];
		foreach ( $members as $member => $stored ) {
			$pairs[] = [ (string) $member, $stored ];
		}
		return $pairs;
	}

	/**
	 * `SREM <set_key> <member>…`: the members that were there to delete.
	 *
	 * @param array<int,mixed> $request The TM_REQUEST.
	 * @param list<string>     $words   Set key, then members.
	 * @throws \RuntimeException With no wired sink to reply through.
	 */
	private function reply_unmembered( array $request, array $words ): void {
		$set_key = (string) \array_shift( $words );
		$members = \array_values( \array_unique( $words ) );
		if ( '' === $set_key || [] === $members ) {
			$this->refuse( $request, 'SREM', 'usage: SREM <set_key> <member>…' );
			return;
		}
		if ( ! $this->arm instanceof Durable_Arm ) {
			$this->refuse( $request, 'SREM', $this->needs_durable() );
			return;
		}
		$removed = $this->arm->remove_members( $this->key( $set_key ), $members );
		if ( false === $removed ) {
			$this->count_error( 'SREM' );
			$this->reply( $request, Message::TM_ERROR, '', "SREM: backend write failed\n" );
			return;
		}
		$this->count_rows( 'SREM', \count( $members ), \count( $removed ) );
		$this->reply_written( $request, 'SREM', $removed );
	}

	/**
	 * Each set's live members in member order for a caller outside a graph,
	 * or null for a set holding more than `$limit`; a set with no live member
	 * is absent. Counted as SMEMBERS: the set keys asked, the members answered.
	 *
	 * @api Non-graph readers of an index, the command-session listing among them.
	 * @param list<string> $set_keys Set keys.
	 * @param int          $limit    Most members a set may hold and be answered,
	 *                               from 1 to MAX_MEMBERS_LIMIT.
	 * @return array<array-key,array<array-key,mixed>|null>|null Set key => member
	 *         => value; null when the store did not answer, which `last_failure()`
	 *         names.
	 * @throws \InvalidArgumentException On a limit outside 1 to MAX_MEMBERS_LIMIT.
	 * @throws \RuntimeException On a volatile backend, which holds no members.
	 */
	public function members_of( array $set_keys, int $limit ): ?array {
		$arm = $this->durable( 'members_of' );
		if ( $limit < 1 || $limit > self::MAX_MEMBERS_LIMIT ) {
			throw new \InvalidArgumentException( 'members_of: limit ' . self::MEMBERS_LIMIT_RANGE );
		}
		$found = $this->by_caller_key( $set_keys, static fn ( array $entry_keys ): array|false => $arm->members( $entry_keys, $limit ) );
		$this->count_rows( 'SMEMBERS', \count( $set_keys ), false === $found ? 0 : \array_sum( \array_map( static fn ( ?array $members ): int => \count( $members ?? [] ), $found ) ) );
		return false === $found ? null : $found;
	}

	/**
	 * `GET <key>`: what the store holds for the key, one message when it holds
	 * one, then the count. An array answers TM_STRUCT; anything else answers
	 * its string under TM_BYTESTREAM. A request naming no key, or more than
	 * one, is refused.
	 *
	 * A read failed only when the key went unread: the cache did not answer and
	 * no backing looked. It answers one error instead.
	 *
	 * @param array<int,mixed> $request The TM_REQUEST.
	 * @param list<string>     $words   The key.
	 */
	private function reply_value( array $request, array $words ): void {
		if ( 1 !== \count( $words ) ) {
			$this->refuse( $request, 'GET', 'usage: GET <key>' );
			return;
		}
		$read = $this->read_one( $words[0] );
		$this->count_rows( 'GET', 1, $read['found'] ? 1 : 0 );
		if ( $read['failed'] ) {
			$this->count_error( 'GET' );
			$this->reply( $request, Message::TM_ERROR, '', "GET: backend read failed\n" );
			return;
		}
		if ( $read['found'] ) {
			$stored = $read['value'];
			if ( \is_array( $stored ) ) {
				$this->reply( $request, Message::TM_STRUCT, $words[0], $stored );
			} else {
				$this->reply( $request, Message::TM_BYTESTREAM, $words[0], Core::as_string( $stored, '' ) );
			}
		}
		$this->reply( $request, Message::TM_INFO, '', 'GET ' . ( $read['found'] ? 1 : 0 ) . "\n" );
	}

	/**
	 * `RM <keys…>`: the keys that were there to delete, in request order,
	 * the whole batch in one `delete_multi()` call.
	 *
	 * @param array<int,mixed> $request The TM_REQUEST.
	 * @param list<string>     $words   Keys.
	 * @throws \RuntimeException With no wired sink to reply through.
	 */
	private function reply_removed( array $request, array $words ): void {
		$words   = \array_values( \array_unique( $words ) );
		$arm     = $this->arm();
		$removed = [];
		if ( null !== $arm ) {
			$keys    = \array_map( $this->key( ... ), $words );
			$removed = \array_values( \array_intersect_key( $words, \array_intersect( $keys, $arm->delete_multi( $keys ) ) ) );
		}
		$this->count_rows( 'RM', \count( $words ), \count( $removed ) );
		$this->reply_written( $request, 'RM', $removed );
	}

	/**
	 * A write's reply: the verb and the keys it took effect on.
	 *
	 * @param array<int,mixed> $request The TM_REQUEST.
	 * @param string           $verb    The verb answered.
	 * @param list<string>     $keys    Keys.
	 */
	protected function reply_written( array $request, string $verb, array $keys ): void {
		$this->reply( $request, Message::TM_RESPONSE, '', \rtrim( $verb . ' ' . \implode( ' ', $keys ) ) . "\n" );
	}

	/**
	 * Refuse a request out loud: a TM_ERROR `<VERB>: <why>` to its asker, and
	 * a log line naming the asker, as Tachikoma's Table.pm logs a bad request,
	 * rate-limited per verb. The verb shows its first SHOWN_VERB_BYTES, and an
	 * empty one shows as `(empty)`.
	 *
	 * @param array<int,mixed> $request The TM_REQUEST.
	 * @param string           $verb    The verb refused.
	 * @param string           $why     Why.
	 * @throws \RuntimeException With no wired sink to reply through.
	 */
	protected function refuse( array $request, string $verb, string $why ): void {
		$shown = '' === $verb ? '(empty)' : \substr( $verb, 0, self::SHOWN_VERB_BYTES );
		$this->count_error( $verb );
		$this->print_less_often( "ERROR: bad request: {$shown}", ": {$why} - from: ", Core::as_string( $request[ Message::FROM ], '' ) );
		$this->reply( $request, Message::TM_ERROR, '', "{$shown}: {$why}\n" );
	}

	/**
	 * One reply, TO the request's FROM, FROM this Table, its ID echoed.
	 *
	 * @param array<int,mixed> $request The TM_REQUEST.
	 * @param int              $type    The reply's TYPE.
	 * @param string           $key     The reply's KEY.
	 * @param mixed            $value   The reply's VALUE.
	 * @throws \RuntimeException With no wired sink to reply through.
	 */
	protected function reply( array $request, int $type, string $key, mixed $value ): void {
		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = $type;
		$reply[ Message::FROM ]  = $this->name;
		$reply[ Message::TO ]    = Core::as_string( $request[ Message::FROM ], '' );
		$reply[ Message::ID ]    = $request[ Message::ID ];
		$reply[ Message::KEY ]   = $key;
		$reply[ Message::VALUE ] = $value;
		$this->require_sink()->fill( $reply );
	}

	/**
	 * Cross-process write — the mirror of lookup(), and the same divergence.
	 *
	 * `fill()` is the graph's way in, but the processes that own a table's
	 * contents are not always in a graph: a ruleset saved from wp-admin, a
	 * REST handler, a CLI command. Without this they each resolve the Table's
	 * arm and build the stored key by hand, which puts the key
	 * convention and the backend choice in every caller.
	 *
	 * Fails soft when no backend answers, as every read here does. The TTL
	 * is the table's, not the call's — one table, one lifetime.
	 *
	 * @api Non-graph writers store table values without a live worker.
	 * @param string $key   Key within the table's namespace.
	 * @param mixed  $value Value to store.
	 * @return bool True when the backend accepted the write. A caller that
	 *              shadows its writes durably must not record a refused one.
	 */
	public function store( string $key, mixed $value ): bool {
		$entry_key = $this->key( $key );
		return true === $this->arm()?->set( $entry_key, $value, $this->ttl );
	}

	/**
	 * Store an entry only where its key holds no live one, under a lifetime of
	 * its own — ADR-18's one parameter, for a caller whose entries each live
	 * as long as the thing they record. The same path the `ADD` request takes.
	 *
	 * @api Non-graph writers claiming a key, a command session's mint among them.
	 * @param string $key   Key within the table's namespace.
	 * @param mixed  $value Value to store.
	 * @param int    $ttl   The entry's lifetime in seconds, at least 1.
	 * @return bool True when the entry was stored; false when a live one held
	 *              the key or the backend refused, which `last_failure()` names.
	 * @throws \InvalidArgumentException On a TTL below one second.
	 */
	public function add( string $key, mixed $value, int $ttl ): bool {
		if ( $ttl < 1 ) {
			$this->refuse_ttl( (string) $ttl );
		}
		return [] !== $this->add_items( [ $key => [ $value, $ttl ] ] );
	}

	/**
	 * `ADD`: each item under its own TTL, or the Table's, only where its key
	 * holds no live entry; an item TTL below one second leaves the item out.
	 *
	 * @param array<array-key,mixed> $items Key => [ value, ttl? ].
	 * @return list<string> The keys added.
	 */
	private function add_items( array $items ): array {
		$arm = $this->arm();
		if ( null === $arm ) {
			return [];
		}
		$landed = [];
		foreach ( $items as $key => $item ) {
			$item = Core::arr( $item );
			$ttl  = $this->item_ttl( $item );
			if ( Cache_Backend::refuses_key( (string) $key ) || ! \array_key_exists( 0, $item ) || null === $ttl ) {
				$this->print_less_often( 'ERROR: refused a write item: ', (string) $key, ' needs a KEY without whitespace, a value, and a ttl in whole seconds, at least 1' );
				continue;
			}
			if ( $arm->add( $this->key( (string) $key ), $item[0], $ttl ) ) {
				$landed[] = (string) $key;
			}
		}
		return $landed;
	}

	/**
	 * A write item's TTL: its own when it states one, the Table's otherwise.
	 *
	 * @param array<array-key,mixed> $item [ value, ttl? ].
	 * @return int|null The TTL, or null when the stated one is not whole
	 *                  seconds, at least 1.
	 */
	private function item_ttl( array $item ): ?int {
		return null !== ( $item[1] ?? null ) ? Core::canonical_decimal( $item[1], false ) : $this->ttl;
	}

	/**
	 * Why this Table's backend last refused, for a caller turning a false or
	 * a null into a message.
	 *
	 * @api Callers reporting a refused add() or lookup_entries().
	 * @return string The arm's failure record, naming its store.
	 */
	public function last_failure(): string {
		return $this->arm()?->last_failure() ?? "{$this->table_name()} has no backend";
	}

	/**
	 * Cross-process read: the whole point of keeping entries outside the worker.
	 *
	 * Only a HIT answers from the Table's arm. A miss, an expiry and a broken
	 * arm all fall through to the durable backing when one is installed; with
	 * none, an absent key stays absent, so a caller polling for one it expects
	 * sees it as soon as the arm does. A miss is never remembered, so every one
	 * reaches the backing.
	 *
	 * @api Dashboards / REST / CLI read table values without a live worker.
	 * @param string $key Key within the table's namespace.
	 * @return mixed The stored VALUE, or null when no tier holds it — a host with
	 *               no cache backend at all included.
	 */
	public function lookup( string $key ): mixed {
		return $this->read_one( $key )['value'];
	}

	/**
	 * One key's read: a HIT answers from the arm, and anything else falls
	 * through to the backing. It failed when the arm did not answer, none
	 * selected or READ_ERROR, and no backing looked, so `GET` tells a broken
	 * read from an absent key; a READ_ERROR is logged, since null reads as
	 * "empty table" downstream.
	 *
	 * @param string $key Key within the table's namespace.
	 * @return array{found: bool, value: mixed, failed: bool} The value, null
	 *         when none was found.
	 */
	private function read_one( string $key ): array {
		$backend = $this->arm();
		$status  = null;
		if ( null !== $backend ) {
			// read() reports hit, miss and error; a null value alone cannot.
			$read   = $backend->read( $this->key( $key ) );
			$status = $read['status'];
			if ( Cache_Backend::READ_HIT === $status ) {
				return [ 'found' => true, 'value' => $read['value'], 'failed' => false ];
			}
			if ( Cache_Backend::READ_ERROR === $status ) {
				Core::print_less_often( 'Table: backend read error for ', "{$this->namespace}:{$key}: ", $backend->last_failure() );
			}
		}
		$got = $this->read_through( [ $key ], $answered );
		return [
			'found'  => \array_key_exists( $key, $got ),
			'value'  => $got[ $key ] ?? null,
			'failed' => ( null === $backend || Cache_Backend::READ_ERROR === $status ) && ! $answered,
		];
	}

	/**
	 * Fill missed keys from the durable backing and store each, so the next
	 * read hits the table instead of the system of record. A table with no
	 * backing recovers nothing, which is what makes a miss stay a miss.
	 *
	 * An entry may carry its OWN remaining lifetime, which is what it is warmed
	 * for. That does not reopen the table's "one table, one lifetime" rule,
	 * which governs what a CALLER stores: a backing is re-materializing an entry
	 * that already had a life, and giving it a fresh full TTL would extend what
	 * it is restoring.
	 *
	 * A SPENT remainder is SERVED and not warmed (ADR-18). A stated `ttl` bounds
	 * the CACHE and decays from the WRITE, which says nothing about how long the
	 * record is still READ — refusing one made an evicted hourly URL index
	 * unrecoverable from the fine buckets it derives from, with the data on disk
	 * the whole time. So it costs the entry its cache slot, not the read, and
	 * what a re-materialized entry is warmed for is the BACKING's to state.
	 *
	 * A key the backing did not return writes nothing, so the next read of it
	 * asks the backing again. A backing that answers NULL could not look — out
	 * of budget, its record not there yet — and reads as a miss for every key.
	 *
	 * @param list<string> $keys     Keys that missed.
	 * @param ?bool        $answered Set true when a backing looked, false when
	 *                               none is installed or it could not look.
	 * @param-out bool     $answered
	 * @return array<string,mixed> Values recovered, under the caller's keys.
	 */
	private function read_through( array $keys, ?bool &$answered = null ): array {
		$answered = false;
		if ( [] === $keys || null === $this->backing ) {
			return [];
		}
		$got = ( $this->backing )( $keys );
		if ( null === $got ) {
			return [];
		}
		$answered = true;
		$out = [];
		foreach ( $got as $key => $entry ) {
			$out[ (string) $key ] = $entry['value'];
		}
		// Best-effort: a dead backend must not turn a read into a miss.
		$this->warm( $got );
		return $out;
	}

	/**
	 * Each live entry among `$keys` with the life it has left, in one read of
	 * a durable backend: the `{ value, ttl? }` a backing answers (ADR-18), so
	 * one copy of an entry's expiry, the store's, answers every reader. A key
	 * no live entry holds is absent; nothing falls through to a backing.
	 *
	 * @api Readers whose entry's remaining life is part of the answer.
	 * @param list<string> $keys Keys within the table's namespace.
	 * @return array<array-key,array{value: mixed, ttl?: int}>|null Caller's key
	 *         => entry, an all-digit key an int; null when the store did not
	 *         answer, which `last_failure()` names.
	 * @throws \RuntimeException On a volatile backend, which keeps no expiry
	 *                           it can read back.
	 */
	public function lookup_entries( array $keys ): ?array {
		$arm   = $this->durable( 'lookup_entries' );
		$found = $this->by_caller_key( $keys, static fn ( array $entry_keys ): array|false => $arm->read_entries( $entry_keys ) );
		return false === $found ? null : $found;
	}

	/**
	 * Read under the stored keys, answer under the caller's: `$read` takes the
	 * keys as this Table stores them and returns what it found by those.
	 *
	 * @template T
	 * @param list<string>                                        $keys Keys within the table's namespace.
	 * @param \Closure(list<string>): (array<array-key,T>|false) $read The read, by stored key.
	 * @return array<array-key,T>|false What was found, by the caller's key;
	 *                                  false when the read failed.
	 */
	private function by_caller_key( array $keys, \Closure $read ): array|false {
		$entry_keys = [];
		foreach ( $keys as $key ) {
			$entry_keys[ $this->key( $key ) ] = $key;
		}
		$fetched = $read( \array_map( 'strval', \array_keys( $entry_keys ) ) );
		if ( false === $fetched ) {
			return false;
		}
		$found = [];
		foreach ( $fetched as $entry_key => $value ) {
			$found[ $entry_keys[ $entry_key ] ] = $value;
		}
		return $found;
	}

	/**
	 * Delete up to `$limit` expired rows now, counted as one PURGE: how a
	 * durable Table no worker's tick reaches reclaims its rows, as a command
	 * session's mint does for the sessions it outlives.
	 *
	 * @api Code-built durable Tables, which no Router tick purges.
	 * @param int $limit Most rows to delete.
	 * @return int Rows deleted; 0 when the store refused, which is logged.
	 * @throws \RuntimeException On a mount or a volatile backend.
	 */
	public function purge( int $limit ): int {
		$this->refuse_if_mounted( 'purge' );
		// A spent deadline runs one batch.
		return $this->purge_batches( $this->durable( 'purge' ), (int) Core::right_now(), 0.0, $limit )['rows'];
	}

	/**
	 * Cross-process delete, for the same callers `store()` serves.
	 *
	 * @api Non-graph writers drop table entries without a live worker.
	 * @param string $key Key within the table's namespace.
	 * @return bool|null True when the entry was there to delete, false when it
	 *                   was absent, null when no backend answered.
	 */
	public function forget( string $key ): ?bool {
		$entry_key = $this->key( $key );
		return $this->arm()?->delete( $entry_key );
	}

	/**
	 * Store entries under their own remaining lifetimes, a round trip per
	 * lifetime rather than per key. An entry stating none takes the table's,
	 * and one whose life is spent takes no cache slot.
	 *
	 * @param array<array-key,array{value: mixed,ttl?: int}> $entries Key within
	 *        the table's namespace => value and remaining life.
	 */
	private function warm( array $entries ): void {
		$groups = [];
		foreach ( $entries as $key => $entry ) {
			$left = \array_key_exists( 'ttl', $entry ) ? Core::as_int( $entry['ttl'] ) : $this->ttl;
			if ( $left > 0 ) {
				$groups[ $left ][ $this->key( (string) $key ) ] = $entry['value'];
			}
		}
		foreach ( $groups as $ttl => $items ) {
			$this->arm()?->write_multi( $items, $ttl );
		}
	}

	/**
	 * Refuse a TTL that is not a whole number of at least one second, naming
	 * the Table: a Table entry always expires.
	 *
	 * @param string $ttl The TTL as given; '' when none was.
	 * @throws \InvalidArgumentException Always.
	 */
	private function refuse_ttl( string $ttl ): never {
		$table = $this->table_name();
		throw new \InvalidArgumentException( \esc_html( '' === $ttl ? "Table {$table} needs a TTL" : "Table {$table} needs a TTL of at least 1 whole second, not {$ttl}" ) );
	}

	/**
	 * The arm this call goes through: the named one, or `auto`'s choice now.
	 *
	 * @return Cache_Backend|null Null when `auto` finds no backend.
	 */
	protected function arm(): ?Cache_Backend {
		return 'auto' === $this->backend ? Cache_Backend::shared_first() : $this->arm;
	}

	/**
	 * One partition of a declared Table, named `stem()`, sinking into `$sink`:
	 * how a request graph mounts a Table outside any topology load. The table
	 * and partition are set here because a web request binds no partition.
	 *
	 * @api Request graphs mounting a declared Table's partition.
	 * @param string                                             $table     The declared Table.
	 * @param int                                                $partition Which partition's file.
	 * @param array{namespace: string, ttl: int, backend: string} $spec     The resolved declaration.
	 * @param Node                                               $sink      Where fill() forwards.
	 * @return self The mounted Table.
	 * @throws \InvalidArgumentException On a name that cannot name a file.
	 * @throws \Throwable As arguments(), Table_Unavailable as thrown; nothing
	 *                    stays registered, and a teardown that also throws
	 *                    escapes beside the cause.
	 */
	public static function mount( string $table, int $partition, array $spec, Node $sink ): self {
		try {
			$stem = self::stem( $table, $partition );
		} catch ( \InvalidArgumentException $e ) {
			throw new \InvalidArgumentException( \esc_html( $e->getMessage() ), 0, $e );
		}
		$node            = new self();
		$node->table     = $table;
		$node->partition = $partition;
		$node->mounted   = true;
		$node->name( $stem );
		try {
			$node->arguments( [ $spec['namespace'], (string) $spec['ttl'], $spec['backend'] ] );
		} catch ( \Throwable $e ) {
			// name() registers first, so a refusal would orphan the node.
			Worker_Should_Stop::raise( [ $e, ...Worker_Should_Stop::attempt( $node->remove_node( ... ) ) ] );
		}
		$node->sink( $sink );
		return $node;
	}

	/**
	 * The key this Table stores an entry under: a durable arm's row key, or
	 * a volatile arm's salted one, which `auto` resolves to.
	 *
	 * @param string $key Key within the table's namespace.
	 * @return string The stored key.
	 */
	private function key( string $key ): string {
		return $this->arm instanceof Durable_Arm ? $this->arm->row_key( $key ) : Cache_Backend::entry_key( $this->namespace, $key );
	}

	/**
	 * Reclaim a durable backend's free pages. Verb-exposed (`vacuum`), and
	 * never automatic: SQLite's VACUUM rewrites the file, wpdb's OPTIMIZE the
	 * shared table.
	 *
	 * @return string The verb's reply line, `ok`.
	 * @throws \RuntimeException On a mount, on a volatile backend, or when the
	 *                           backend refuses, naming this Table.
	 */
	public function vacuum(): string {
		$this->refuse_if_mounted( 'vacuum' );
		$arm = $this->durable( 'vacuum' );
		try {
			$arm->vacuum();
		} catch ( Worker_Should_Stop $stop ) {
			throw $stop;
		} catch ( \RuntimeException $e ) {
			throw new \RuntimeException( \esc_html( "Table {$this->name}: " . $e->getMessage() ), 0, $e );
		}
		return "ok\n";
	}

	/**
	 * Empty this Table's durable arm, every row and member, live or expired:
	 * a `sqlite` Table replaces its file, answering the bytes the old one
	 * held, and a `wpdb` Table deletes its namespace's rows, answering how
	 * many. The state that described the old file — the checkpoint schedule,
	 * the WAL stall count, a purge left behind — starts over. Verb-exposed
	 * (`flush`).
	 *
	 * @return array{bytes:int}|array{rows:int} What was released.
	 * @throws \RuntimeException On a mount, a volatile backend, or a store
	 *                           that refuses.
	 */
	public function flush(): array {
		$this->refuse_if_mounted( 'flush' );
		$arm                    = $this->durable( 'flush' );
		$released               = $arm->flush() ?? throw new \RuntimeException( \esc_html( "Table {$this->table_name()}: flush failed: " . $arm->last_failure() ) );
		$this->checkpoint_due   = (int) Core::$now + self::CHECKPOINT_INTERVAL_S;
		$this->wal_stalled      = 0;
		$this->wal_stall_frames = 0;
		$this->purge_behind     = false;
		return $released;
	}

	/**
	 * This Table's durable arm, for a verb only a durable backend answers.
	 *
	 * @param string $verb The verb, for the refusal.
	 * @return Durable_Arm The arm.
	 * @throws \RuntimeException On a volatile backend.
	 */
	private function durable( string $verb ): Durable_Arm {
		return $this->arm instanceof Durable_Arm ? $this->arm : throw new \RuntimeException( \esc_html( "{$verb} {$this->needs_durable()}" ) );
	}

	/**
	 * Why a verb only a durable backend answers is refused here.
	 *
	 * @return string `needs a durable backend; <table> is <backend>`.
	 */
	private function needs_durable(): string {
		return "needs a durable backend; {$this->table_name()} is {$this->backend}";
	}

	/**
	 * One Table's purge on the Router tick, in PURGE_BATCH_ROWS batches; the
	 * rest waits a minute. A purge that stops with its last batch full leaves
	 * the Table behind, and says so; the first batch that is not full catches
	 * it up.
	 *
	 * @param Durable_Arm $arm   The Table's arm.
	 * @param int         $now   The tick, in epoch seconds.
	 * @param float       $until The tick's deadline, shared by every Table.
	 */
	private function purge_tick( Durable_Arm $arm, int $now, float $until ): void {
		[ 'rows' => $purged, 'batches' => $batches, 'full' => $this->purge_behind ] = $this->purge_batches( $arm, $now, $until, self::PURGE_BATCH_ROWS );
		if ( $this->purge_behind ) {
			$this->print_less_often( 'WARNING: purge is behind: ', "its last batch came back full after {$batches} batches, {$purged} rows; the next purge spends its backlog budget" );
		}
	}

	/**
	 * Delete expired rows `$batch` at a time, counted as one PURGE: a batch,
	 * repeated while each comes back full, as the arm judges it, and the
	 * deadline, read through
	 * `Core::right_now()`, has not passed, so a spent deadline runs one. The
	 * deadline is checked between batches, so one statement blocked on the
	 * file's write lock can hold the tick for the arm's busy_timeout.
	 *
	 * @param Durable_Arm $arm   The Table's arm.
	 * @param int         $now   Rows expired at this epoch second go.
	 * @param float       $until The deadline.
	 * @param int         $batch Rows one statement deletes at most.
	 * @return array{rows: int, batches: int, full: bool} Rows deleted, batches
	 *                                                    run, and whether the
	 *                                                    last came back full.
	 */
	private function purge_batches( Durable_Arm $arm, int $now, float $until, int $batch ): array {
		$started = self::monotonic_ns();
		$bytes   = $this->arm_bytes();
		$batches = 0;
		$purged  = 0;
		try {
			do {
				++$batches;
				$done    = $arm->purge( $now, $batch );
				$purged += $done['rows'];
			} while ( Core::right_now() < $until && $done['full'] );
		} finally {
			$this->count_rows( 'PURGE', $batches * $batch, $purged );
			$this->count_call( 'PURGE', $started, $bytes );
		}
		return [
			'rows'    => $purged,
			'batches' => $batches,
			'full'    => $done['full'],
		];
	}

	/**
	 * One Table's WAL checkpoint, unless a purge this tick spent the deadline
	 * (read off `Core::$now`, which the purge refreshed), or at once when no
	 * purge was due and the tick set no deadline. One that runs dates the
	 * next from `$now`. It is counted as CHECKPOINT: `asked` the WAL's
	 * frames, `answered` the frames written back. A partial one is ordinary
	 * and the next carries on; WAL_STALL_CHECKPOINTS of them in a row, with
	 * the WAL larger than when the stall began, is warned about, rate-limited.
	 *
	 * @param Sqlite_Arm $arm   The Table's arm.
	 * @param int        $now   The tick, in epoch seconds.
	 * @param ?float     $until The tick's deadline, shared by every Table, or
	 *                          null when no purge was due.
	 */
	private function checkpoint_wal( Sqlite_Arm $arm, int $now, ?float $until ): void {
		if ( null !== $until && Core::$now >= $until ) {
			return;
		}
		$this->checkpoint_due = $now + self::CHECKPOINT_INTERVAL_S;
		$started              = self::monotonic_ns();
		try {
			$result = $arm->checkpoint();
		} finally {
			$this->count_call( 'CHECKPOINT', $started, $this->arm_bytes() );
		}
		if ( null === $result ) {
			return;
		}
		[ $frames, $written ] = $result;
		$this->count_rows( 'CHECKPOINT', $frames, $written );
		if ( $written >= $frames ) {
			$this->wal_stalled = 0;
			return;
		}
		if ( 0 === $this->wal_stalled++ ) {
			$this->wal_stall_frames = $frames;
		}
		if ( $this->wal_stalled >= self::WAL_STALL_CHECKPOINTS && $frames > $this->wal_stall_frames ) {
			$this->print_less_often( 'WARNING: WAL checkpoint has not completed ', "for {$this->wal_stalled} checkpoints while the WAL grew from {$this->wal_stall_frames} to {$frames} frames; an open reader holds an old snapshot" );
		}
	}

	/**
	 * The node's snapshot, its per-verb counters shown as stats() reports them.
	 *
	 * @return array<string,mixed>
	 */
	public function dump_node(): array {
		return \array_replace( parent::dump_node(), [ 'verb_stats' => $this->stats() ] );
	}

	/**
	 * The per-verb counters, for the console's metadata row.
	 *
	 * @return array<string,mixed>
	 */
	public function dump_metadata(): array {
		return [ 'verb_stats' => $this->stats() ];
	}

	/**
	 * `reset_stats`: zero the counters, answering them as they stood, so no
	 * call lands between the read and the reset.
	 *
	 * The reset zeroes what `stats()` reports and nothing a window still
	 * owes: the calls since the last probe sweep, and since a traced Table's
	 * last trace line, carry across it as a negative baseline, so the next
	 * `probe_stats()` and the next trace line report them beside the calls
	 * after. Each verb's window max survives too, and the probe window keeps
	 * the instant it opened, so `tablestats.p0` loses no call to a reset.
	 *
	 * @return array<string,array{calls:int,asked:int,answered:int,bytes:int,total_ms:float,max_ms:float,errors:int}>
	 * @throws \RuntimeException On a mounted Table, which serves reads only.
	 */
	public function reset_stats(): array {
		$this->refuse_if_mounted( 'reset_stats' );
		$stats        = $this->stats();
		$this->probed = $this->carried( $this->probed ?? self::zero_stats() );
		if ( null !== $this->traced ) {
			$this->traced = $this->carried( $this->traced );
		}
		$this->verb_stats = \array_map( static fn ( array $row ): array => [ 0, 0, 0, 0, 0, 0, 0, $row[ self::WINDOW_MAX_NS ] ], $this->verb_stats );
		return $stats;
	}

	/**
	 * The baseline that, against counters about to zero, still yields the
	 * window open since `$since`: each counter's pending delta, negated.
	 * `window()` subtracts it, so zero minus it is that delta again.
	 *
	 * @param array<string,array{int,int,int,int,int,int,int,int}> $since The window's baseline.
	 * @return array<string,array{int,int,int,int,int,int,int,int}> The carried baseline.
	 */
	private function carried( array $since ): array {
		$out = [];
		foreach ( $this->verb_stats as $verb => $row ) {
			foreach ( $row as $i => $count ) {
				$out[ $verb ][ $i ] = $since[ $verb ][ $i ] - $count;
			}
		}
		return $out;
	}

	/**
	 * Refuse a `:config` write verb on a mount, which serves reads only.
	 *
	 * @param string $verb The verb refused.
	 * @throws \RuntimeException On a mounted Table.
	 */
	private function refuse_if_mounted( string $verb ): void {
		if ( $this->mounted ) {
			throw new \RuntimeException( \esc_html( "{$verb}: {$this->name} is a mounted Table, which serves reads only" ) );
		}
	}

	/**
	 * The per-verb counters since the node was built or last reset. `asked`
	 * and `answered` count keys, except SADD's member rows, the member rows
	 * members_of() answers as SMEMBERS, and PURGE's rows: `asked` the
	 * batches' room, `answered` the rows deleted. `bytes` is what a durable
	 * arm encoded or decoded; a volatile arm's serializer runs inside its
	 * extension, so it reads 0. A call that threw still counts, with its time.
	 *
	 * @api The `stats` verb, dump_node() and dump_metadata() answer it.
	 * @return array<string,array{calls:int,asked:int,answered:int,bytes:int,total_ms:float,max_ms:float,errors:int}>
	 */
	public function stats(): array {
		$out = [];
		foreach ( $this->verb_stats as $verb => $row ) {
			$out[ $verb ] = [
				'calls'    => $row[ self::CALLS ],
				'asked'    => $row[ self::ASKED ],
				'answered' => $row[ self::ANSWERED ],
				'bytes'    => $row[ self::BYTES ],
				'total_ms' => \round( $row[ self::TOTAL_NS ] / 1e6, 3 ),
				'max_ms'   => \round( $row[ self::MAX_NS ] / 1e6, 3 ),
				'errors'   => $row[ self::ERRORS ],
			];
		}
		return $out;
	}

	/**
	 * Probe seam: this Table's window since the previous sweep, as one
	 * positional `Tablestats_Record`, for `Table_Probe` to write to
	 * tablestats.p0. A DRAINING read — call it once per sweep: the window
	 * reopens and each verb's window max resets. A mount answers nothing, since
	 * its declaring worker is the file's one writer.
	 *
	 * @return list<array<int,mixed>> One record, or none for a mount.
	 */
	public function probe_stats(): array {
		if ( $this->mounted ) {
			return [];
		}
		$verbs = [];
		foreach ( $this->window( $this->probed ?? self::zero_stats() ) as $verb => [ $calls, $asked, $answered, $bytes, $ns, $errors, $max_ns ] ) {
			$verbs[ $verb ] = [
				Tablestats_Record::ROW_CALLS    => $calls,
				Tablestats_Record::ROW_ASKED    => $asked,
				Tablestats_Record::ROW_ANSWERED => $answered,
				Tablestats_Record::ROW_BYTES    => $bytes,
				Tablestats_Record::ROW_MS       => \round( $ns / 1e6, 3 ),
				Tablestats_Record::ROW_MAX_MS   => \round( $max_ns / 1e6, 3 ),
				Tablestats_Record::ROW_ERRORS   => $errors,
			];
		}
		foreach ( \array_keys( $this->verb_stats ) as $verb ) {
			$this->verb_stats[ $verb ][ self::WINDOW_MAX_NS ] = 0;
		}
		$this->probed   = $this->verb_stats;
		$elapsed        = (int) \round( \max( 0.0, Core::$now - $this->probe_ts ) * 1000 );
		$this->probe_ts = Core::$now;
		$files          = $this->arm instanceof Sqlite_Arm ? Sqlite_Arm::footprint( $this->sqlite_path ) : null;
		return [
			[
				Tablestats_Record::IDENTITY        => $this->probe_identity(),
				Tablestats_Record::BACKEND         => $this->backend,
				Tablestats_Record::VERBS           => $verbs,
				Tablestats_Record::PURGE_BEHIND    => $this->arm instanceof Durable_Arm ? (int) $this->purge_behind : null,
				Tablestats_Record::WAL_STALLED     => $this->arm instanceof Sqlite_Arm ? $this->wal_stalled : null,
				Tablestats_Record::FILE_BYTES      => null === $files ? null : $files['bytes'],
				Tablestats_Record::ELAPSED_MS      => $elapsed,
				Tablestats_Record::FILE_DISK_BYTES => null === $files ? null : $files['disk'],
			],
		];
	}

	/**
	 * Every counted verb's row at zero: the requests this class declares,
	 * fill()'s keyed INSERT, and the Router tick's PURGE and CHECKPOINT.
	 *
	 * @return array<string,array{int,int,int,int,int,int,int,int}>
	 */
	private static function zero_stats(): array {
		return \array_fill_keys( [ ...\array_keys( self::requests() ), ...self::COUNTED ], [ 0, 0, 0, 0, 0, 0, 0, 0 ] );
	}

	/**
	 * The requests this class's node_schema() declares, read once a class:
	 * verb => `needs` and what its structure carries, or null for a string
	 * verb.
	 *
	 * @return array<string,string|null>
	 */
	protected static function requests(): array {
		if ( ! isset( self::$requests[ static::class ] ) ) {
			$requests = [];
			foreach ( Core::arr( static::node_schema()['requests'] ) as $request ) {
				$request = Core::arr( $request );
				$requests[ Core::as_string( $request['name'] ) ] = 'struct' === ( $request['value'] ?? null )
					? 'needs ' . Core::as_string( Core::arr( Core::arr( $request['args'] )[0] )['description'] )
					: null;
			}
			self::$requests[ static::class ] = $requests;
		}
		return self::$requests[ static::class ];
	}

	/**
	 * The partition a `sqlite` file belongs to: the mounted one, else the
	 * partition bound when its arguments arrived. Never a guess, since a
	 * guessed partition would open another partition's file.
	 *
	 * @return int The partition.
	 * @throws \LogicException When the Table is unmounted and nothing bound one.
	 */
	private function file_partition(): int {
		if ( null !== $this->partition ) {
			return $this->partition;
		}
		return $this->bound_partition ?? throw new \LogicException( 'a sqlite backend needs a bound partition' );
	}

	/**
	 * The SQLite file of one partition of a declared Table.
	 *
	 * @param string $table     The declared Table.
	 * @param int    $partition The partition.
	 * @return string `{base}/tables/{table}.p{partition}.sqlite`.
	 * @throws \InvalidArgumentException On a name that cannot name a file.
	 */
	public static function file( string $table, int $partition ): string {
		return self::dir( Bootstrap::base_dir() ) . '/' . self::stem( $table, $partition ) . '.sqlite';
	}

	/**
	 * Every Table partition's SQLite database under `$base`, as `file()`
	 * names each, its `-wal` and `-shm` left out.
	 *
	 * @param string $base The runtime base directory.
	 * @return array<int,string>
	 */
	public static function files_in( string $base ): array {
		return @\glob( self::dir( $base ) . '/*.sqlite' ) ?: [];
	}

	/** The directory a base holds its Tables' SQLite files in. */
	protected static function dir( string $base ): string {
		return "{$base}/tables";
	}

	/**
	 * The name a probe record files this Table under: its stem when a
	 * partition is known, else its own name.
	 *
	 * @return string `{table}.p{N}`, or the node name.
	 */
	private function probe_identity(): string {
		$partition = $this->partition ?? $this->bound_partition;
		return null === $partition ? $this->table_name() : self::stem( $this->table_name(), $partition );
	}

	/**
	 * A declared Table's per-partition name: its file stem and its mount name.
	 *
	 * @param string $table     The declared Table.
	 * @param int    $partition The partition.
	 * @return string `{table}.p{partition}`.
	 * @throws \InvalidArgumentException On a name that cannot name a file: a path
	 *                                   separator, NUL, `..` or a leading dot.
	 */
	public static function stem( string $table, int $partition ): string {
		return self::file_name( 'Table', $table ) . ".p{$partition}";
	}

	/**
	 * A name that can name a file under the Tables' directory: one leading
	 * letter or digit, then letters, digits and `_.:-`, and no `..`.
	 *
	 * @param string $what What the name names, for the refusal.
	 * @param string $name The name.
	 * @return string `$name`.
	 * @throws \InvalidArgumentException On a path separator, NUL, `..` or a
	 *                                   leading dot.
	 */
	protected static function file_name( string $what, string $name ): string {
		if ( 1 !== \preg_match( '/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/D', $name ) || \str_contains( $name, '..' ) ) {
			throw new \InvalidArgumentException( "{$what} name {$name} cannot name a file" );
		}
		return $name;
	}

	/**
	 * The declared Table this node answers for, else its own name.
	 *
	 * @return string The name a refusal gives.
	 */
	private function table_name(): string {
		return '' !== $this->table ? $this->table : $this->name;
	}

	/**
	 * Count one call of `$verb` begun at `$started`: its time and the bytes
	 * its arm handled since `$bytes`. A verb not counted adds no row. Callers
	 * bracket inline, since a closure would allocate once per message.
	 *
	 * @param string $verb    The verb.
	 * @param int    $started monotonic_ns() when the call began.
	 * @param int    $bytes   arm_bytes() when the call began.
	 */
	private function count_call( string $verb, int $started, int $bytes ): void {
		if ( ! isset( $this->verb_stats[ $verb ] ) ) {
			return;
		}
		$ns = self::monotonic_ns() - $started;
		++$this->verb_stats[ $verb ][ self::CALLS ];
		$this->verb_stats[ $verb ][ self::BYTES ]    += $this->arm_bytes() - $bytes;
		$this->verb_stats[ $verb ][ self::TOTAL_NS ] += $ns;
		if ( $ns > $this->verb_stats[ $verb ][ self::MAX_NS ] ) {
			$this->verb_stats[ $verb ][ self::MAX_NS ] = $ns;
		}
		if ( $ns > $this->verb_stats[ $verb ][ self::WINDOW_MAX_NS ] ) {
			$this->verb_stats[ $verb ][ self::WINDOW_MAX_NS ] = $ns;
		}
	}

	/**
	 * Add to a verb's keys or rows asked and answered; as count_call(), a
	 * verb not counted adds no row.
	 *
	 * @param string $verb     The verb.
	 * @param int    $asked    Keys or rows asked.
	 * @param int    $answered Keys or rows answered or written.
	 */
	protected function count_rows( string $verb, int $asked, int $answered ): void {
		if ( ! isset( $this->verb_stats[ $verb ] ) ) {
			return;
		}
		$this->verb_stats[ $verb ][ self::ASKED ]    += $asked;
		$this->verb_stats[ $verb ][ self::ANSWERED ] += $answered;
	}

	/**
	 * Count one request `$verb` answered with a TM_ERROR; a verb not counted
	 * adds no row.
	 *
	 * @param string $verb The verb.
	 */
	protected function count_error( string $verb ): void {
		if ( isset( $this->verb_stats[ $verb ] ) ) {
			++$this->verb_stats[ $verb ][ self::ERRORS ];
		}
	}

	/**
	 * The encoded bytes the Table's durable arm has handled; 0 for any other.
	 *
	 * @return int Bytes.
	 */
	private function arm_bytes(): int {
		return $this->arm instanceof Durable_Arm ? $this->arm->bytes() : 0;
	}

	/**
	 * The monotonic clock: `hrtime( true )`, or the `$hrtime` seam.
	 *
	 * @return int Nanoseconds from an arbitrary origin.
	 */
	private static function monotonic_ns(): int {
		return null === self::$hrtime ? (int) \hrtime( true ) : ( self::$hrtime )();
	}

	/**
	 * A traced Table's line for one Router tick: `DEBUG: <VERB> <calls>
	 * <ms>ms, …` over each verb called since its last line, on the stderr
	 * path set_state()'s DEBUG line takes, so the console's timeline reads
	 * it; no line when nothing was called.
	 */
	private function trace_tick(): void {
		$parts = [];
		foreach ( $this->window( $this->traced ?? $this->verb_stats ) as $verb => [ $calls, , , , $ns ] ) {
			$parts[] = "{$verb} {$calls} " . \round( $ns / 1e6, 3 ) . 'ms';
		}
		$this->traced = $this->verb_stats;
		if ( [] !== $parts ) {
			$this->stderr( 'DEBUG: ' . \implode( ', ', $parts ) );
		}
	}

	/**
	 * Each verb's counters since `$since`, for the verbs called since. A
	 * baseline `reset_stats()` carried is negative, which the subtraction
	 * reads as the calls the reset landed between.
	 *
	 * @param array<string,array{int,int,int,int,int,int,int,int}> $since A copy of the counters.
	 * @return array<string,array{int,int,int,int,int,int,int}> Verb => calls,
	 *         asked, answered, bytes, ns and errors since, and the window max ns.
	 */
	private function window( array $since ): array {
		$out = [];
		foreach ( $this->verb_stats as $verb => $row ) {
			$base  = $since[ $verb ];
			$calls = $row[ self::CALLS ] - $base[ self::CALLS ];
			if ( $calls > 0 ) {
				$out[ $verb ] = [
					$calls,
					$row[ self::ASKED ] - $base[ self::ASKED ],
					$row[ self::ANSWERED ] - $base[ self::ANSWERED ],
					$row[ self::BYTES ] - $base[ self::BYTES ],
					$row[ self::TOTAL_NS ] - $base[ self::TOTAL_NS ],
					$row[ self::ERRORS ] - $base[ self::ERRORS ],
					$row[ self::WINDOW_MAX_NS ],
				];
			}
		}
		return $out;
	}

	/**
	 * Whether `$name` ends as `stem()` ends a name, `.p{N}`.
	 *
	 * @param string $name A file name.
	 * @return bool True when a Table partition's file would take it.
	 */
	public static function is_partition_stem( string $name ): bool {
		return 1 === \preg_match( '/\.p-?[0-9]+$/D', $name );
	}

	/**
	 * A table outside any graph, for the callers `lookup()` / `store()` /
	 * `forget()` exist for. Sugar for `new Table_Node()` plus `arguments()`.
	 *
	 * A `sqlite` table built here keeps partition 0's file, named for `$ns`.
	 *
	 * @api Non-graph readers and writers reach a table without a live worker.
	 * @param string $ns      Table namespace.
	 * @param int    $ttl     Entry TTL in seconds, at least 1.
	 * @param string $backend One of BACKENDS.
	 * @return self A table with no sink, so `lookup()` / `store()` / `forget()`
	 *              work and `fill()` does not.
	 * @throws \InvalidArgumentException With an empty namespace, a TTL below
	 *                                   one second, or an unknown backend.
	 * @throws \RuntimeException On a declaration a named backend refuses.
	 * @throws Table_Unavailable When the backend cannot open on this host,
	 *                           `auto` with no cache backend included; a caller
	 *                           that treats a backend-less host as ordinary
	 *                           catches it, or guards on
	 *                           `Cache_Backend::shared_first()` first.
	 */
	public static function table( string $ns, int $ttl, string $backend = 'auto' ): self {
		$node            = new self();
		$node->table     = $ns;
		$node->partition = 0;
		$node->arguments( [ $ns, (string) $ttl, $backend ] );
		return $node;
	}

	/**
	 * Read or set the trace level. Setting it on holds the counters as they
	 * stand, so the first trace line sums what came after; off drops them.
	 *
	 * @param int|null $level New level (null = pure getter).
	 * @return int The level now in force.
	 */
	public function debug_state( ?int $level = null ): int {
		$state = parent::debug_state( $level );
		if ( null !== $level ) {
			$this->traced = $state > 0 ? $this->traced ?? $this->verb_stats : null;
		}
		return $state;
	}

	/**
	 * The Router tick's step for every Table in this process's graph: delete
	 * the rows expired at `$now` from each durable one, at most once a
	 * `PURGE_INTERVAL_S` each, then checkpoint each SQLite Table's WAL, at most
	 * once a `CHECKPOINT_INTERVAL_S` each. Last, every traced Table, volatile
	 * ones too, writes its trace line. The purges and checkpoints share one
	 * deadline, PURGE_BACKLOG_BUDGET_S while any purge is behind and PURGE_BUDGET_S
	 * otherwise, so a tick holds the loop for one budget plus one batch a
	 * purging Table and one checkpoint begun before the deadline; a checkpoint
	 * the purges left no time for waits a tick, not an interval. The tick runs its
	 * timers' flushes first, so a checkpoint never lands inside one. A mount
	 * is skipped, since its declaring worker is the file's one writer.
	 *
	 * @param int $now The tick, in epoch seconds.
	 * @throws \Throwable What the steps threw, after the last.
	 */
	public static function tick( int $now ): void {
		$due    = [];
		$wals   = [];
		$traces = [];
		$behind = false;
		foreach ( Core::$nodes_by_name as $node ) {
			if ( ! $node instanceof self ) {
				continue;
			}
			if ( $node->debug_state > 0 ) {
				$traces[] = $node->trace_tick( ... );
			}
			$arm = $node->mounted ? null : $node->arm;
			if ( ! $arm instanceof Durable_Arm ) {
				continue;
			}
			if ( $arm instanceof Sqlite_Arm && $node->checkpoint_due <= $now ) {
				$wals[] = [ $node, $arm ];
			}
			if ( $node->purge_due <= $now ) {
				$node->purge_due = $now + self::PURGE_INTERVAL_S;
				$due[]           = [ $node, $arm ];
				$behind          = $behind || $node->purge_behind;
			}
		}
		if ( [] === $due && [] === $wals && [] === $traces ) {
			return;
		}
		$until  = null;
		$purges = [];
		if ( [] !== $due ) {
			// Only a due purge reads the live clock, refreshing Core::$now.
			$deadline = Core::right_now() + ( $behind ? self::PURGE_BACKLOG_BUDGET_S : self::PURGE_BUDGET_S );
			$until    = $deadline;
			$purges   = \array_map( static fn ( array $table ): \Closure => static fn () => $table[0]->purge_tick( $table[1], $now, $deadline ), $due );
		}
		$checkpoints = \array_map( static fn ( array $table ): \Closure => static fn () => $table[0]->checkpoint_wal( $table[1], $now, $until ), $wals );
		Worker_Should_Stop::raise( Worker_Should_Stop::attempt( ...$purges, ...$checkpoints, ...$traces ) );
	}

	/**
	 * No replayable line for a Table given its partition in code — mounted, or
	 * built by table(). It is derived state: its declaring topology's
	 * `make_node Table` line is the source of truth, and the mount rebuilds it.
	 * A dumped `make_node Table lab-7:kea.p3 …` would replay under the mount
	 * name, which opens another file or none.
	 *
	 * @return string The inherited lines for a `make_node` Table, else nothing.
	 */
	public function dump_config(): string {
		return null === $this->partition ? parent::dump_config() : '';
	}

	/**
	 * Opt in to a durable system of record behind this table.
	 *
	 * A table is a CACHE of something when it has one: `lookup()` and `GET`
	 * fall through on a miss, store what comes back, and return it, so every
	 * caller reads one API and the durable tier is asked once per miss rather
	 * than once per caller.
	 *
	 * The closure takes the keys that missed and returns
	 * `key => { value, ttl? }` for whichever of them the record still holds;
	 * absent keys stay absent. `ttl` is that entry's REMAINING life — omit it
	 * to store under the table's own.
	 *
	 * The table remembers no absence: a key the record does not hold writes
	 * nothing, so every miss reaches the backing, and a backing that could not
	 * look answers null.
	 *
	 * @api Callers whose table fronts a durable source (a partition, an option).
	 * @param \Closure(list<string>): ?array<array-key,array{value: mixed,ttl?: int}> $backing Durable reader;
	 *        null when it could not look. A numeric-string key comes back int, so the shape is array-key.
	 * @return self For chaining off table().
	 */
	public function backed_by( \Closure $backing ): self {
		$this->backing = $backing;
		return $this;
	}

	/**
	 * Palette entry, argument form and the `:config` verbs the auto-wired
	 * interpreter dispatches. `has_target` is true because fill() forwards
	 * every message it stores, so a table sits mid-graph with a next hop.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'         => 'Storage',
			'description'      => 'Keyed KEY→VALUE store; write-through fill, cross-process lookup().',
			'arguments'        => [
				[ 'name' => 'namespace', 'type' => 'string', 'required' => true, 'partition' => 'bound', 'description' => 'Scopes keys; lookup() reads by it.' ],
				[ 'name' => 'ttl', 'type' => 'int', 'required' => true, 'description' => 'Entry TTL in seconds, at least 1; entries a write does not time take it.' ],
				[ 'name' => 'backend', 'type' => 'string', 'default' => 'auto', 'description' => 'auto, memcache, apcu, sqlite or wpdb; sqlite and wpdb are durable.' ],
			],
			'commands'         => [
				[
					'name'        => 'stats',
					'capability'  => Capabilities::READ,
					'description' => 'Per-verb counters since the Table was built: calls, keys or rows asked and answered, encoded bytes, total and max ms, errors.',
					'args'        => [],
					'handler'     => static function ( Command_Interpreter_Node $interpreter ): array {
						$patron = $interpreter->patron();
						return $patron instanceof self ? $patron->stats() : throw new \RuntimeException( 'no table patron' );
					},
				],
				[
					'name'        => 'reset_stats',
					'action'      => true,
					'description' => 'Zero the per-verb counters, answering them as they stood. A mount refuses it.',
					'args'        => [],
					'handler'     => static function ( Command_Interpreter_Node $interpreter ): array {
						$patron = $interpreter->patron();
						return $patron instanceof self ? $patron->reset_stats() : throw new \RuntimeException( 'no table patron' );
					},
				],
				[
					'name'        => 'flush',
					'action'      => true,
					'description' => 'Empty the Table: sqlite replaces its file and answers the bytes released, wpdb deletes its namespace\'s rows and answers how many. Durable backends only; a mount refuses it.',
					'args'        => [],
					'handler'     => static function ( Command_Interpreter_Node $interpreter ): array {
						$patron = $interpreter->patron();
						return $patron instanceof self ? $patron->flush() : throw new \RuntimeException( 'no table patron' );
					},
				],
				[
					'name'        => 'vacuum',
					'action'      => true,
					'description' => 'Reclaim a durable backend\'s free pages (SQLite VACUUM, wpdb OPTIMIZE TABLE). Never automatic.',
					'args'        => [],
					'handler'     => static function ( Command_Interpreter_Node $interpreter ): string {
						$patron = $interpreter->patron();
						return $patron instanceof self ? $patron->vacuum() : throw new \RuntimeException( 'no table patron' );
					},
				],
			],
			// No handler: handle_request() answers every one of these.
			'requests'         => [
				[
					'name'        => 'GET',
					'description' => 'One stored value. Case-sensitive, as every verb is.',
					'args'        => [ [ 'name' => 'key', 'type' => 'string', 'required' => true ] ],
					'reply_shape' => self::READ_REPLY,
				],
				[
					'name'        => 'SMOVE',
					'description' => 'Move up to <count> members, lowest first, from one set to another, each keeping its value and expiry; sqlite and wpdb alone hold members.',
					'args'        => [
						[ 'name' => 'count', 'type' => 'int', 'required' => true, 'description' => 'Most members moved, from 1 to MAX_MEMBERS_LIMIT (10000).' ],
						[ 'name' => 'from_set', 'type' => 'string', 'required' => true ],
						[ 'name' => 'to_set', 'type' => 'string', 'required' => true ],
					],
					'reply_shape' => self::MOVED_REPLY,
				],
				[
					'name'        => 'SREM',
					'description' => 'Delete the named members of one set; sqlite and wpdb alone hold members.',
					'args'        => [
						[ 'name' => 'set_key', 'type' => 'string', 'required' => true ],
						[ 'name' => 'members', 'type' => 'string', 'required' => true, 'description' => 'Whitespace-separated members.' ],
					],
					'reply_shape' => self::WRITE_REPLY,
				],
				[
					'name'        => 'RM',
					'description' => 'Delete each key.',
					'args'        => [ [ 'name' => 'keys', 'type' => 'string', 'required' => true ] ],
					'reply_shape' => self::WRITE_REPLY,
				],
				[
					'name'        => 'ADD',
					'description' => 'Store many keys under a TM_REQUEST|TM_STRUCT map, each only where absent; ttl defaults to the Table\'s.',
					'value'       => 'struct',
					'args'        => [ [ 'name' => 'map', 'type' => 'json', 'required' => true, 'description' => 'a map of key => [ value, ttl ]' ] ],
					'reply_shape' => self::WRITE_REPLY,
				],
				[
					'name'        => 'SADD',
					'description' => 'Upsert set members under a TM_REQUEST|TM_STRUCT map; ttl defaults to the Table\'s. sqlite and wpdb alone hold members.',
					'value'       => 'struct',
					'args'        => [ [ 'name' => 'map', 'type' => 'json', 'required' => true, 'description' => 'a map of set key => [ [ member => value, … ], ttl ]' ] ],
					'reply_shape' => self::WRITE_REPLY,
				],
			],
			'has_target'       => true,
		];
	}
}
