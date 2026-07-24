<?php
/**
 * Architectural invariant: every Node subclass must be reapable.
 *
 * The contract: after `$node->remove_node()` + dropping local
 * references, refcount must reach zero and PHP must collect the object
 * — verified via `WeakReference::get() === null`.
 *
 * Why this matters: Timer-bearing nodes (Partition, Consumer, Tail, the
 * Cli's stdin reader) keep a back-reference inside EventFramework's
 * `$timers` array. Sibling-interpreter-bearing nodes (Partition, JobIntake)
 * close a Partition↔interpreter cycle via the patron back-pointer. If
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

use Newspack_Nodes\Callback_Node;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Dumper_Node;
use Newspack_Nodes\Echo_Node;
use Newspack_Nodes\Hook_Node;
use Newspack_Nodes\Job_Worker_Node;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Log_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Tail_Node;
use Newspack_Nodes\Tee_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Timer_Node;
use Newspack_Nodes\Topic_Node;
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
		$base = (string) \realpath( \sys_get_temp_dir() ) . '/nodes-lifecycle-' . \bin2hex( \random_bytes( 4 ) );
		@\mkdir( $base, 0700, true );
		\file_put_contents( "{$base}/tail.log", '' );

		return [
			'Callback'           => [ static fn () => new Callback_Node( static fn () => true ) ],
			'CommandInterpreter' => [ static fn () => new Command_Interpreter_Node() ],
			'Consumer'           => [ static fn () => new Consumer_Node() ],
			'Dumper'             => [ static fn () => new Dumper_Node() ],
			'Echo_Node'          => [ static fn () => new Echo_Node() ],
			'Hook'               => [
				static function () {
					$h = new Hook_Node();
					$h->arguments( [ 'the_content' ] );
					return $h;
				},
			],
			'Job_Worker'         => [ static fn () => new Job_Worker_Node() ],
			'Lock'               => [ static fn () => new Lock_Node( "{$base}/lock.d", 5 ) ],
			'Log'                => [
				static function () use ( $base ) {
					$l = new Log_Node();
					$l->arguments( [ "{$base}/out.log" ] );
					return $l;
				},
			],
			'Partition'          => [
				static function () use ( $base ) {
					$p = new Partition_Node();
					$p->arguments( [ "{$base}/part" ] );
					return $p;
				},
			],
			'Router'             => [ static fn () => new Router_Node() ],
			'Shell'              => [ static fn () => new Shell_Node() ],
			'Tail'               => [
				static function () use ( $base ) {
					$t = new Tail_Node();
					$t->arguments( [ "{$base}/tail.log" ] );
					return $t;
				},
			],
			'Tee'                => [ static fn () => new Tee_Node() ],
			'Timer'              => [ static fn () => new Timer_Node() ],
			'Topic'              => [
				static function () use ( $base ) {
					$t = new Topic_Node();
					$t->arguments( [ "{$base}/topic.p{partition}", "2" ] );
					return $t;
				},
			],
		];
	}

	#[DataProvider( 'node_factories' )]
	public function test_remove_node_releases_all_refs_and_destructs( \Closure $factory ): void {
		$node = $factory();
		$weak = \WeakReference::create( $node );

		// Production cleanup chain: remove_node cascades close_handle +
		// stop_timer + Node base cleanup. unset removes the only remaining
		// local reference.
		$node->remove_node();
		$node = null;
		\gc_collect_cycles();

		$this->assertNull(
			$weak->get(),
			'Node must reach refcount=0 after remove_node() + unset()'
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
		$capture = new Capture_Sink_Node();
		$capture->name( 'lifecycle_capture' );

		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_ERROR;
		$message[ Message::FROM ]      = 'upstream';
		$message[ Message::VALUE ]     = "NOT_AVAILABLE\n";
		// The Router has no sink — it routes by TO, so address the named capture;
		// other transit nodes forward to their sink regardless of TO.
		if ( $node instanceof Router_Node ) {
			$message[ Message::TO ] = 'lifecycle_capture';
		} else {
			$node->sink( $capture );
			$message[ Message::TO ] = 'downstream';
		}

		$node->fill( $message );

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
		$capture = new Capture_Sink_Node();
		$capture->name( 'lifecycle_capture' );

		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_EOF;
		$message[ Message::FROM ]      = 'upstream';
		$message[ Message::VALUE ]     = '';
		// The Router has no sink — it routes by TO, so address the named capture;
		// other transit nodes forward to their sink regardless of TO.
		if ( $node instanceof Router_Node ) {
			$message[ Message::TO ] = 'lifecycle_capture';
		} else {
			$node->sink( $capture );
			$message[ Message::TO ] = 'downstream';
		}

		$node->fill( $message );

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
	 * would leak the assertion payload to the real terminal. Shell is
	 * the stdin-fed REPL front-end (the PHP analog of Tachikoma's
	 * _stdin → _responder): fill() only accepts bytestream input +
	 * TM_EOF, throws on anything else, and restamps FROM to its own
	 * `_output/$pid` reply identity on EOF (mirroring Tachikoma's
	 * _stdin → _responder FROM rewrite) — so neither preserve-FROM nor
	 * forward-TM_ERROR applies. None of the four exercise the cross-node
	 * propagation contract this test was written for — skip rather than
	 * assert on a no-op.
	 */
	private function is_transit_node( object $node ): bool {
		return ! ( $node instanceof Tail_Node || $node instanceof Lock_Node || $node instanceof Dumper_Node || $node instanceof Shell_Node );
	}

	/**
	 * remove_node() must null the patron back-pointer — otherwise a removed
	 * sibling keeps its owner alive (the Partition↔:config-CI cycle this
	 * suite guards). Unnamed nodes so there is no Core registration to collide.
	 */
	public function test_remove_node_clears_patron(): void {
		$owner = new Echo_Node();
		$sib   = new Echo_Node();
		$sib->patron( $owner );
		$this->assertSame( $owner, $sib->patron() );
		$sib->remove_node();
		$this->assertNull( $sib->patron() );
	}
}
