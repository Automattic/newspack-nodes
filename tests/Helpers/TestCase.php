<?php
namespace Newspack_Nodes\Tests;

use PHPUnit\Framework\TestCase as PHPUnitTestCase;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Topic_Node;
use Newspack_Nodes\Topology_Registry;

abstract class TestCase extends PHPUnitTestCase {
	/** @var array<int,string> Temp dirs created via make_temp_dir(), auto-removed in tearDown. */
	private array $temp_dirs = [];

	/**
	 * Snapshot of Core::$config_resolvers at setUp. Core::reset() deliberately
	 * leaves this process-lifetime registry (the bootstrap-registered `<config:>`
	 * token namespace lives here), so a test that wipes it to `[]` (instead of
	 * restoring) destroys `<config:...>` resolution for every later test. tearDown
	 * restores this snapshot so no test can leak the registry.
	 */
	private array $saved_config_resolvers = [];

	/**
	 * Snapshot of `make_node` class resolution — the registered namespaces and
	 * the resolved-class memo — restored in tearDown, so a test registering a
	 * fixture namespace leaks neither into a later test.
	 *
	 * @var array{namespaces: mixed, resolve_cache: mixed}|null
	 */
	private ?array $saved_resolution = null;

	/**
	 * Snapshot of the hook table at setUp, restored in tearDown. The shim's
	 * add_filter() only ever appends, and nothing defines remove_filter, so a
	 * per-test callback outlives its test: one FleetNodeTest filter that THROWS
	 * stayed on `newspack_nodes/topologies` and made every later test's
	 * expand_workers() raise, spawning nothing. Plugin-load registrations are
	 * inside the snapshot and survive; per-test ones do not.
	 *
	 * @var array<string, list<callable>>
	 */
	private array $saved_wp_actions = [];

	/** Root make_temp_dir() hands dirs out under, resolved once per test in setUp(). */
	private string $temp_root = '';

	/** Stock topology dir write_tsl() writes into, set by stock_topology_dir(). */
	private string $topology_dir = '';

	/**
	 * The `$wpdb` the process booted with, captured on the first setUp and
	 * restored in every tearDown, so a `$wpdb` one test installs — through
	 * use_wpdb(), or by hand and never put back — never reaches the next.
	 */
	protected static ?object $booted_wpdb = null;

	/**
	 * The `LOCAL_NEWSPACK_NODES_CONF` the process booted with, captured on the
	 * first setUp before any test can repoint it, and restored in every
	 * tearDown. A consumer suite extending this class booted with its own
	 * config, so restoring a fixed substrate file would move it onto the
	 * substrate's base directory and let its teardown delete that one's Tables.
	 */
	protected static ?string $booted_conf = null;

	protected function setUp(): void {
		self::$booted_conf ??= (string) \getenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		self::$booted_wpdb ??= $GLOBALS['wpdb'] ?? null;
		// Keep APCu pinned off so Memcached fixtures remain deterministic: tests
		// that seed Core::$memd must see their claims land there even when CLI
		// APCu is enabled.
		if ( \class_exists( '\\Newspack_Nodes\\Cache_Backend' ) ) {
			\Newspack_Nodes\Cache_Backend::$apcu_usable = static fn (): bool => false;
		}

		parent::setUp();
		// The bootstrap's ensure_runtime_wired() installs it before any test runs.
		if ( \class_exists( '\Newspack_Nodes\Worker_Base', false ) ) {
			\Newspack_Nodes\Worker_Base::$token_provider = null;
		}
		if ( \class_exists( '\Newspack_Nodes\Core' ) ) {
			Core::reset();
			// Snapshot the config-namespace registry (survives Core::reset) so
			// tearDown can restore it — a test that wipes it would otherwise break
			// `<config:...>` resolution for every later test.
			$this->saved_config_resolvers = Core::$config_resolvers;
			$this->saved_resolution       = [
				'namespaces'    => self::resolution( 'namespaces' )->getValue(),
				'resolve_cache' => self::resolution( 'resolve_cache' )->getValue(),
			];
			// Core's default stderr handler routes through PHP error_log(),
			// which the bootstrap redirects to /dev/null — no further swallow
			// needed here. Tests that need to assert on emitted text set their
			// own handler via Core::set_stderr_handler( ... ).
		}
		// Reset the stubbed WP-options store so option state set by a
		// previous test (dirty flag, fleet descriptors, etc.) doesn't
		// bleed into this one.
		$GLOBALS['_wp_options']         = [];
		$GLOBALS['_wp_option_autoload'] = [];
		$GLOBALS['_wp_cache_flushes']   = [];
		$this->saved_wp_actions         = $GLOBALS['_wp_actions'] ?? [];

		// Service_CI verbs are gated by default; start every test denied so a
		// cap granted in one test can't leak into another's deny-path. Classes
		// that need the cap grant it after parent::setUp().
		$GLOBALS['_wp_test_current_user_can'] = [];
		// No user is current until a test logs one in, as in a worker.
		unset( $GLOBALS['_wp_test_current_user_id'] );

		// Command_Auth's single-use nonce claim normally hits Core::$memd, which
		// isn't wired in unit tests. Install a fresh per-test in-memory claim so
		// the signed-command verifier path works (and replays within a test are
		// still rejected). Tests that specifically exercise the no-store fail-closed
		// path reset this to null themselves.
		if ( \class_exists( '\Newspack_Nodes\Command_Auth' ) ) {
			$seen                                       = [];
			\Newspack_Nodes\Command_Auth::$claim_nonce = static function ( string $nonce, int $ttl ) use ( &$seen ): bool {
				if ( isset( $seen[ $nonce ] ) ) {
					return false;
				}
				$seen[ $nonce ] = true;
				return true;
			};
		}

		// Authorization policy is static process state; clear it so a verifier
		// installed by one test (HTTP_In/worker bootstrap) doesn't gate the next.
		if ( \class_exists( '\Newspack_Nodes\Command_Interpreter_Node' ) ) {
			\Newspack_Nodes\Command_Interpreter_Node::$default_authorize = null;
			\Newspack_Nodes\Command_Interpreter_Node::$around_dispatch   = null;
		}

		// Log-source builtin seam is static process state; clear it likewise.
		if ( \class_exists( '\Newspack_Nodes\Log_Sources' ) ) {
			\Newspack_Nodes\Log_Sources::$builtin_sources = null;
		}

		// Bootstrap seams a class may set and not clear: a leaked spawn_coordinator_factory
		// (BootstrapTest binds one to /tmp) misdirects kill_readers' restart-flag
		// drops; a leaked fleet_enabled_override=false disables the fleet.
		if ( \class_exists( '\Newspack_Nodes\Bootstrap' ) ) {
			\Newspack_Nodes\Bootstrap::$spawn_coordinator_factory          = null;
			\Newspack_Nodes\Bootstrap::$fleet_enabled_override = null;
		}
		$this->reset_health_test_state();

		// Resolve the temp root HERE, not lazily in make_temp_dir(): reading the
		// base directory warms Config's cache, and a test that seeds options
		// first (BootstrapTest) would then never see them. Reset drops the warmth.
		$this->temp_root = $this->resolve_temp_root();
		if ( \class_exists( '\Newspack_Nodes\Config' ) ) {
			\Newspack_Nodes\Config::reset();
		}
	}

	/**
	 * The CONFIGURED base directory, or the substrate default when config can't
	 * answer: a consumer plugin's suite has its own base, and a hardcoded root
	 * would sit outside it — where storage nodes refuse to open.
	 */
	private function resolve_temp_root(): string {
		if ( \class_exists( '\\Newspack_Nodes\\Config' ) ) {
			try {
				$root = \Newspack_Nodes\Config::get_base_directory();
				if ( '' !== $root ) {
					return $root;
				}
			} catch ( \RuntimeException ) {
				// Unconfigured or refused base; fall through to the default.
			}
		}
		return (string) \getenv( 'NEWSPACK_TEST_BASE_DIR' );
	}

	/**
	 * One static of `make_node` class resolution, which tearDown restores.
	 *
	 * @param string $property `namespaces` or `resolve_cache`.
	 */
	private static function resolution( string $property ): \ReflectionProperty {
		return new \ReflectionProperty( \Newspack_Nodes\Command_Interpreter_Node::class, $property );
	}

	/** Remove every temp dir make_temp_dir() handed out — a temp dir is only temporary if someone deletes it. */
	protected function tearDown(): void {
		$GLOBALS['wpdb'] = self::$booted_wpdb;
		foreach ( $this->temp_dirs as $dir ) {
			$this->rmdir_recursive( $dir );
		}
		$this->temp_dirs = [];
		// Restore the config-namespace registry so a test that wiped it (e.g. to
		// exercise a missing-resolver path) can't strip the bootstrap `<config:>`
		// token namespace from every later test.
		if ( \class_exists( '\Newspack_Nodes\Core' ) ) {
			Core::$config_resolvers = $this->saved_config_resolvers;
		}
		foreach ( $this->saved_resolution ?? [] as $property => $value ) {
			self::resolution( $property )->setValue( null, $value );
		}
		// A direct Command_Auth::verify() installs a capability ceiling that
		// only interpret() restores; a test calling it raw would otherwise
		// leave every later test's Capabilities::can() answering false.
		if ( \class_exists( '\Newspack_Nodes\Capabilities' ) ) {
			\Newspack_Nodes\Capabilities::$session_scope = null;
		}
		// A remembered session outlives its test and signs the next one's probes.
		if ( \class_exists( '\Newspack_Nodes\Command_Auth', false ) ) {
			( new \ReflectionProperty( \Newspack_Nodes\Command_Auth::class, 'sessions' ) )->setValue( null, [] );
			// The memoized session Tables would carry a closed test's arms onward.
			( new \ReflectionProperty( \Newspack_Nodes\Command_Auth::class, 'table' ) )->setValue( null, null );
			( new \ReflectionProperty( \Newspack_Nodes\Command_Auth::class, 'reader' ) )->setValue( null, null );
		}
		if ( isset( $GLOBALS['_wp_actions'] ) ) {
			$GLOBALS['_wp_actions'] = $this->saved_wp_actions;
		}
		// Worker_Base seams a fixture (e.g. FatalProbeWorker) may have pinned —
		// including the token provider ensure_runtime_wired installs globally.
		if ( \class_exists( '\Newspack_Nodes\Worker_Base', false ) ) {
			\Newspack_Nodes\Worker_Base::$last_error     = null;
			\Newspack_Nodes\Worker_Base::$db_probe       = null;
			\Newspack_Nodes\Worker_Base::$token_provider = null;
		}
		// A leaked fwrite seam would silently corrupt every later write test.
		if ( \class_exists( '\Newspack_Nodes\Partition_Node', false ) ) {
			\Newspack_Nodes\Partition_Node::$fwrite = null;
		}
		// @longform The four SSE slot seams, cleared HERE because five classes
		// each hand-rolled their own reset and the one that didn't — WorkersCITest,
		// which calls SSE_Slot_Pool::wire() — leaked the PRODUCTION closures into
		// SSEOutTest. There they met the UNMETERED_LEASE the null acquire seam
		// hands back, whose slot is -1, and require_lease threw. Order-dependent:
		// green whenever a class that does reset happened to run in between.
		if ( \class_exists( '\Newspack_Nodes\Rest\SSE_Out_Node', false ) ) {
			\Newspack_Nodes\Rest\SSE_Out_Node::$acquire_slot  = null;
			\Newspack_Nodes\Rest\SSE_Out_Node::$release_slot  = null;
			\Newspack_Nodes\Rest\SSE_Out_Node::$check_slot    = null;
			\Newspack_Nodes\Rest\SSE_Out_Node::$inspect_slot  = null;
			\Newspack_Nodes\Rest\SSE_Out_Node::$diagnostic_log = null;
			\Newspack_Nodes\Rest\SSE_Out_Node::$on_shutdown    = null;
		}
		// Restore the per-test config env that use_base_dir() may have repointed at a
		// (now-deleted) temp config, and drop Config's memoized base/dirs. Otherwise a
		// test that called use_base_dir() leaks its base_directory into a later test
		// that doesn't — surfacing as wrong/empty partition + lock-dir resolution
		// (order-dependent CLI failures). The value is the one the process booted with.
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . self::$booted_conf );
		if ( \class_exists( '\Newspack_Nodes\Config' ) ) {
			\Newspack_Nodes\Config::reset();
		}
		if ( \class_exists( '\Newspack_Nodes\CLI', false ) ) {
			// @longform A leaked root uid makes Config::write_denied() true, so
			// Lock_Node::request_restart_at() throws instead of writing — every
			// restart-flag test downstream of LockNodeRootTest then fails, and
			// only in the orders where it happens to run first.
			\Newspack_Nodes\CLI::$uid_provider = null;
		}
		if ( \class_exists( '\Newspack_Nodes\Lock_Node', false ) ) {
			\Newspack_Nodes\Lock_Node::$put_contents = null;
			\Newspack_Nodes\Lock_Node::$rmdir        = null;
		}
		// A leaked fake clock would freeze every later test on loop time.
		if ( \class_exists( '\Newspack_Nodes\Core', false ) ) {
			Core::$clock = null;
		}
		if ( \class_exists( '\Newspack_Nodes\Event_Framework', false ) ) {
			\Newspack_Nodes\Event_Framework::$sleep         = null;
			\Newspack_Nodes\Event_Framework::$curl_dispatch = null;
			\Newspack_Nodes\Event_Framework::$curl_pause    = null;
			\Newspack_Nodes\Event_Framework::$curl_poll     = null;
			\Newspack_Nodes\HTTP_Out_Node::$curl_result     = null;
			\Newspack_Nodes\Curl_Node::$curl_result         = null;
		}
		$this->reset_health_test_state();
		parent::tearDown();
	}

	/** Clear health-report seams and restore the default single-site posture. */
	private function reset_health_test_state(): void {
		if ( \class_exists( '\Newspack_Nodes\Health_Checks' ) ) {
			\Newspack_Nodes\Health_Checks::$remove_probe    = null;
			\Newspack_Nodes\Health_Checks::$evaluate_alerts = null;
		}
		if ( \class_exists( '\Newspack_Nodes\Health_Probe_Client' ) ) {
			\Newspack_Nodes\Health_Probe_Client::$http_call = null;
			\Newspack_Nodes\Health_Probe_Client::$clock     = null;
		}
		if ( \class_exists( '\Newspack_Nodes\Rest\Health_Runtime_Controller' ) ) {
			\Newspack_Nodes\Rest\Health_Runtime_Controller::$clock = null;
		}
		if ( \class_exists( '\Newspack_Nodes\Bootstrap' ) ) {
			\Newspack_Nodes\Bootstrap::$health_report_evaluator = null;
		}
		$GLOBALS['_wp_test_is_multisite'] = false;
		$GLOBALS['_wp_test_is_main_site'] = true;
	}

	/**
	 * Seed the Vault option as `add()` would write it: every non-empty password
	 * sealed. `get_all()` reads an unsealed option value as planted, so a test
	 * that writes the option directly has to seal the way the plugin does.
	 *
	 * @param array<string,array<string,mixed>> $servers `id => entry` map.
	 */
	protected function seed_vault_servers( array $servers ): void {
		$seal = new \ReflectionMethod( \Newspack_Nodes\Vault::class, 'encrypt' );
		$seal->setAccessible( true );
		foreach ( $servers as &$entry ) {
			if ( '' !== ( $entry['auth_password'] ?? '' ) ) {
				$entry['auth_password'] = $seal->invoke( null, $entry['auth_password'] );
			}
		}
		unset( $entry );
		// Non-autoloaded, as `Vault::write_option()` stores it.
		\update_option( \Newspack_Nodes\Vault::OPTION_KEY, $servers, false );
		\Newspack_Nodes\Vault::get_instance()->reset_cache();
	}

	/** One server, through `seed_vault_servers()`. */
	protected function seed_vault( string $id, array $entry ): void {
		$this->seed_vault_servers( [ $id => $entry ] );
	}

	/** An egress named independently of its vault id, as the live hub graph is. */
	protected function egress( string $node_name, string $vault_id ): \Newspack_Nodes\HTTP_Out_Node {
		$node = new \Newspack_Nodes\HTTP_Out_Node();
		$node->name( $node_name );
		$node->arguments( [ $vault_id ] );
		return $node;
	}

	/**
	 * A scratch dir INSIDE the runtime base, auto-removed in tearDown.
	 *
	 * Inside, not beside: storage nodes refuse a path outside the runtime tree,
	 * and a sibling is outside. Tests that repoint base_directory at their own
	 * temp dir stay contained either way.
	 */
	protected function make_temp_dir( string $prefix = 'newspack-nodes-test-' ): string {
		// PID + more-entropy uniqid: bare uniqid() is microtime-based and collides
		// across PARALLEL processes (run-coverage runs nodes/ELN/pyrobase at once),
		// which let two suites share one temp dir + its `/tmp/locks` rotate lock —
		// a real cross-process flake. PID guarantees inter-process uniqueness.
		$root = '' !== $this->temp_root ? $this->temp_root : $this->resolve_temp_root();
		if ( ! \is_dir( $root ) ) {
			\mkdir( $root, 0700, true );
		}
		$dir = $root . '/' . $prefix . \getmypid() . '-' . \uniqid( '', true );
		\mkdir( $dir, 0700, true );
		// Register for teardown; without this the loop there is dead code and
		// every call in the suite leaks a directory under the runtime base.
		$this->temp_dirs[] = $dir;
		return $dir;
	}

	/**
	 * A temp dir registered as the stock topology dir write_tsl() writes into.
	 *
	 * @param string $prefix Temp dir name prefix.
	 * @return string The dir.
	 */
	protected function stock_topology_dir( string $prefix ): string {
		$this->topology_dir = $this->make_temp_dir( $prefix );
		Topology_Registry::register_stock_dir( $this->topology_dir );
		return $this->topology_dir;
	}

	/**
	 * Write `<name>.tsl` into the stock_topology_dir(). The parsed caches are
	 * left alone, so a test proving they memoize can rewrite a file under them.
	 *
	 * @param string $name     Topology name.
	 * @param string $contents TSL body.
	 */
	protected function write_tsl( string $name, string $contents ): void {
		if ( '' === $this->topology_dir ) {
			throw new \LogicException( 'call stock_topology_dir() first' );
		}
		\file_put_contents( "{$this->topology_dir}/{$name}.tsl", $contents );
	}

	/**
	 * Install a fresh in-memory `$wpdb` for this test, which a `wpdb` Table and
	 * the command-session store write through; tearDown puts the booted one
	 * back.
	 */
	protected function use_wpdb(): Helpers\Sqlite_Wpdb {
		return $GLOBALS['wpdb'] = new Helpers\Sqlite_Wpdb();
	}

	/**
	 * `use_wpdb()`, with `sessions_backend` set to `wpdb`, so the command
	 * sessions this test mints go through the fresh `$wpdb` it returns.
	 */
	protected function use_wpdb_sessions(): Helpers\Sqlite_Wpdb {
		$GLOBALS['_wp_options']['newspack_nodes_sessions_backend'] = 'wpdb';
		\Newspack_Nodes\Config::reset();
		return $this->use_wpdb();
	}

	/**
	 * Store `$items` in `$table` at its own TTL in one call to its arm, one
	 * transaction on SQLite, so a test seeds thousands of rows in time.
	 *
	 * Reflection, because no public path writes a batch: `store()`, `ADD` and
	 * a keyed INSERT each commit one key, and the purge tests seed 10,001 to
	 * 60,003 rows, which per-key commits cannot write inside a test's budget.
	 * It reaches the Table's own `arm()`, `key()` and `ttl`, so the rows land
	 * exactly as the Table would store them.
	 *
	 * @param array<array-key,mixed> $items Key => value.
	 */
	protected static function seed_table( \Newspack_Nodes\Table_Node $table, array $items ): void {
		$arm = ( new \ReflectionMethod( $table, 'arm' ) )->invoke( $table );
		self::assertInstanceOf( \Newspack_Nodes\Cache_Backend::class, $arm, 'seed_table() needs a Table whose backend answers' );
		$key     = new \ReflectionMethod( $table, 'key' );
		$entries = [];
		foreach ( $items as $item => $value ) {
			$entries[ $key->invoke( $table, (string) $item ) ] = $value;
		}
		self::assertTrue( $arm->write_multi( $entries, ( new \ReflectionProperty( $table, 'ttl' ) )->getValue( $table ) ) );
	}

	/**
	 * Point Config at a temp config file under $dir so that
	 * `Config::load_config()['base_directory']` returns $dir for the rest of
	 * this test, through `LOCAL_NEWSPACK_NODES_CONF` pointing at a per-test
	 * config file.
	 */
	protected function use_base_dir( string $dir, array $extras = [] ): void {
		$config = \array_merge( [ 'base_directory' => $dir ], $extras );
		$conf   = $dir . '/test-config.php';
		\file_put_contents(
			$conf,
			"<?php\nreturn " . \var_export( $config, true ) . ";\n"
		);
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $conf );
		if ( \class_exists( '\\Newspack_Nodes\\Config' ) ) {
			\Newspack_Nodes\Config::reset();
		}
	}

	/**
	 * Point Config at a base directory that cannot exist, because its parent
	 * is a regular file, as a misconfigured install's base does.
	 *
	 * @param string $prefix Temp dir prefix.
	 * @return array{0: string, 1: string} The temp dir to remove, and the base.
	 */
	protected function use_uncreatable_base_dir( string $prefix ): array {
		$dir     = $this->make_temp_dir( $prefix );
		$blocker = "{$dir}/blocker";
		\touch( $blocker );
		$this->use_base_dir( $dir );
		\file_put_contents( "{$dir}/test-config.php", "<?php\nreturn [ 'base_directory' => '{$blocker}/runtime-7713' ];\n" );
		\Newspack_Nodes\Config::reset();
		return [ $dir, "{$blocker}/runtime-7713" ];
	}

	protected function rmdir_recursive( string $dir ): void {
		if ( ! \is_dir( $dir ) ) {
			return;
		}
		foreach ( \scandir( $dir ) as $f ) {
			if ( '.' === $f || '..' === $f ) {
				continue;
			}
			$path = "$dir/$f";
			// A symlink is unlinked, never followed out of the tree.
			! \is_link( $path ) && \is_dir( $path ) ? $this->rmdir_recursive( $path ) : @\unlink( $path );
		}
		@\rmdir( $dir );
	}

	protected function boundedTicks( int $n ): callable {
		return \Newspack_Nodes\Tests\BoundedTicks::callable( $n );
	}

	/**
	 * Run every drain in this test on loop time: a wait advances
	 * `Core::$clock` instead of blocking, so an idle window, a heartbeat gap or
	 * a timer interval costs no wall time. The clock is the wall plus what the
	 * loop has slept, so it never runs behind a file mtime. tearDown() restores
	 * both seams.
	 */
	protected function use_loop_time(): void {
		$slept                                 = 0.0;
		Core::$clock                           = static function () use ( &$slept ): float {
			return \microtime( true ) + $slept;
		};
		\Newspack_Nodes\Event_Framework::$sleep = static function ( int $microseconds ) use ( &$slept ): void {
			$slept += $microseconds / 1_000_000;
		};
	}

	/**
	 * Run $fn and return the RuntimeException it threw; fail with $why if none.
	 *
	 * Replaces `try { …; $this->fail(); } catch ( \RuntimeException $e )`: in
	 * PHPUnit 10 `fail()` throws AssertionFailedError, itself a
	 * RuntimeException, so that idiom catches its own failure and passes when
	 * the call stops throwing. Here `fail()` sits outside the try, and PHPUnit's
	 * own exceptions — a failed assertion, the per-test time limit — escape.
	 *
	 * @param callable $fn  The call expected to throw.
	 * @param string   $why Failure message when it throws nothing.
	 */
	protected function caught( callable $fn, string $why ): \RuntimeException {
		try {
			$fn();
		} catch ( \PHPUnit\Exception | \SebastianBergmann\Invoker\Exception $e ) {
			throw $e;
		} catch ( \RuntimeException $e ) {
			return $e;
		}
		$this->fail( $why );
	}

	/**
	 * Build a TM_BYTESTREAM Message wrapping $value (and optional $key).
	 * A Partition takes writes only through `$p->fill(...)`, in the canonical
	 * packed wire format.
	 *
	 * Returned via a local variable so callers can pass it straight into
	 * `fill( array $message )` without tripping PHP's "Only variables should
	 * be passed by reference" notice.
	 */
	protected function produce( string $value, string $key = '' ): array {
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$message[ Message::TIMESTAMP ] = Core::$now;
		$message[ Message::KEY ]       = $key;
		$message[ Message::VALUE ]     = $value;
		return $message;
	}

	/**
	 * Build + fill in one call. Avoids the by-ref notice that fires when a
	 * function-call result is passed directly into a `fill( $message )` parameter.
	 *
	 * @param object $node Anything with a fill() method (Partition, Topic, etc.).
	 */
	protected function produce_into( object $node, string $value, string $key = '' ): void {
		$node->fill( $this->produce( $value, $key ) );
		// Tests assert on disk state immediately after — force the Partition
		// to drain its in-memory batch so the next file_get_contents/read_at
		// call sees the bytes. Production callers rely on size-threshold +
		// __destruct flush; tests can't wait for either.
		if ( \method_exists( $node, 'flush' ) ) {
			$node->flush();
		}
	}

	/**
	 * One SSE event as `SSE_Out_Node` frames it: the named event carrying a
	 * packed Message, `$fields` set over a fresh envelope by Message index.
	 *
	 * @param array<int,mixed> $fields Message fields, keyed by `Message::*` index.
	 */
	protected static function sse_frame( string $event, array $fields ): string {
		return "event: {$event}\ndata: " . Message::packed( \array_replace( Message::new_message(), $fields ) ) . "\n\n";
	}

	/** A `msg` SSE frame: one delivered record. */
	protected static function msg_frame( string $id, string $key, mixed $value ): string {
		return self::sse_frame( 'msg', [ Message::TYPE => Message::TM_STRUCT, Message::ID => $id, Message::KEY => $key, Message::VALUE => $value ] );
	}

	/** A `connected` SSE frame carrying the flat handshake envelope. */
	protected static function connected_frame( mixed $value ): string {
		return self::sse_frame( 'connected', [ Message::TYPE => Message::TM_INFO, Message::KEY => 'connected', Message::VALUE => $value ] );
	}

	/** A `heartbeat` SSE frame carrying the spoke's wall seconds. */
	protected static function heartbeat_frame( string $value ): string {
		return self::sse_frame( 'heartbeat', [ Message::TYPE => Message::TM_INFO, Message::KEY => 'heartbeat', Message::VALUE => $value ] );
	}

	/**
	 * A raw block as a stream's reader sends it: its header, then its bytes,
	 * both stamped FROM the stream. A `sources:` stamp names a Tail, whose
	 * lines are text.
	 *
	 * @param string   $stamp    The stream the block belongs to.
	 * @param string   $at       Where it begins, `segment:offset`.
	 * @param string   $bytes    The raw bytes.
	 * @param int|null $distance What the log holds from `$at`; the bytes' own length when null.
	 * @return array{0:array<int,mixed>,1:array<int,mixed>} The header, then the batch.
	 */
	protected static function block_of( string $stamp, string $at, string $bytes, ?int $distance = null ): array {
		[ $segment, $offset ] = \array_map( 'intval', \explode( ':', $at ) );
		$messages             = \Newspack_Nodes\Consumer_Node::block_messages( [
			'bytes'    => $bytes,
			'segment'  => $segment,
			'offset'   => $offset,
			'distance' => $distance ?? \strlen( $bytes ),
			'reset'    => false,
		] );
		$messages[0][ Message::FROM ] = $stamp;
		$messages[1][ Message::FROM ] = $stamp;
		return $messages;
	}

	/**
	 * The two `batch` SSE frames `block_of()`'s block travels in.
	 *
	 * @param string   $stamp    The stream the block belongs to.
	 * @param string   $at       Where it begins, `segment:offset`.
	 * @param string   $bytes    The raw bytes.
	 * @param int|null $distance What the log holds from `$at`; the bytes' own length when null.
	 */
	protected static function block_frames( string $stamp, string $at, string $bytes, ?int $distance = null ): string {
		return \implode( '', \array_map( static fn ( array $m ): string => self::sse_frame( 'msg', $m ), self::block_of( $stamp, $at, $bytes, $distance ) ) );
	}

	/**
	 * One record in a raw block where its `segment:offset:length` ID places
	 * it. The block holds the line the spoke's log does: FROM less the
	 * stream's stamp, which the hub restores, no ID, and padded with the
	 * trailing blanks JSON allows to the crumb's length.
	 *
	 * @param array<int,mixed> $fields Message fields, keyed by `Message::*` index; ID the crumb.
	 * @param string           $stamp  The stream it belongs to.
	 * @return array{0:array<int,mixed>,1:array<int,mixed>} The header, then the batch.
	 * @throws \LogicException When the crumb is too short to hold the record.
	 */
	protected static function record_block( array $fields, string $stamp = 'firehose.p0' ): array {
		$record = \array_replace( Message::new_message(), $fields );
		[ $segment, $offset, $length ] = \array_map( 'intval', \explode( ':', Core::as_string( $record[ Message::ID ] ) ) );
		$from                          = Core::as_string( $record[ Message::FROM ] );
		$record[ Message::FROM ]       = \str_starts_with( $from, "{$stamp}/" ) ? \substr( $from, \strlen( $stamp ) + 1 ) : ( $stamp === $from ? '' : $from );
		$record[ Message::ID ]         = '';
		$record[ Message::TIMESTAMP ]  = 0;
		$line                          = Message::packed( $record );
		if ( \strlen( $line ) + 1 > $length ) {
			throw new \LogicException( "a {$length}-byte crumb cannot hold a " . ( \strlen( $line ) + 1 ) . '-byte record' );
		}
		return self::block_of( $stamp, "{$segment}:{$offset}", \str_pad( $line, $length - 1 ) . "\n" );
	}

	/**
	 * `record_block()` as the SSE frames a stream pushes it in.
	 *
	 * @param array<int,mixed> $fields Message fields, keyed by `Message::*` index; ID the crumb.
	 * @param string           $stamp  The stream it belongs to.
	 */
	protected static function pushed_record( array $fields, string $stamp = 'firehose.p0' ): string {
		return \implode( '', \array_map( static fn ( array $m ): string => self::sse_frame( 'msg', $m ), self::record_block( $fields, $stamp ) ) );
	}

	/**
	 * Fill a reader `record_block()`'s block directly, as its broker would.
	 *
	 * @param \Newspack_Nodes\Remote_Consumer_Node $reader The reader.
	 * @param array<int,mixed>                     $fields Message fields; ID the crumb.
	 */
	protected static function push_record( \Newspack_Nodes\Remote_Consumer_Node $reader, array $fields ): void {
		foreach ( self::record_block( $fields, $reader->stamp() ) as $m ) {
			$reader->fill( $m );
		}
	}

	/** The records a Partition dir holds across its segments: one per non-empty line. */
	protected function count_log_records( string $dir ): int {
		$count = 0;
		foreach ( (array) \glob( "{$dir}/*.log" ) as $path ) {
			foreach ( \explode( "\n", (string) \file_get_contents( (string) $path ) ) as $line ) {
				if ( '' !== $line ) {
					++$count;
				}
			}
		}
		return $count;
	}

	/**
	 * One record as its log holds it: packed, newline included.
	 *
	 * @param array<int,mixed> $fields Message fields, keyed by `Message::*` index.
	 */
	protected static function record_line( array $fields ): string {
		return Message::packed( \array_replace( Message::new_message(), $fields ) ) . "\n";
	}

	/** A `retry` SSE frame carrying the reopen delay in milliseconds. */
	protected static function retry_frame( string $ms ): string {
		return self::sse_frame( 'retry', [ Message::TYPE => Message::TM_INFO, Message::KEY => 'retry', Message::VALUE => $ms ] );
	}

	/** Push an exact slot lease into an SSE_In through its `connected` parser. */
	protected static function set_slot( \Newspack_Nodes\SSE_In_Node $sse, int $slot, int $owner = 42424243 ): void {
		$sse->process_sse_chunk( self::connected_frame( "SLOT {$slot} OWNER {$owner}" ) );
	}

	/** A terminal `disconnect` SSE frame. */
	protected static function disconnect_frame( string $key, string $value ): string {
		return self::sse_frame( 'disconnect', [ Message::TYPE => Message::TM_ERROR, Message::KEY => $key, Message::VALUE => $value ] );
	}

	/**
	 * Read a Partition's segment contents and return the unpacked VALUE
	 * strings. Each line in the segment is a packed Tachikoma Message; this
	 * returns the VALUEs in order.
	 *
	 * @return array<int,mixed>
	 */
	protected function read_partition_values( Partition_Node $p, int $segment_id = 0 ): array {
		// Tests typically write via `$p->fill()` or `produce_into()` and then
		// immediately read the segment file. Flush any pending batch first so
		// the read picks up the data — Partition::fill batches in memory and
		// only syswrites at the PIPE_BUF threshold, a flush or teardown.
		$p->flush();
		$path = "{$p->partition_dir()}/{$segment_id}.log";
		if ( ! \file_exists( $path ) ) {
			return [];
		}
		$bytes = (string) \file_get_contents( $path );
		$lines = \array_filter( \explode( "\n", $bytes ), static fn ( $l ) => '' !== $l );
		$out   = [];
		foreach ( $lines as $line ) {
			$message   = Message::unpacked( $line );
			$out[] = $message[ Message::VALUE ];
		}
		return $out;
	}

	/**
	 * Drive a Consumer to a fully-drained, caught-up steady state. A Consumer
	 * reads ONE block per poll and emits the PRIOR block (Tachikoma fire()'s
	 * drain-then-get_batch), so consuming the data present at start takes several
	 * polls and segment advance is one step per poll. Stops once caught up with
	 * no complete line left to drain.
	 */
	/**
	 * Register a job handler the way production does — via the
	 * `newspack_nodes/{job,remote_job}_handlers` filter — then reload the
	 * worker's maps, so tests exercise the real load path rather than a
	 * test-only setter.
	 */
	protected function register_job_handler( \Newspack_Nodes\Job_Worker_Node $jw, string $name, callable $cb, bool $remote = false ): void {
		$hook = $remote ? 'newspack_nodes/remote_job_handlers' : 'newspack_nodes/job_handlers';
		\add_filter(
			$hook,
			static function ( $handlers ) use ( $name, $cb ) {
				$handlers[ $name ] = $cb;
				return $handlers;
			}
		);
		$jw->load_handlers_from_filters();
	}

	/** Collect every stderr line the test raises from here on; `Core::reset()` restores the handler. */
	protected function capture_stderr(): \ArrayObject {
		$errors = new \ArrayObject();
		Core::set_stderr_handler( static function ( string $text ) use ( $errors ): void {
			$errors[] = $text;
		} );
		return $errors;
	}

	/**
	 * The captured stderr lines containing `$needle`, each with its process
	 * label (`<host> <process>[<pid>][<n>s]: `) cut off and its newline trimmed.
	 *
	 * @param \ArrayObject<int,string> $captured What `capture_stderr()` collected.
	 * @param string                   $needle   Text a kept line contains; '' keeps every line.
	 * @return list<string>
	 */
	protected static function stderr_lines( \ArrayObject $captured, string $needle = '' ): array {
		$out = [];
		foreach ( $captured as $line ) {
			$line = \rtrim( (string) \preg_replace( '/^.*?\[\d+\]\[\d+s\]: /s', '', $line, 1 ) );
			if ( '' === $needle || \str_contains( $line, $needle ) ) {
				$out[] = $line;
			}
		}
		return $out;
	}

	/** `<message> (<file>:<line>)`, as `Worker_Should_Stop::report()` spells one throwable. */
	protected static function cause_text( \Throwable $e ): string {
		return $e->getMessage() . ' (' . $e->getFile() . ':' . $e->getLine() . ')';
	}

	/**
	 * Replay every `command_node <name>:config <verb> …` line of a dump onto
	 * $into's own `:config`, in order, tokenized as the Shell reads a line.
	 *
	 * @param string            $dump A `dump_config()` answer.
	 * @param \Newspack_Nodes\Node $into The node the commands reach.
	 */
	protected function replay_config( string $dump, \Newspack_Nodes\Node $into ): void {
		$shell = new \Newspack_Nodes\Shell_Node();
		foreach ( \explode( "\n", $dump ) as $line ) {
			$tokens = $shell->tokenize( $line );
			if ( 'command_node' !== ( $tokens[0] ?? '' ) || ! \str_ends_with( $tokens[1] ?? '', ':config' ) ) {
				continue;
			}
			$into->interpreter()->dispatch( $tokens[2], \array_slice( $tokens, 3 ) );
		}
	}

	/** Read a private/protected property — these nodes expose internal state to tests via reflection, not getters. */
	protected function read_private( object $obj, string $prop ): mixed {
		$ref = new \ReflectionProperty( $obj, $prop );
		return $ref->getValue( $obj );
	}

	/**
	 * Hand the shared multi one completion row for $easy, through the real
	 * owner lookup, dispatch and release, without a network transfer.
	 */
	protected function complete_curl( \CurlHandle $easy, int $result = \CURLE_OK, int $msg = \CURLMSG_DONE ): void {
		$this->deliver_curl_rows( [ [ 'msg' => $msg, 'handle' => $easy, 'result' => $result ] ] );
	}

	/**
	 * Feed the shared multi these `curl_multi_info_read` rows and run its
	 * completion pass once, as a drain tick does.
	 *
	 * @param list<array<string,mixed>> $rows The rows the poll reports.
	 */
	protected function deliver_curl_rows( array $rows ): void {
		\Newspack_Nodes\Event_Framework::$curl_poll = static fn ( \CurlMultiHandle $m ): array => $rows;
		try {
			( new \ReflectionMethod( \Newspack_Nodes\Event_Framework::class, 'drain_curl_multi' ) )
				->invoke( \Newspack_Nodes\Event_Framework::instance() );
		} finally {
			\Newspack_Nodes\Event_Framework::$curl_poll = null;
		}
	}

	/** Worker's private executed-job counter (increments even when a handler throws; no public accessor by design). */
	protected function jobs_executed( \Newspack_Nodes\Job_Worker_Node $jw ): int {
		return (int) $this->read_private( $jw, 'jobs_executed' );
	}

	/**
	 * Run $work inside a worker's drain whose deadline has already passed, as
	 * a long job finds itself when the lock is flagged mid-fill: every
	 * `Event_Framework::stop_check()` it reaches, and every `pump()` past the
	 * throttle, raises.
	 *
	 * @param \Closure(): void $work What runs mid-work.
	 * @return \Newspack_Nodes\Worker_Should_Stop|null The stop that escaped the drain, if any.
	 */
	protected function with_stop_due( \Closure $work ): ?\Newspack_Nodes\Worker_Should_Stop {
		$state = (object) [ 'stop' => false, 'ticks' => 0 ];
		$timer = new class() extends \Newspack_Nodes\Timer_Node {
			/** @var \Closure(): void */
			public \Closure $on_fire;
			public function fire_cb(): void {
				( $this->on_fire )();
			}
		};
		$timer->on_fire = static function () use ( $state, $work ): void {
			$state->stop = true;
			$work();
		};
		$timer->set_timer( 1, true );
		try {
			\Newspack_Nodes\Event_Framework::instance()->drain(
				static fn (): bool => ! $state->stop && ++$state->ticks < 1000,
				cooperative_stop: true
			);
		} catch ( \Newspack_Nodes\Worker_Should_Stop $stop ) {
			return $stop;
		}
		return null;
	}

	/**
	 * Every patroned node in the registry whose class declares a verb that
	 * wires — a handler, a toggle or a setter — carries its `{name}:config`, so
	 * a sidecar's verbs reach it. A node its builder opted out through
	 * `without_config()` is exempt: it takes no `:config` by design. Fails
	 * naming the node that has none, and fails a graph holding no such node at
	 * all, which would check nothing.
	 */
	protected function assert_owned_nodes_keep_their_config(): void {
		$checked = 0;
		foreach ( Core::$nodes_by_name as $name => $node ) {
			if ( ! $node->owned() || ! $node->wants_config() || $node instanceof \Newspack_Nodes\Command_Interpreter_Node ) {
				continue;
			}
			$wired = \array_filter(
				\Newspack_Nodes\Command_Interpreter_Node::declared_verbs( $node::class ),
				static fn ( array $verb ): bool => isset( $verb['handler'] ) || isset( $verb['toggle'] ) || isset( $verb['setter'] )
			);
			if ( [] === $wired ) {
				continue;
			}
			++$checked;
			$this->assertNotNull( $node->interpreter(), "{$name} (" . $node::class . ') is patroned and declares verbs, but has no :config' );
			$this->assertSame( $node->interpreter(), Core::node( "{$name}:config" ), "{$name}:config is not {$name}'s own interpreter" );
		}
		$this->assertGreaterThan( 0, $checked, 'no patroned node declaring verbs was built, so nothing was checked' );
	}

	protected function pump_consumer( \Newspack_Nodes\Consumer_Node $c, int $max = 5000 ): void {
		$ref = new \ReflectionClass( \Newspack_Nodes\Consumer_Node::class );
		$eof = $ref->getProperty( 'at_eof' );
		$buf = $ref->getProperty( 'buffer' );
		for ( $i = 0; $i < $max; $i++ ) {
			$c->poll();
			$has_complete_line = ( false !== \strpos( (string) $buf->getValue( $c ), "\n" ) );
			if ( $eof->getValue( $c ) && ! $has_complete_line ) {
				return;
			}
		}
	}
}
