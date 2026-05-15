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
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition;
use Newspack_Nodes\Router;
use Newspack_Nodes\Shell;
use Newspack_Nodes\Tail;
use Newspack_Nodes\Tee;
use Newspack_Nodes\Tests\CaptureSink;
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

	/**
	 * Mirrors the uniform TM_ERROR contract test from Perl Tachikoma's
	 * nodes.t — every Node either forwards a TM_ERROR untouched (no
	 * FROM restamp, no payload rewrite) or silently absorbs it. Anything
	 * else (mutating the message, throwing, restamping FROM as `$this`)
	 * is a contract violation that breaks the upstream error-propagation
	 * trail.
	 *
	 * Tail is excluded because its fill() ignores its argument entirely
	 * — it's a source node driven by Timer ticks, not a transit node.
	 * Lock is excluded for the same reason: it only listens for its own
	 * HEARTBEAT KEY messages and drops everything else.
	 *
	 * @param \Closure $factory
	 */
	#[DataProvider( 'node_factories' )]
	public function test_fill_tm_error_preserves_payload_and_does_not_restamp_from( \Closure $factory ): void {
		$node = $factory();
		if ( ! $this->is_transit_node( $node ) ) {
			$this->assertTrue( true, 'source/sink-only node — TM_ERROR contract not applicable' );
			return;
		}
		$capture = new CaptureSink();
		$node->sink( $capture );

		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_ERROR;
		$msg[ Message::FROM ]      = 'upstream';
		$msg[ Message::TO ]        = 'downstream';
		$msg[ Message::VALUE ]     = "NOT_AVAILABLE\n";

		$node->fill( $msg );

		// Either forwarded (capture[0] === the message we sent) or absorbed
		// (capture stays empty). Anything else means the Node rewrote
		// something it shouldn't.
		if ( ! empty( $capture->captured ) ) {
			$out = $capture->captured[0];
			$this->assertSame( Message::TM_ERROR, $out[ Message::TYPE ] & Message::TM_ERROR, 'TYPE must retain TM_ERROR bit' );
			$this->assertSame( 'upstream', $out[ Message::FROM ], 'FROM must not be restamped' );
			$this->assertSame( "NOT_AVAILABLE\n", $out[ Message::VALUE ], 'VALUE must not be rewritten' );
		} else {
			$this->assertCount( 0, $capture->captured, 'TM_ERROR was absorbed silently — also valid' );
		}
	}

	/**
	 * Same contract as the TM_ERROR test, applied to TM_EOF. A Node that
	 * mishandles TM_EOF can interrupt graceful-shutdown propagation or
	 * leave downstream consumers waiting on a stream the upstream
	 * already closed.
	 *
	 * @param \Closure $factory
	 */
	#[DataProvider( 'node_factories' )]
	public function test_fill_tm_eof_preserves_payload_and_does_not_restamp_from( \Closure $factory ): void {
		$node = $factory();
		if ( ! $this->is_transit_node( $node ) ) {
			$this->assertTrue( true, 'source/sink-only node — TM_EOF contract not applicable' );
			return;
		}
		$capture = new CaptureSink();
		$node->sink( $capture );

		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_EOF;
		$msg[ Message::FROM ]      = 'upstream';
		$msg[ Message::TO ]        = 'downstream';
		$msg[ Message::VALUE ]     = '';

		$node->fill( $msg );

		if ( ! empty( $capture->captured ) ) {
			$out = $capture->captured[0];
			$this->assertSame( Message::TM_EOF, $out[ Message::TYPE ] & Message::TM_EOF, 'TYPE must retain TM_EOF bit' );
			$this->assertSame( 'upstream', $out[ Message::FROM ], 'FROM must not be restamped' );
			$this->assertSame( '', $out[ Message::VALUE ], 'VALUE must not be rewritten' );
		} else {
			$this->assertCount( 0, $capture->captured, 'TM_EOF was absorbed silently — also valid' );
		}
	}

	/**
	 * Tail is a Timer-driven source: its fill() ignores its argument
	 * entirely (the inherited Timer::fill detects the TIMER KEY and
	 * fires poll). Lock only acts on its own HEARTBEAT KEY messages.
	 * Dumper is a terminal renderer — `fill(TM_ERROR)` writes the
	 * VALUE directly to its `$stderr` handle (defaulted to PHP's
	 * STDERR), so feeding it through this transit-node contract test
	 * would leak the assertion payload to the real terminal. None of
	 * the three exercise the cross-node error-propagation contract
	 * this test was written for — skip rather than assert on a no-op.
	 */
	private function is_transit_node( object $node ): bool {
		return ! ( $node instanceof Tail || $node instanceof Lock || $node instanceof Dumper );
	}
}
