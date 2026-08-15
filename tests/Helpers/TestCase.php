<?php
namespace Newspack_Nodes\Tests;

use PHPUnit\Framework\TestCase as PHPUnitTestCase;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Topic_Node;

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

	protected function setUp(): void {
		// Keep APCu pinned off so Memcached fixtures remain deterministic: tests
		// that seed Core::$memd must see their claims land there even when CLI
		// APCu is enabled.
		if ( \class_exists( '\\Newspack_Nodes\\Cache_Backend' ) ) {
			\Newspack_Nodes\Cache_Backend::$apcu_usable = static fn (): bool => false;
		}

		parent::setUp();
		if ( \class_exists( '\Newspack_Nodes\Core' ) ) {
			Core::reset();
			// Snapshot the config-namespace registry (survives Core::reset) so
			// tearDown can restore it — a test that wipes it would otherwise break
			// `<config:...>` resolution for every later test.
			$this->saved_config_resolvers = Core::$config_resolvers;
			// Core's default stderr handler routes through PHP error_log(),
			// which the bootstrap redirects to /dev/null — no further swallow
			// needed here. Tests that need to assert on emitted text set their
			// own handler via Core::set_stderr_handler( ... ).
		}
		// Reset the stubbed WP-options store so option state set by a
		// previous test (dirty flag, fleet descriptors, etc.) doesn't
		// bleed into this one.
		$GLOBALS['_wp_options'] = [];
		$this->saved_wp_actions = $GLOBALS['_wp_actions'] ?? [];

		// Service_CI verbs are gated by default; start every test denied so a
		// cap granted in one test can't leak into another's deny-path. Classes
		// that need the cap grant it after parent::setUp().
		$GLOBALS['_wp_test_current_user_can'] = [];

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
		return (string) \realpath( \sys_get_temp_dir() ) . '/newspack-nodes-test';
	}

	/** Remove every temp dir make_temp_dir() handed out — a temp dir is only temporary if someone deletes it. */
	protected function tearDown(): void {
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
		// A direct Command_Auth::verify() installs a capability ceiling that
		// only interpret() restores; a test calling it raw would otherwise
		// leave every later test's Capabilities::can() answering false.
		if ( \class_exists( '\Newspack_Nodes\Capabilities' ) ) {
			\Newspack_Nodes\Capabilities::$session_scope = null;
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
		}
		// Restore the per-test config env that use_base_dir() may have repointed at a
		// (now-deleted) temp config, and drop Config's memoized base/dirs. Otherwise a
		// test that called use_base_dir() leaks its base_directory into a later test
		// that doesn't — surfacing as wrong/empty partition + lock-dir resolution
		// (order-dependent CLI failures). The bootstrap sets this same default.
		\putenv(
			'LOCAL_NEWSPACK_NODES_CONF=' . \dirname( __DIR__ ) . '/newspack-nodes-test-config.php'
		);
		if ( \class_exists( '\Newspack_Nodes\Config' ) ) {
			\Newspack_Nodes\Config::reset();
		}
		if ( \class_exists( '\Newspack_Nodes\CLI', false ) ) {
			// @longform A leaked root uid makes Config::write_denied() true, so
			// Lock_Node::request_restart_at() silently writes nothing — every
			// restart-flag test downstream of LockNodeRootTest then fails, and
			// only in the orders where it happens to run first.
			\Newspack_Nodes\CLI::$uid_provider = null;
		}
		$this->reset_health_test_state();
		\Newspack_Nodes\Remote_Link_Node::reset_connect_queue();
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
		if ( \class_exists( '\Newspack_Nodes\Rest\Health_Cache_Controller' ) ) {
			\Newspack_Nodes\Rest\Health_Cache_Controller::$clock = null;
		}
		if ( \class_exists( '\Newspack_Nodes\Bootstrap' ) ) {
			\Newspack_Nodes\Bootstrap::$health_report_evaluator = null;
		}
		$GLOBALS['_wp_test_is_multisite'] = false;
		$GLOBALS['_wp_test_is_main_site'] = true;
	}

	/**
	 * A scratch dir INSIDE the runtime base, auto-removed in tearDown.
	 *
	 * Inside, not beside: storage nodes refuse a path outside the runtime tree,
	 * and a sibling is outside. Tests that repoint base_directory at their own
	 * temp dir stay contained either way.
	 */
	/**
	 * Run every queued Remote_Link connect now.
	 *
	 * Connects are staggered one-per-tick through Connect_Queue_Timer_Node, so a
	 * test that asserts on a live stream has to advance that queue rather than
	 * assume `fire()` connected inline.
	 */
	protected function drain_connect_queue(): void {
		while ( true ) {
			$connect = \Newspack_Nodes\Remote_Link_Node::shift_connect_queue();
			if ( null === $connect ) {
				return;
			}
			$connect();
		}
	}

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
		return $dir;
	}

	/**
	 * Point Config at a temp config file under $dir so that
	 * `Config::load_config()['base_directory']` returns $dir for the rest of
	 * this test. Mirrors the legacy pattern (`LOCAL_NEWSPACK_NODES_CONF`
	 * pointing at a per-test config file) — replaces the old
	 * `add_filter('newspack_nodes/base_dir', fn() => $this->tmp)` shortcut.
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

	protected function rmdir_recursive( string $dir ): void {
		if ( ! \is_dir( $dir ) ) {
			return;
		}
		foreach ( \scandir( $dir ) as $f ) {
			if ( '.' === $f || '..' === $f ) {
				continue;
			}
			$path = "$dir/$f";
			\is_dir( $path ) ? $this->rmdir_recursive( $path ) : @\unlink( $path );
		}
		@\rmdir( $dir );
	}

	protected function boundedTicks( int $n ): callable {
		return \Newspack_Nodes\Tests\BoundedTicks::callable( $n );
	}

	/**
	 * Build a TM_BYTESTREAM Message wrapping $value (and optional $key).
	 * Convenience for tests that previously called `$p->write("foo\n")` directly
	 * and now need to go through `$p->fill(...)` since Partition::write was
	 * removed in favor of the canonical packed wire format contract.
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
	 * Read a Partition's segment contents and return the unpacked VALUE strings
	 * — what tests previously asserted on raw `file_get_contents()` for. Each
	 * line in the segment is a packed Tachikoma Message; this returns the
	 * VALUEs in order.
	 *
	 * @return array<int,mixed>
	 */
	protected function read_partition_values( Partition_Node $p, int $segment_id = 0 ): array {
		// Tests typically write via `$p->fill()` or `produce_into()` and then
		// immediately read the segment file. Flush any pending batch first so
		// the read picks up the data — Partition::fill batches in memory and
		// only syswrites at PIPE_BUF threshold or destructor time.
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
	 * worker's maps. Replaces the removed set_local_handler / set_remote_handler /
	 * register_handler test-only setters so tests exercise the real load path.
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

	/** Read a private/protected property — these nodes expose internal state to tests via reflection, not getters. */
	protected function read_private( object $obj, string $prop ): mixed {
		$ref = new \ReflectionProperty( $obj, $prop );
		return $ref->getValue( $obj );
	}

	/** Worker's private executed-job counter (increments even when a handler throws; no public accessor by design). */
	protected function jobs_executed( \Newspack_Nodes\Job_Worker_Node $jw ): int {
		return (int) $this->read_private( $jw, 'jobs_executed' );
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
