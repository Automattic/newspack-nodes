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
 * Two tiers hang off that store, both off until a caller opts in. The
 * ACCUMULATOR holds values a caller is still folding into, bringing back
 * Tachikoma's buckets as a tier rather than as the store: a table is a
 * cross-process source of truth and held state is not, so opting in buys speed
 * and pays bounded staleness. The BACKING is the durable system of record a
 * miss falls through to, which makes the table a cache of that record rather
 * than the record itself (ADR-18). See accumulator() and backed_by().
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Table node — `make_node Table <name> <namespace> <ttl> [ auto|memcache|apcu|sqlite|wpdb ]`.
 */
class Table_Node extends Node {
	use Schema_Reflection;

	/** Every backend a Table may name; `auto` is memcached, else APCu, per call. */
	public const BACKENDS = [ 'auto', 'memcache', 'apcu', 'sqlite', 'wpdb' ];

	/**
	 * Most members one SMEMBERS answers for a set before it answers OVER_LIMIT:
	 * a ceiling on what a read through a mount may cost, as the arm reads one
	 * row past it, set at twice the largest reader's need, event-logger-nodes'
	 * URL search, which shows at most 5,000.
	 */
	public const MAX_MEMBERS_LIMIT = 10000;

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

	/** Most bytes of a refused verb a log line or its throttle key shows. */
	private const SHOWN_VERB_BYTES = 64;

	/** How every read request is answered. */
	private const READ_REPLY = 'one message per value found, KEY set: TM_STRUCT for an array, TM_BYTESTREAM (a string) otherwise; then TM_INFO "<VERB> <n>", or one TM_ERROR "<VERB>: backend read failed"';

	/** How a SMEMBERS request is answered. */
	private const MEMBERS_REPLY = 'one message per set holding a live member, KEY the set key: TM_STRUCT, VALUE a list of [ member, value ] in member order, or TM_BYTESTREAM "OVER <limit>" past the limit; then TM_INFO "SMEMBERS <n>", or one TM_ERROR "SMEMBERS: backend read failed"';

	/**
	 * The word a SMEMBERS reply gives a set holding more than its limit, as
	 * `OVER <limit>\n` under TM_BYTESTREAM: the set's answer as MGET gives a
	 * string value, told from a member list by its type, and naming the
	 * limit it passed so a reader can check it asked for that one.
	 */
	public const OVER_LIMIT = 'OVER';

	/** What each structured verb carries, for a refusal to teach. */
	private const STRUCT_USAGE = [
		'MSET' => 'needs a map of key => [ value, ttl ]',
		'ADD'  => 'needs a map of key => [ value, ttl ]',
		'SADD' => 'needs a map of set key => [ [ member => value, … ], ttl ]',
	];

	/**
	 * The verbs a mount answers: its declaring worker is the file's one writer
	 * (ADR-6), and a request carries no authority beyond the mount (ADR-23).
	 */
	private const READ_VERBS = [ 'GET', 'MGET', 'SMEMBERS' ];

	/** Why a mount refuses any other verb. */
	private const READS_ONLY = 'a mounted Table serves reads only';

	/** How every write request is answered. */
	private const WRITE_REPLY = 'one TM_RESPONSE "<VERB> <keys…>" naming the keys it took effect on';

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

	/** The partition its file belongs to; the bound `<partition>` unless mounted. */
	private ?int $partition = null;

	/** Whether this is a request-graph mount, which serves reads only. */
	private bool $mounted = false;

	/** In-memory accumulator, or null until accumulator() opts in. */
	private ?LRU_Cache $buffer = null;

	/** The tick this Table's next purge is due, in epoch seconds. */
	private int $purge_due = 0;

	/** Whether this Table's last purge stopped with a batch still full. */
	private bool $purge_behind = false;

	/**
	 * Durable system of record behind this table, or null until backed_by()
	 * opts in. Invoked with the keys a read missed on.
	 *
	 * @var (\Closure(list<string>): ?array<array-key,array{value: mixed,ttl?: int}>)|null
	 */
	private ?\Closure $backing = null;

	/**
	 * Wire the sibling `:config` interpreter that serves `get`, `rm` and `vacuum`.
	 *
	 * Takes no arguments, for Tachikoma parity and because `make_node`
	 * constructs first and calls `arguments()` after (ADR-11) — the namespace
	 * and the TTL arrive there, not here.
	 */
	public function __construct() {
		parent::__construct();
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
	 * `pyrobase:g48`, orphaning every key at BOTH tiers at once. That works
	 * because entries are keyed by the derived `entry_key()`, not the bare key.
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
		$arm = $this->open( $backend, $namespace );
		$this->assign_schema_args( $args, $values );
		$this->arm = $arm;
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
		$value = $message[ Message::VALUE ];
		if ( '' !== $key ) {
			// Empty deletes (Table.pm:313); a bare terminator counts as empty.
			$empty = null === $value || [] === $value
				|| ( \is_string( $value ) && '' === \rtrim( $value, "\r\n" ) );
			if ( $empty ) {
				$this->forget( $key );
			} else {
				$this->store( $key, $value );
			}
		}
		parent::fill( $message );
	}

	/**
	 * The arm a named backend opens, once: a Table whose backend cannot open
	 * throws when its arguments arrive, naming itself. Resolving the `sqlite`
	 * file, and an arm refusing an invalid argument, are the declaration's
	 * fault; any other refusal while an arm opens is the host's.
	 *
	 * @param string $backend   One of BACKENDS.
	 * @param string $namespace The namespace a `wpdb` arm scopes its rows by.
	 * @return Cache_Backend|null The arm; null for `auto`, which resolves per call.
	 * @throws \RuntimeException On a base directory or `{base}/tables` that
	 *                           will not resolve, a name no file can carry, no
	 *                           bound partition, or a namespace the arm cannot hold.
	 * @throws Table_Unavailable When the backend cannot open on this host.
	 */
	private function open( string $backend, string $namespace ): ?Cache_Backend {
		$file = 'sqlite' === $backend ? $this->sqlite_file() : '';
		try {
			// arguments() admits BACKENDS alone, so the default arm is `auto`.
			return match ( $backend ) {
				'memcache' => Cache_Backend::memcache_arm() ?? throw new \LogicException( 'memcache backend has no memcached handle' ),
				'apcu'     => Cache_Backend::apcu_arm() ?? throw new \LogicException( 'apcu backend is not usable here' ),
				'sqlite'   => new Sqlite_Arm( $file, read_only: $this->mounted ),
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
			if ( $this->mounted && 0 === CLI::uid() ) {
				throw new \RuntimeException( "a sqlite mount refuses to run as root: a root reader leaves -wal and -shm files beside {$file} that its worker cannot open" );
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
	 * The partition a `sqlite` file belongs to: the mounted one, else the
	 * process's bound `<partition>`. Never a guess, since a guessed partition
	 * would open another partition's file.
	 *
	 * @return int The partition.
	 * @throws \LogicException When the Table is unmounted and nothing bound one.
	 */
	private function file_partition(): int {
		if ( null !== $this->partition ) {
			return $this->partition;
		}
		$bound = \array_key_exists( 'partition', Core::$var ) ? Core::canonical_decimal( Core::$var['partition'] ) : null;
		return $bound ?? throw new \LogicException( 'a sqlite backend needs a bound partition' );
	}

	/**
	 * Answer one request, TO its FROM, FROM this Table, its ID echoed (ADR-7).
	 * Reads send a message per value and a TM_INFO count, or one TM_ERROR when
	 * a key went unread, so a failure never reads as absence. Writes send one
	 * string TM_RESPONSE naming the keys they took effect on. MSET, ADD and
	 * SADD alone carry a structure, under TM_REQUEST|TM_STRUCT. Anything else
	 * the Table cannot answer is refused out loud, through refuse().
	 *
	 * @param array<int,mixed> $request The TM_REQUEST.
	 * @throws \RuntimeException With no wired sink to reply through.
	 */
	private function handle_request( array $request ): void {
		++$this->counter;
		$value  = $request[ Message::VALUE ];
		$struct = 0 !== ( Core::num_int( $request[ Message::TYPE ] ) & Message::TM_STRUCT );
		if ( $this->mounted && \is_array( $value ) ) {
			$this->refuse( $request, Core::as_string( \array_key_first( $value ), '' ), self::READS_ONLY );
			return;
		}
		if ( \is_array( $value ) ) {
			$this->handle_struct( $request, $value, $struct );
			return;
		}
		$words = \preg_split( '/\s+/', \trim( Core::as_string( $value, '' ) ), -1, \PREG_SPLIT_NO_EMPTY ) ?: [];
		$verb  = (string) \array_shift( $words );
		if ( $this->mounted && ! \in_array( $verb, self::READ_VERBS, true ) ) {
			$this->refuse( $request, $verb, self::READS_ONLY );
			return;
		}
		if ( $struct ) {
			$this->refuse( $request, $verb, 'a string request carries no TM_STRUCT bit' );
			return;
		}
		match ( $verb ) {
			'GET'                 => $this->reply_values( $request, $verb, \array_slice( $words, 0, 1 ) ),
			'MGET'                => $this->reply_values( $request, $verb, $words ),
			'SMEMBERS'            => $this->reply_members( $request, $words ),
			'TOUCH'               => $this->reply_touch( $request, $words ),
			'RM'                  => $this->reply_written( $request, $verb, $this->remove_keys( $words ) ),
			'MSET', 'ADD', 'SADD' => $this->refuse( $request, $verb, self::STRUCT_USAGE[ $verb ] ),
			default               => $this->refuse( $request, $verb, 'unknown verb' ),
		};
	}

	/**
	 * `MSET`/`ADD`/`SADD`: one verb naming a map of key => [ value, ttl ],
	 * under the TM_STRUCT bit; a SADD value is its set's member map.
	 *
	 * @param array<int,mixed>       $request The TM_REQUEST.
	 * @param array<array-key,mixed> $value   The request's VALUE.
	 * @param bool                   $struct  Whether TYPE carries TM_STRUCT.
	 * @throws \RuntimeException With no wired sink to reply through.
	 */
	private function handle_struct( array $request, array $value, bool $struct ): void {
		$verb  = Core::as_string( \array_key_first( $value ), '' );
		$items = $value[ $verb ] ?? null;
		$fault = match ( true ) {
			! $struct                                   => 'a structured request needs the TM_STRUCT bit',
			1 !== \count( $value )                      => 'a structured request names one verb',
			! isset( self::STRUCT_USAGE[ $verb ] )      => 'only MSET, ADD and SADD take a structure',
			! \is_array( $items )                       => self::STRUCT_USAGE[ $verb ],
			default                                     => null,
		};
		if ( null !== $fault ) {
			$this->refuse( $request, $verb, $fault );
			return;
		}
		if ( 'SADD' === $verb ) {
			$this->reply_added( $request, Core::arr( $items ) );
			return;
		}
		$this->reply_written( $request, $verb, $this->write_items( Core::arr( $items ), 'ADD' === $verb ) );
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
	 * Every well-formed set in one arm call; an item TTL below one second, or
	 * a value that is no member map, leaves the set out. A failed call is
	 * re-sent set by set, except on an arm whose call lands whole or not at
	 * all, as a failed MSET batch is.
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
			$entry           = self::entry_key( $this->namespace, (string) $set_key );
			$sets[ $entry ]  = [ $item[0], $ttl ];
			$names[ $entry ] = (string) $set_key;
		}
		if ( $arm->add_members( $sets ) ) {
			return \array_values( $names );
		}
		if ( $arm->batch_is_atomic() ) {
			return [];
		}
		$landed = [];
		foreach ( $sets as $entry => $set ) {
			if ( $arm->add_members( [ $entry => $set ] ) ) {
				$landed[] = $names[ $entry ];
			}
		}
		return $landed;
	}

	/**
	 * `SMEMBERS <limit> <set_key>…`: one message per set holding a live
	 * member, KEY its set key, as MGET answers one per value: TM_STRUCT with a
	 * list of `[ member, value ]` pairs in member order, or, for a set holding
	 * more than `limit`, TM_BYTESTREAM `OVER <limit>` and no members; then the
	 * count. A limit that is not a whole number from 1 to MAX_MEMBERS_LIMIT
	 * is refused, and so is a backend that is not durable; a failed read
	 * answers one error.
	 *
	 * @param array<int,mixed> $request The TM_REQUEST.
	 * @param list<string>     $words   The limit, then set keys.
	 * @throws \RuntimeException With no wired sink to reply through.
	 */
	private function reply_members( array $request, array $words ): void {
		$limit = Core::canonical_decimal( \array_shift( $words ) ?? '', false );
		if ( null === $limit || $limit > self::MAX_MEMBERS_LIMIT ) {
			$this->refuse( $request, 'SMEMBERS', 'usage: SMEMBERS <limit> <set_key>…, limit a whole number from 1 to ' . self::MAX_MEMBERS_LIMIT );
			return;
		}
		if ( ! $this->arm instanceof Durable_Arm ) {
			$this->refuse( $request, 'SMEMBERS', $this->needs_durable() );
			return;
		}
		$set_keys = [];
		foreach ( $words as $set_key ) {
			$set_keys[ self::entry_key( $this->namespace, $set_key ) ] = $set_key;
		}
		$found = $this->arm->members( \array_keys( $set_keys ), $limit );
		if ( false === $found ) {
			$this->reply( $request, Message::TM_ERROR, '', "SMEMBERS: backend read failed\n" );
			return;
		}
		$count = 0;
		foreach ( $set_keys as $entry_key => $set_key ) {
			if ( ! \array_key_exists( $entry_key, $found ) ) {
				continue;
			}
			$members = $found[ $entry_key ];
			if ( null === $members ) {
				$this->reply( $request, Message::TM_BYTESTREAM, $set_key, self::OVER_LIMIT . " {$limit}\n" );
			} else {
				$pairs = [];
				foreach ( $members as $member => $stored ) {
					$pairs[] = [ (string) $member, $stored ];
				}
				$this->reply( $request, Message::TM_STRUCT, $set_key, $pairs );
			}
			++$count;
		}
		$this->reply( $request, Message::TM_INFO, '', "SMEMBERS {$count}\n" );
	}

	/**
	 * `GET`/`MGET`: what the store holds for `$keys`, a message per value then
	 * the count. An array answers TM_STRUCT; anything else answers its string
	 * under TM_BYTESTREAM.
	 *
	 * A read failed only when a key went unread: the cache did not answer and
	 * no backing looked at the misses. It answers one error instead.
	 *
	 * @param array<int,mixed> $request The TM_REQUEST.
	 * @param string           $verb    The verb answered.
	 * @param list<string>     $keys    Keys.
	 */
	private function reply_values( array $request, string $verb, array $keys ): void {
		$failed   = false;
		$answered = false;
		$found    = [] === $keys ? [] : $this->read_keys( $keys, $failed, $answered );
		if ( $failed && ! $answered ) {
			$this->reply( $request, Message::TM_ERROR, '', "{$verb}: backend read failed\n" );
			return;
		}
		foreach ( $found as $key => $stored ) {
			$key = (string) $key;
			if ( \is_array( $stored ) ) {
				$this->reply( $request, Message::TM_STRUCT, $key, $stored );
			} else {
				$this->reply( $request, Message::TM_BYTESTREAM, $key, Core::as_string( $stored, '' ) );
			}
		}
		$this->reply( $request, Message::TM_INFO, '', "{$verb} " . \count( $found ) . "\n" );
	}

	/**
	 * `MSET`/`ADD`: each item under its own TTL, or the Table's; an item TTL
	 * below one second leaves the item out. A failed MSET
	 * batch is re-sent key by key, except on an arm whose batch lands whole or
	 * not at all, where a retry would only wait out the same lock again.
	 *
	 * @param array<array-key,mixed> $items Key => [ value, ttl? ].
	 * @param bool                   $add   Write only where the key is absent.
	 * @return list<string> The keys the write took effect on.
	 */
	private function write_items( array $items, bool $add ): array {
		$arm = $this->arm();
		if ( null === $arm ) {
			return [];
		}
		$groups = [];
		foreach ( $items as $key => $item ) {
			$item = Core::arr( $item );
			$ttl  = $this->item_ttl( $item );
			if ( Cache_Backend::refuses_key( (string) $key ) || ! \array_key_exists( 0, $item ) || null === $ttl ) {
				$this->print_less_often( 'ERROR: refused a write item: ', (string) $key, ' needs a KEY without whitespace, a value, and a ttl in whole seconds, at least 1' );
				continue;
			}
			$groups[ $ttl ][] = [ (string) $key, $item[0] ];
		}
		$landed = [];
		foreach ( $groups as $ttl => $group ) {
			if ( ! $add ) {
				$entries = [];
				foreach ( $group as [ $key, $stored ] ) {
					$entries[ self::entry_key( $this->namespace, $key ) ] = $stored;
				}
				if ( $arm->write_multi( $entries, $ttl ) ) {
					\array_push( $landed, ...\array_column( $group, 0 ) );
					continue;
				}
				if ( $arm->batch_is_atomic() ) {
					continue;
				}
			}
			foreach ( $group as [ $key, $stored ] ) {
				$entry = self::entry_key( $this->namespace, $key );
				if ( $add ? $arm->add( $entry, $stored, $ttl ) : $arm->set( $entry, $stored, $ttl ) ) {
					$landed[] = $key;
				}
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
	 * `TOUCH <ttl> <keys…>`: the keys whose expiry moved. A ttl that is not
	 * whole seconds, at least 1, is refused rather than read as some other
	 * lifetime.
	 *
	 * @param array<int,mixed> $request The TM_REQUEST.
	 * @param list<string>     $words   The TTL, then keys.
	 * @throws \RuntimeException With no wired sink to reply through.
	 */
	private function reply_touch( array $request, array $words ): void {
		$ttl = Core::canonical_decimal( \array_shift( $words ) ?? '', false );
		if ( null === $ttl ) {
			$this->refuse( $request, 'TOUCH', 'usage: TOUCH <ttl> <key>…, ttl in whole seconds, at least 1' );
			return;
		}
		$arm     = $this->arm();
		$touched = null === $arm ? [] : \array_values( \array_filter( $words, fn ( string $key ): bool => true === $arm->touch( self::entry_key( $this->namespace, $key ), $ttl ) ) );
		$this->reply_written( $request, 'TOUCH', $touched );
	}

	/**
	 * `RM <keys…>`: the keys that were there to delete.
	 *
	 * @param list<string> $words Keys.
	 * @return list<string>
	 */
	private function remove_keys( array $words ): array {
		$arm = $this->arm();
		return null === $arm ? [] : \array_values( \array_filter( $words, fn ( string $key ): bool => true === $arm->delete( self::entry_key( $this->namespace, $key ) ) ) );
	}

	/**
	 * A write's reply: the verb and the keys it took effect on.
	 *
	 * @param array<int,mixed> $request The TM_REQUEST.
	 * @param string           $verb    The verb answered.
	 * @param list<string>     $keys    Keys.
	 */
	private function reply_written( array $request, string $verb, array $keys ): void {
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
	private function refuse( array $request, string $verb, string $why ): void {
		$shown = '' === $verb ? '(empty)' : \substr( $verb, 0, self::SHOWN_VERB_BYTES );
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
	private function reply( array $request, int $type, string $key, mixed $value ): void {
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
	 * Read many keys at once, returning only those found, under the caller's keys.
	 *
	 * One backend round trip for the whole set, so a caller resolving a set of
	 * ids pays one `getMulti` rather than N reads. Whatever the cache misses
	 * goes to the durable backing in one more call when one is installed.
	 *
	 * A cache read that fails reads as all-miss and still falls through, so
	 * `$failed` is how a caller merging onto the result learns that a key
	 * absent from it went unread rather than unstored. `$failed` is true when
	 * no cache backend answered the batch, whatever the backing then returned:
	 * event-logger-nodes 0.108.0 reads it as "the cache failed". The protocol's
	 * `MGET` says "a key went unread" instead, which a backing that answers
	 * clears.
	 *
	 * @api For consumers released before they moved to `MGET` (event-logger-nodes
	 *      0.108.0); removed once they floor at or above the release dropping it.
	 * @param list<string> $keys   Keys within the table's namespace.
	 * @param ?bool        $failed Set true when no cache backend answered.
	 * @param-out bool     $failed
	 * @return array<array-key,mixed> Values for the keys the cache or the
	 *                                backing held; an absent key is absent from
	 *                                the result, and an all-digit key is an int.
	 */
	public function lookup_multi( array $keys, ?bool &$failed = null ): array {
		return $this->read_keys( $keys, $failed );
	}

	/**
	 * Read many keys in one backend round trip, returning only those found,
	 * under the caller's keys; the misses go to the backing in one more call.
	 * A cache read that fails reads as all-miss and still falls through.
	 *
	 * @param list<string> $keys     Keys within the table's namespace.
	 * @param ?bool        $failed   Set true when no cache backend answered.
	 * @param ?bool        $answered Set true when a backing looked at the misses.
	 * @param-out bool     $failed
	 * @param-out bool     $answered
	 * @return array<array-key,mixed> Values for the keys the cache or the
	 *                                backing held; an absent key is absent from
	 *                                the result, and an all-digit key is an int.
	 */
	private function read_keys( array $keys, ?bool &$failed, ?bool &$answered = null ): array {
		$entry_keys = [];
		foreach ( $keys as $key ) {
			$entry_keys[ self::entry_key( $this->namespace, $key ) ] = $key;
		}
		$found   = [];
		$backend = $this->arm();
		$failed  = null === $backend;
		$fetched = $backend?->read_multi( \array_keys( $entry_keys ), $failed ) ?? [];
		foreach ( $fetched as $entry_key => $value ) {
			$found[ $entry_keys[ $entry_key ] ] = $value;
		}
		// ONE backing call for every miss; per-key defeats this round trip.
		$missed = [];
		foreach ( $keys as $key ) {
			if ( ! \array_key_exists( $key, $found ) ) {
				$missed[] = $key;
			}
		}
		return $found + $this->read_through( $missed, $answered );
	}

	/**
	 * Cross-process write — the mirror of lookup(), and the same divergence.
	 *
	 * `fill()` is the graph's way in, but the processes that own a table's
	 * contents are not always in a graph: a ruleset saved from wp-admin, a
	 * REST handler, a CLI command. Without this they each resolve the Table's
	 * arm and build `Table_Node::entry_key( … )` by hand, which puts the key
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
		$entry_key = self::entry_key( $this->namespace, $key );
		return true === $this->arm()?->set( $entry_key, $value, $this->ttl );
	}

	/**
	 * Store many entries in one backend round trip — `MGET`'s other half, for
	 * a writer whose cost is its KEY COUNT rather than its bytes.
	 *
	 * Whole-batch success only: neither backend reports per key. A caller that
	 * must know which key was refused re-sends the batch through `store()`.
	 *
	 * @api Batch writers (a stats flush merging many buckets at once).
	 * @param array<array-key,mixed> $items Key within the table's namespace =>
	 *                                      value. An all-digit key arrives as an
	 *                                      int; the cast takes it back.
	 * @return bool True when the whole set landed; true for an empty set.
	 */
	public function store_multi( array $items ): bool {
		if ( [] === $items ) {
			return true;
		}
		$entries = [];
		foreach ( $items as $key => $value ) {
			$entries[ self::entry_key( $this->namespace, (string) $key ) ] = $value;
		}
		return true === $this->arm()?->write_multi( $entries, $this->ttl );
	}

	/**
	 * Delete one entry. Verb-exposed (`rm <key>`).
	 *
	 * @param string $key Key within the table's namespace.
	 * @return string The verb's reply line, always `ok` — `forget()` cannot
	 *                report whether the entry was there to delete.
	 * @throws \RuntimeException On a mounted Table.
	 */
	public function rm( string $key ): string {
		$this->refuse_if_mounted( 'rm' );
		$this->forget( $key );
		return "ok\n";
	}

	/**
	 * Fold a value into the accumulator. In memory only — `store()` persists.
	 *
	 * @api Callers folding many updates into a value before persisting it.
	 * @param string $key   Key within the table's namespace.
	 * @param mixed  $value Value to hold.
	 * @throws \LogicException Without accumulator() first; dropping the value
	 *                         silently would lose whatever it counted.
	 */
	public function accumulate( string $key, mixed $value ): void {
		if ( null === $this->buffer ) {
			throw new \LogicException( 'Table::accumulate() needs accumulator() first' );
		}
		$this->buffer->set( self::entry_key( $this->namespace, $key ), $value );
	}

	/**
	 * The accumulating value for a key, or what is stored when none is held.
	 *
	 * The fallback is what makes a cold key resumable: an entry evicted, or never
	 * accumulated in this process, still folds onto what was last persisted.
	 *
	 * @api Callers reading the value they are still folding into.
	 * @param string $key Key within the table's namespace.
	 * @return mixed The held value, the stored one when nothing is held, or null
	 *               when neither tier has it.
	 */
	public function accumulated( string $key ): mixed {
		$held = $this->buffer?->get( self::entry_key( $this->namespace, $key ) );
		return null !== $held ? $held : $this->lookup( $key );
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
		$entry_key = self::entry_key( $this->namespace, $key );
		$backend   = $this->arm();
		// read() reports hit, miss and error; a null value alone cannot.
		$read = $backend?->read( $entry_key );
		if ( null !== $backend && Cache_Backend::READ_ERROR === ( $read['status'] ?? null ) ) {
			// Null reads as "empty table" downstream; say the backend broke.
			Core::print_less_often(
				'Table: backend read error for ',
				"{$this->namespace}:{$key}: ",
				$backend->last_failure()
			);
		}
		if ( Cache_Backend::READ_HIT !== ( $read['status'] ?? null ) ) {
			return $this->read_through( [ $key ] )[ $key ] ?? null;
		}
		return $read['value'];
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
	 * Walk what is held, keyed by the caller's key, for a drain.
	 *
	 * Draining does NOT clear: a caller that persists whole values is idempotent
	 * across drains, and clearing would discard accumulation between them.
	 *
	 * @api Drains persisting every held value at once.
	 * @return iterable<string,mixed> Held values, under the caller's keys.
	 */
	public function accumulating(): iterable {
		if ( null === $this->buffer ) {
			return;
		}
		$prefix = self::entry_key( $this->namespace, '' );
		foreach ( $this->buffer->iterate() as $entry_key => $value ) {
			yield \substr( (string) $entry_key, \strlen( $prefix ) ) => $value;
		}
	}

	/**
	 * Cross-process delete, for the same callers `store()` serves.
	 *
	 * @api Non-graph writers drop table entries without a live worker.
	 * @param string $key Key within the table's namespace.
	 */
	public function forget( string $key ): void {
		$entry_key = self::entry_key( $this->namespace, $key );
		$this->arm()?->delete( $entry_key );
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
				$groups[ $left ][ self::entry_key( $this->namespace, (string) $key ) ] = $entry['value'];
			}
		}
		foreach ( $groups as $ttl => $items ) {
			$this->arm()?->write_multi( $items, $ttl );
		}
	}

	/**
	 * Cross-process presence check that refreshes the entry, never fetching
	 * its value.
	 *
	 * The TTL is the call's, not the table's as in `store()`: a caller
	 * refreshing an entry dates it to its own window, as `read_through()`
	 * warms each entry for the lifetime it carries. It answers as
	 * `Cache_Backend::touch()` does, so a timeout never reads as eviction.
	 *
	 * On APCu the backend fetches and re-stores, so it reads the value
	 * after all and reverts a write landing between the two: safe only where
	 * one process owns the entry's writes, as the flame builder owns its
	 * partition's lists.
	 *
	 * @api Callers asking whether an entry still stands without reading it.
	 * @param string $key Key within the table's namespace.
	 * @param int    $ttl New expiry in seconds, at least 1.
	 * @return bool|null True when the entry existed and its expiry moved,
	 *                   false when it is confirmed absent, null when no
	 *                   backend is selected or the backend did not answer.
	 * @throws \InvalidArgumentException On a TTL below one second.
	 */
	public function touch( string $key, int $ttl ): ?bool {
		if ( $ttl < 1 ) {
			$this->refuse_ttl( (string) $ttl );
		}
		$entry_key = self::entry_key( $this->namespace, $key );
		return $this->arm()?->touch( $entry_key, $ttl );
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
	 * The declared Table this node answers for, else its own name.
	 *
	 * @return string The name a refusal gives.
	 */
	private function table_name(): string {
		return '' !== $this->table ? $this->table : $this->name;
	}

	/**
	 * The arm this call goes through: the named one, or `auto`'s choice now.
	 *
	 * @return Cache_Backend|null Null when `auto` finds no backend.
	 */
	private function arm(): ?Cache_Backend {
		return 'auto' === $this->backend ? Cache_Backend::shared_first() : $this->arm;
	}

	/**
	 * One partition of a declared Table, named `stem()`, sinking into `$sink`:
	 * how a request graph mounts a Table outside any topology load. The table
	 * and partition are set here because a web request binds no `<partition>`.
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
	 * The SQLite file of one partition of a declared Table.
	 *
	 * @param string $table     The declared Table.
	 * @param int    $partition The partition.
	 * @return string `{base}/tables/{table}.p{partition}.sqlite`.
	 * @throws \InvalidArgumentException On a name that cannot name a file.
	 */
	public static function file( string $table, int $partition ): string {
		return Bootstrap::base_dir() . '/tables/' . self::stem( $table, $partition ) . '.sqlite';
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
		if ( 1 !== \preg_match( '/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/D', $table ) || \str_contains( $table, '..' ) ) {
			throw new \InvalidArgumentException( "Table name {$table} cannot name a file" );
		}
		return "{$table}.p{$partition}";
	}

	/**
	 * Cache key for one entry. Site-scoped through Cache_Backend: a table is a
	 * cross-container source of truth for THIS install, and a co-tenant
	 * install's table of the same name is a different table.
	 *
	 * @api Callers reaching an entry through Cache_Backend directly.
	 * @param string $ns  Table namespace.
	 * @param string $key Key within that namespace.
	 * @return string The scoped key both tiers store the entry under.
	 */
	public static function entry_key( string $ns, string $key ): string {
		return Cache_Backend::site_key( "table:{$ns}:{$key}" );
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
		$arm = $this->arm instanceof Durable_Arm ? $this->arm : throw new \RuntimeException( \esc_html( "vacuum {$this->needs_durable()}" ) );
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
	 * Why a verb only a durable backend answers is refused here.
	 *
	 * @return string `needs a durable backend; <table> is <backend>`.
	 */
	private function needs_durable(): string {
		return "needs a durable backend; {$this->name} is {$this->backend}";
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
	 * Delete the rows expired at `$now` from every durable Table in this
	 * process's graph, at most once a `PURGE_INTERVAL_S` each: the Router
	 * tick's step. The Tables due share one deadline, PURGE_BACKLOG_BUDGET_S
	 * when any is behind and PURGE_BUDGET_S otherwise, so a tick holds the
	 * loop for one budget plus one batch a Table. A mount is skipped, since
	 * its declaring worker is the file's one writer.
	 *
	 * @param int $now The tick, in epoch seconds.
	 * @throws \Throwable What the purges threw, after the last.
	 */
	public static function purge_expired( int $now ): void {
		$due    = [];
		$behind = false;
		foreach ( Core::$nodes_by_name as $node ) {
			if ( $node instanceof self && ! $node->mounted && $node->arm instanceof Durable_Arm && $node->purge_due <= $now ) {
				$node->purge_due = $now + self::PURGE_INTERVAL_S;
				$due[]           = [ $node, $node->arm ];
				$behind          = $behind || $node->purge_behind;
			}
		}
		if ( [] === $due ) {
			return;
		}
		$until  = Core::right_now() + ( $behind ? self::PURGE_BACKLOG_BUDGET_S : self::PURGE_BUDGET_S );
		$purges = \array_map( static fn ( array $table ): \Closure => static fn () => $table[0]->purge_batches( $table[1], $now, $until ), $due );
		Worker_Should_Stop::raise( Worker_Should_Stop::attempt( ...$purges ) );
	}

	/**
	 * One Table's purge: a batch, repeated while each comes back full and the
	 * tick's deadline, read through `Core::right_now()`, has not passed; the
	 * rest waits a minute. A purge that stops with its last batch full leaves
	 * the Table behind, and says so; the first short batch catches it up. The
	 * deadline is checked between batches, so one statement blocked on the
	 * file's write lock can hold the tick for the arm's busy_timeout.
	 *
	 * @param Durable_Arm $arm   The Table's arm.
	 * @param int         $now   The tick, in epoch seconds.
	 * @param float       $until The tick's deadline, shared by every Table.
	 */
	private function purge_batches( Durable_Arm $arm, int $now, float $until ): void {
		$batches = 0;
		do {
			++$batches;
			$full = self::PURGE_BATCH_ROWS === $arm->purge( $now, self::PURGE_BATCH_ROWS );
		} while ( $full && Core::right_now() < $until );
		$this->purge_behind = $full;
		if ( $full ) {
			$this->print_less_often( 'WARNING: purge is behind: ', "its last batch came back full after {$batches} batches, " . $batches * self::PURGE_BATCH_ROWS . ' rows; the next purge spends its backlog budget' );
		}
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
	 * Opt in to an in-memory accumulator tier, and set its bounds.
	 *
	 * @api Callers folding many updates into a value before persisting it.
	 * @param int $bucket_size Entries per bucket before rotation; LRU_Cache
	 *                         clamps it to at least 1.
	 * @param int $num_buckets Buckets retained, clamped to 1..100; capacity is
	 *                         roughly the product.
	 * @return self For chaining off table().
	 */
	public function accumulator( int $bucket_size, int $num_buckets ): self {
		$this->buffer = new LRU_Cache( $bucket_size, $num_buckets );
		return $this;
	}

	/**
	 * Opt in to a durable system of record behind this table.
	 *
	 * A table is a CACHE of something when it has one: `lookup()`, `GET` and
	 * `MGET` fall through on a miss, store what comes back, and
	 * return it, so every caller reads one API and the durable tier is asked
	 * once per miss rather than once per caller.
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

	/** Drop everything the accumulator holds; a no-op without accumulator(). */
	public function reset(): void {
		$this->buffer?->flush();
	}

	/**
	 * A table outside any graph, for the callers `lookup()` / `store()` /
	 * `forget()` exist for. Sugar for `new Table_Node()` plus `arguments()`.
	 *
	 * Deliberately NOT memoized: an accumulator's lifetime belongs to whoever
	 * holds the table, and one rebuilt per call is empty every time — worse
	 * than none. Callers wanting one memoize it themselves, which is what keeps
	 * that lifetime visible at the call site instead of hidden in here.
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
		$table            = new self();
		$table->table     = $ns;
		$table->partition = 0;
		$table->arguments( [ $ns, (string) $ttl, $backend ] );
		return $table;
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
			'category'    => 'Storage',
			'description' => 'Keyed KEY→VALUE store; write-through fill, cross-process lookup().',
			'arguments'   => [
				[ 'name' => 'namespace', 'type' => 'string', 'required' => true, 'description' => 'Scopes keys; lookup() reads by it.' ],
				[ 'name' => 'ttl', 'type' => 'int', 'required' => true, 'description' => 'Entry TTL in seconds, at least 1; entries a write does not time take it.' ],
				[ 'name' => 'backend', 'type' => 'string', 'default' => 'auto', 'description' => 'auto, memcache, apcu, sqlite or wpdb; sqlite and wpdb are durable.' ],
			],
			'commands'    => [
				[
					'name'        => 'get',
					'action'      => true,
					'description' => 'Read one entry (JSON-encoded), or "null" when absent.',
					'args'        => [ [ 'name' => 'key', 'type' => 'string', 'required' => true ] ],
					'handler'     => static function ( Command_Interpreter_Node $interpreter, array $args ): string {
						$patron = $interpreter->patron();
						if ( ! $patron instanceof self ) {
							throw new \RuntimeException( 'no table patron' );
						}
						return (string) \wp_json_encode( $patron->lookup( Core::as_string( $args['key'] ) ) );
					},
				],
				[
					'name'        => 'rm',
					'action'      => true,
					'description' => 'Delete one entry.',
					'args'        => [ [ 'name' => 'key', 'type' => 'string', 'required' => true ] ],
					'handler'     => static function ( Command_Interpreter_Node $interpreter, array $args ): string {
						$patron = $interpreter->patron();
						return $patron instanceof self ? $patron->rm( Core::as_string( $args['key'] ) ) : throw new \RuntimeException( 'no table patron' );
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
			'requests'    => [
				[
					'name'        => 'GET',
					'description' => 'One stored value. Case-sensitive, as every verb is.',
					'args'        => [ [ 'name' => 'key', 'type' => 'string', 'required' => true ] ],
					'reply_shape' => self::READ_REPLY,
				],
				[
					'name'        => 'MGET',
					'description' => 'Many stored values in one read.',
					'args'        => [ [ 'name' => 'keys', 'type' => 'string', 'required' => true, 'description' => 'Whitespace-separated keys.' ] ],
					'reply_shape' => self::READ_REPLY,
				],
				[
					'name'        => 'SMEMBERS',
					'description' => 'Up to <limit> live members of each set, lowest member first, by an exact set-key seek; sqlite and wpdb alone hold members.',
					'args'        => [
						[ 'name' => 'limit', 'type' => 'int', 'required' => true, 'description' => 'Most members each set answers, from 1 to MAX_MEMBERS_LIMIT (10000).' ],
						[ 'name' => 'set_keys', 'type' => 'string', 'required' => true, 'description' => 'Whitespace-separated set keys.' ],
					],
					'reply_shape' => self::MEMBERS_REPLY,
				],
				[
					'name'        => 'TOUCH',
					'description' => 'Move each key\'s expiry to <ttl> seconds from now.',
					'args'        => [
						[ 'name' => 'ttl', 'type' => 'int', 'required' => true ],
						[ 'name' => 'keys', 'type' => 'string', 'required' => true ],
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
					'name'        => 'MSET',
					'description' => 'A TM_REQUEST|TM_STRUCT map of key => [ value, ttl ]; ttl defaults to the Table\'s.',
					'args'        => [],
					'reply_shape' => self::WRITE_REPLY,
				],
				[
					'name'        => 'ADD',
					'description' => 'A TM_REQUEST|TM_STRUCT map of key => [ value, ttl ], written only where absent.',
					'args'        => [],
					'reply_shape' => self::WRITE_REPLY,
				],
				[
					'name'        => 'SADD',
					'description' => 'A TM_REQUEST|TM_STRUCT map of set key => [ [ member => value, … ], ttl ]; each member upserted, ttl defaulting to the Table\'s. sqlite and wpdb alone hold members.',
					'args'        => [],
					'reply_shape' => self::WRITE_REPLY,
				],
			],
			'has_target'  => true,
		];
	}
}
