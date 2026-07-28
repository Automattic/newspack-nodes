<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\HTTP_Filter_Node;
use Newspack_Nodes\Node;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Rest\SSE_Out_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\Medium;

/**
 * make_node-discipline (Rule 2): every sibling node the SSE drain graph
 * creates internally — the `_output` HTTP filter, the `_default_route`
 * router Node, and each subscription Consumer — must be patron-linked to
 * the `_sse` egress (so dump_metadata hides them from the canvas). The
 * siblings already set specific sinks, so Rule 2's interpreter-sink clause
 * doesn't apply here; only the patron link is asserted.
 *
 * The patron linkage is captured INSIDE the drain predicate (via the
 * $check_slot seam, consulted on iteration 1 while the graph is fully
 * built) because run_stream_loop's `finally` removes every node — and
 * remove_node() now nulls patron — before the loop returns.
 */
#[CoversClass( SSE_Out_Node::class )]
#[Medium]
class SseOutSiblingPatronTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		\Newspack_Nodes\Event_Framework::reset();
	}

	protected function tearDown(): void {
		SSE_Out_Node::$acquire_slot  = null;
		SSE_Out_Node::$release_slot  = null;
		SSE_Out_Node::$check_slot    = null;
		SSE_Out_Node::$inspect_slot  = null;
		SSE_Out_Node::$diagnostic_log = null;
		\Newspack_Nodes\Event_Framework::reset();
		parent::tearDown();
	}

	public function test_sse_drain_siblings_are_patron_linked_to_the_sse_egress(): void {
		$lease             = [ 'slot' => 6, 'owner' => 62626263 ];
		$partition         = 5;
		$captured          = [];
		$checked_lease     = null;
		$checked_partition = null;
		$diagnostics       = [];
		// $check_slot runs inside the drain predicate AFTER the graph is built
		// and BEFORE the finally tear-down; snapshot each sibling's patron there.
		SSE_Out_Node::$check_slot = static function ( array $actual_lease, int $actual_partition ) use ( &$captured, &$checked_lease, &$checked_partition ): bool {
			$checked_lease     = $actual_lease;
			$checked_partition = $actual_partition;
			$egress = Core::node( Node_Names::SSE );

			$output = Core::node( Node_Names::OUTPUT );
			$captured['output_is_filter'] = $output instanceof HTTP_Filter_Node;
			$captured['output_patron']    = $output instanceof Node ? $output->patron() : null;

			$default = Core::node( '_default_route' );
			$captured['default_is_node']  = $default instanceof Node;
			$captured['default_patron']   = $default instanceof Node ? $default->patron() : null;

			$consumer = Core::node( 'firehose.p0' );
			$captured['consumer_is_consumer'] = $consumer instanceof Consumer_Node;
			$captured['consumer_patron']      = $consumer instanceof Node ? $consumer->patron() : null;

			$captured['egress'] = $egress;
			return false; // stop after one inspection pass
		};
		SSE_Out_Node::$inspect_slot = static fn (): array => [
			'backend'    => 'memcached',
			'lease_state' => 'pointer_owner_mismatch',
		];
		SSE_Out_Node::$diagnostic_log = static function ( array $context ) use ( &$diagnostics ): void {
			$diagnostics[] = $context;
		};

		$base = $this->make_temp_dir( 'sse-sibling-patron-' );
		\mkdir( "{$base}/logs/firehose.p0", 0755, true );
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $base );
		// This test's own check_slot returns false after one inspection pass, so
		// it terminates the drain — no separate iteration bound needed.

		\ob_start();
		try {
			$ctrl->run_stream_loop( [ 'firehose.*' ], null, 500, $lease, $partition );
		} finally {
			\ob_get_clean();
		}

		$this->assertSame( $lease, $checked_lease );
		$this->assertSame( $partition, $checked_partition );
		$this->assertCount( 1, $diagnostics );
		$this->assertSame( 'slot_lease_lost', $diagnostics[0]['reason'] );

		$this->assertTrue( $captured['output_is_filter'] ?? false, '_output sibling must be the HTTP filter' );
		$this->assertTrue( $captured['default_is_node'] ?? false, '_default_route sibling must exist' );
		$this->assertTrue( $captured['consumer_is_consumer'] ?? false, 'firehose Consumer sibling must exist' );

		$egress = $captured['egress'] ?? null;
		$this->assertInstanceOf( SSE_Out_Node::class, $egress, '_sse egress node must be registered' );

		$this->assertSame( $egress, $captured['output_patron'] ?? null, '_output must be patron-linked to the _sse egress' );
		$this->assertSame( $egress, $captured['default_patron'] ?? null, '_default_route must be patron-linked to the _sse egress' );
		$this->assertSame( $egress, $captured['consumer_patron'] ?? null, 'the Consumer must be patron-linked to the _sse egress' );
	}
}
