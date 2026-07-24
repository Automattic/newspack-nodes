<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Message;
use Newspack_Nodes\Newspack_Log_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Newspack_Log_Node: egress into `do_action( 'newspack_log', … )` — the
 * sanctioned Newspack pipeline (Manager ships log_level >= 2 fire-and-forget
 * to logstash → Kibana/Grafana; silent no-op when Manager is absent).
 */
#[CoversClass( Newspack_Log_Node::class )]
class NewspackLogNodeTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_actions'] = [];
	}

	public function test_struct_value_forwards_as_a_newspack_log_data_payload(): void {
		$seen = [];
		add_action(
			'newspack_log',
			function ( $code, $message, $params ) use ( &$seen ) {
				$seen[] = [ $code, $message, $params ];
			},
			10,
			3
		);

		$node = new Newspack_Log_Node();
		$node->name( 'newspack-log' );
		$node->arguments( [ 'nodes_metrics' ] );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = [ 'reader' => 'combined.firehose.p0', 'distance' => 120 ];
		$node->fill( $message );

		$this->assertCount( 1, $seen );
		$this->assertSame( 'nodes_metrics', $seen[0][0] );
		$this->assertSame( [ 'reader' => 'combined.firehose.p0', 'distance' => 120 ], $seen[0][2]['data'] );
		$this->assertSame( 2, $seen[0][2]['log_level'], 'level 2 = ship to logstash, no Slack page' );
	}

	public function test_bytestream_value_rides_as_the_message_text(): void {
		$seen = [];
		add_action(
			'newspack_log',
			function ( $code, $message, $params ) use ( &$seen ) {
				$seen[] = [ $code, $message, $params ];
			},
			10,
			3
		);

		$node = new Newspack_Log_Node();
		$node->name( 'newspack-log' );
		$node->arguments( [ 'nodes_metrics' ] );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = "eve.host.nodes.topics.r.distance 120 1000000\n";
		$node->fill( $message );

		$this->assertCount( 1, $seen );
		$this->assertSame( 'eve.host.nodes.topics.r.distance 120 1000000', $seen[0][1] );
	}

	public function test_code_argument_is_required(): void {
		$node = new Newspack_Log_Node();
		$node->name( 'newspack-log' );
		$this->expectException( \InvalidArgumentException::class );
		$node->arguments( [] );
	}
}
