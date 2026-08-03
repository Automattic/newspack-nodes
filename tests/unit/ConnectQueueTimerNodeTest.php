<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Connect_Queue_Timer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Remote_Link_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * The shared connect-queue drain timer — a port of Tachikoma's JobSpawnTimer:
 * one closure per fire, and the node retires itself once the queue is dry.
 */
#[CoversClass( Connect_Queue_Timer_Node::class )]
class ConnectQueueTimerNodeTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		Remote_Link_Node::reset_connect_queue();
		( new Command_Interpreter_Node() )->name( Node_Names::COMMAND_INTERPRETER );
	}

	private function make_timer(): Connect_Queue_Timer_Node {
		$timer = new Connect_Queue_Timer_Node();
		$timer->name( Connect_Queue_Timer_Node::NODE_NAME );
		// fire_cb() returns early on a null sink, before ever reaching fire().
		$timer->sink( Core::node( Node_Names::COMMAND_INTERPRETER ) );
		return $timer;
	}

	public function test_it_runs_exactly_one_queued_connect_per_fire(): void {
		$ran = [];
		foreach ( [ 'alfa', 'bravo', 'charlie' ] as $id ) {
			Remote_Link_Node::push_connect_queue(
				static function () use ( &$ran, $id ): void {
					$ran[] = $id;
				},
				null
			);
		}

		$timer = $this->make_timer();
		$timer->fire_cb();
		$this->assertSame( [ 'alfa' ], $ran, 'one per tick, in order' );
		$timer->fire_cb();
		$this->assertSame( [ 'alfa', 'bravo' ], $ran );
	}

	public function test_a_dry_queue_retires_the_timer(): void {
		$timer = $this->make_timer();
		$this->assertNotNull( Core::node( Connect_Queue_Timer_Node::NODE_NAME ) );

		$timer->fire_cb();

		$this->assertNull(
			Core::node( Connect_Queue_Timer_Node::NODE_NAME ),
			'the node exists only while there is work, as JobSpawnTimer does'
		);
	}

	public function test_the_schema_hides_it_from_the_palette(): void {
		// Hook-mounted infrastructure, not an operator's canvas drop.
		$schema = Connect_Queue_Timer_Node::node_schema();
		$this->assertTrue( $schema['hidden'] );
		$this->assertFalse( $schema['has_target'] );
		$this->assertSame( [], $schema['arguments'] );
	}
}
