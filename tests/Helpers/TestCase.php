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

	protected function setUp(): void {
		parent::setUp();
		if ( \class_exists( '\Newspack_Nodes\Core' ) ) {
			Core::reset();
			// Core's default stderr handler routes through PHP error_log(),
			// which the bootstrap redirects to /dev/null — no further swallow
			// needed here. Tests that need to assert on emitted text set their
			// own handler via Core::set_stderr_handler( ... ).
		}
		// Reset the stubbed WP-options store so option state set by a
		// previous test (dirty flag, fleet descriptors, etc.) doesn't
		// bleed into this one.
		$GLOBALS['_wp_options'] = [];

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
	}

	/** Remove every temp dir make_temp_dir() handed out — a temp dir is only temporary if someone deletes it. */
	protected function tearDown(): void {
		foreach ( $this->temp_dirs as $dir ) {
			$this->rmdir_recursive( $dir );
		}
		$this->temp_dirs = [];
		parent::tearDown();
	}

	protected function make_temp_dir( string $prefix = 'newspack-nodes-test-' ): string {
		// PID + more-entropy uniqid: bare uniqid() is microtime-based and collides
		// across PARALLEL processes (run-coverage runs nodes/ELN/pyrobase at once),
		// which let two suites share one temp dir + its `/tmp/locks` rotate lock —
		// a real cross-process flake. PID guarantees inter-process uniqueness.
		$dir = \sys_get_temp_dir() . '/' . $prefix . \getmypid() . '-' . \uniqid( '', true );
		\mkdir( $dir, 0755, true );
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
			// Whitelist this tmp directory so Config::validate_config_path()
			// accepts the per-test config file. allowed_config_dirs only
			// permits /usr/src by default; /tmp is where every test puts
			// its scratch directory.
			$ref  = new \ReflectionProperty( \Newspack_Nodes\Config::class, 'allowed_config_dirs' );
			$ref->setAccessible( true );
			$dirs = $ref->getValue();
			if ( ! \in_array( $dir, $dirs, true ) ) {
				$dirs[] = $dir;
				$ref->setValue( null, $dirs );
			}
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
	 * `fill( array &$message )` without tripping PHP's "Only variables should
	 * be passed by reference" notice.
	 */
	protected function produce( string $value, string $key = '' ): array {
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$msg[ Message::TIMESTAMP ] = Core::$now;
		$msg[ Message::KEY ]       = $key;
		$msg[ Message::VALUE ]     = $value;
		return $msg;
	}

	/**
	 * Build + fill in one call. Avoids the by-ref notice that fires when a
	 * function-call result is passed directly into a `fill( &$msg )` parameter.
	 *
	 * @param object $node Anything with a fill() method (Partition, Topic, etc.).
	 */
	protected function produce_into( object $node, string $value, string $key = '' ): void {
		$msg = $this->produce( $value, $key );
		$node->fill( $msg );
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
			$msg   = Message::unpacked( $line );
			$out[] = $msg[ Message::VALUE ];
		}
		return $out;
	}
}
