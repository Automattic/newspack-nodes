<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Graphite_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Graphite_Node: the socket egress standing in for Tachikoma's
 * `connect_inet … :2003`. fill() writes each TM_BYTESTREAM VALUE to the
 * configured plaintext endpoint via the transport seam; everything else
 * (type gating, arguments) runs real.
 */
#[CoversClass( Graphite_Node::class )]
class GraphiteNodeTest extends TestCase {
	/** @var array<int, array{0: string, 1: string}> */
	private array $writes = [];

	protected function setUp(): void {
		parent::setUp();
		Graphite_Node::$transport = function ( string $endpoint, string $payload ): bool {
			$this->writes[] = [ $endpoint, $payload ];
			return true;
		};
	}

	protected function tearDown(): void {
		Graphite_Node::$transport = null;
		parent::tearDown();
	}

	private function bytes( string $value ): array {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = $value;
		return $message;
	}

	public function test_fill_writes_the_value_to_the_configured_endpoint(): void {
		$node = new Graphite_Node();
		$node->name( 'graphite' );
		$node->arguments( [ 'graphite1:2003' ] );

		$node->fill( $this->bytes( "eve.host.nodes.topics.r.distance 120 1000000\n" ) );

		$this->assertSame( [ [ 'udp://graphite1:2003', "eve.host.nodes.topics.r.distance 120 1000000\n" ] ], $this->writes );
	}

	public function test_missing_endpoint_throws_at_arguments_time(): void {
		$node = new Graphite_Node();
		$node->name( 'graphite' );
		$this->expectException( \InvalidArgumentException::class );
		$node->arguments( [] );
	}

	public function test_default_transport_writes_a_real_udp_datagram(): void {
		Graphite_Node::$transport = null; // exercise the production fopen/fwrite path
		$node = new Graphite_Node();
		$node->name( 'graphite' );
		$node->arguments( [ '127.0.0.1:19871' ] );

		// Connectionless UDP: the write succeeds with no listener.
		$node->fill( $this->bytes( "eve.h.nodes.topics.r.distance 1 1000000\n" ) );
		$this->assertSame( 1, $this->read_private( $node, 'counter' ) );
	}

	public function test_unresolvable_endpoint_degrades_loud_not_fatal(): void {
		Graphite_Node::$transport = null;
		$node = new Graphite_Node();
		$node->name( 'graphite' );
		$node->arguments( [ 'no-such-host.invalid:19871' ] );

		$node->fill( $this->bytes( "line 1 1000000\n" ) );
		$this->assertSame( 1, $this->read_private( $node, 'counter' ), 'a failed write logs; it never throws into the drain' );
	}

	public function test_empty_payload_is_skipped(): void {
		$node = new Graphite_Node();
		$node->name( 'graphite' );
		$node->arguments( [ '127.0.0.1:19871' ] );
		$node->fill( $this->bytes( '' ) );
		$this->assertSame( [], $this->writes );
	}

	public function test_arguments_read_back(): void {
		$node = new Graphite_Node();
		$node->name( 'graphite' );
		$node->arguments( [ '127.0.0.1:19871' ] );
		$this->assertSame( [ '127.0.0.1:19871' ], $node->arguments() );
	}

	public function test_non_bytestream_is_dropped(): void {
		$node = new Graphite_Node();
		$node->name( 'graphite' );
		$node->arguments( [ 'graphite1:2003' ] );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = [ 'not' => 'lines' ];
		$node->fill( $message );

		$this->assertSame( [], $this->writes );
	}
}
