<?php
/**
 * Architectural invariant: every Node subclass must be reapable.
 *
 * The contract: after `$node->remove_node()` + `Core::run_closing()` +
 * dropping local references, refcount must reach zero and PHP must
 * collect the object — verified via `WeakReference::get() === null`.
 *
 * Why this matters: Timer-bearing nodes (Partition, Consumer, Tail, the
 * Cli's stdin reader) keep a back-reference inside EventFramework's
 * `$timers` array. Sibling-CI-bearing nodes (Partition, JobIntake)
 * close a Partition↔CI cycle via the patron back-pointer. If
 * `remove_node()` doesn't cascade those refs out, `unset()` can't drop
 * refcount to zero, `__destruct` doesn't fire synchronously, and any
 * batched bytes the Partition was holding for the upcoming timer-flush
 * stay in memory forever (= silent data loss).
 *
 * Adding this test up-front catches any future Node subclass that holds
 * a ref the operator doesn't expect — without the author having to
 * remember the cycle-break ritual.
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Callback;
use Newspack_Nodes\CommandInterpreter;
use Newspack_Nodes\Consumer;
use Newspack_Nodes\Core;
use Newspack_Nodes\Dumper;
use Newspack_Nodes\Echo_Node;
use Newspack_Nodes\Hook;
use Newspack_Nodes\Lock;
use Newspack_Nodes\Log;
use Newspack_Nodes\Partition;
use Newspack_Nodes\Router;
use Newspack_Nodes\Shell;
use Newspack_Nodes\Tail;
use Newspack_Nodes\Tee;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Timer;
use Newspack_Nodes\Topic;
use PHPUnit\Framework\Attributes\DataProvider;

class NodeLifecycleTest extends TestCase {

	/**
	 * Each entry returns a freshly-constructed instance using the per-class
	 * ctor signature. The test loops over them so adding a new Node subclass
	 * to the substrate just means adding one row here — the assertion shape
	 * stays uniform.
	 *
	 * @return array<string, array{0: \Closure}>
	 */
	public static function node_factories(): array {
		$base = \sys_get_temp_dir() . '/nodes-lifecycle-' . \bin2hex( \random_bytes( 4 ) );
		@\mkdir( $base, 0700, true );
		\file_put_contents( "{$base}/tail.log", '' );

		return [
			'Callback'           => [ static fn () => new Callback( static fn () => true ) ],
			'CommandInterpreter' => [ static fn () => new CommandInterpreter() ],
			'Consumer'           => [ static fn () => new Consumer( "{$base}/cdata", 0, "{$base}/coff" ) ],
			'Dumper'             => [ static fn () => new Dumper() ],
			'Echo_Node'          => [ static fn () => new Echo_Node() ],
			'Hook'               => [ static fn () => new Hook( 'the_content' ) ],
			'Lock'               => [ static fn () => new Lock( "{$base}/lock.d", 5 ) ],
			'Log'                => [ static fn () => new Log( "{$base}/out.log" ) ],
			'Partition'          => [ static fn () => new Partition( "{$base}/part", 0 ) ],
			'Router'             => [ static fn () => new Router() ],
			'Shell'              => [ static fn () => new Shell() ],
			'Tail'               => [ static fn () => new Tail( "{$base}/tail.log" ) ],
			'Tee'                => [ static fn () => new Tee() ],
			'Timer'              => [ static fn () => new Timer() ],
			'Topic'              => [ static fn () => new Topic( "{$base}/topic", 2 ) ],
		];
	}

	#[DataProvider( 'node_factories' )]
	public function test_remove_node_releases_all_refs_and_destructs( \Closure $factory ): void {
		$node = $factory();
		$weak = \WeakReference::create( $node );

		// Production cleanup chain: remove_node cascades close_handle +
		// stop_timer (deferred) + Node base cleanup. run_closing drains
		// the deferred queue (drops EventFramework $timers refs). unset
		// removes the only remaining local reference.
		$node->remove_node();
		Core::run_closing();
		$node = null;
		\gc_collect_cycles();

		$this->assertNull(
			$weak->get(),
			'Node must reach refcount=0 after remove_node() + Core::run_closing() + unset()'
		);
	}
}
