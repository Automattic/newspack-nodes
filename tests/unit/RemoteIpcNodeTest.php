<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Remote_IPC_Node;
use Newspack_Nodes\SSE_In_Node;
use Newspack_Nodes\Vault;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Remote_IPC_Node::class )]
class RemoteIpcNodeTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		$this->use_base_dir( $this->make_temp_dir() );
		Core::$memd = new InMemoryMemcached();
	}

	protected function tearDown(): void {
		Remote_IPC_Node::$active       = null;
		Core::$memd                    = null;
		SSE_In_Node::$curl_dispatch    = null;
		HTTP_Out_Node::$curl_dispatch  = null;
		Vault::get_instance()->reset_cache();
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	private function seed_vault( string $id = 'austin' ): void {
		\update_option( Vault::OPTION_KEY, [ $id => [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] ] );
		Vault::get_instance()->reset_cache();
	}

	/** Install an SSE_In connect seam returning a real idle handle (never transferred). */
	private function stub_sse_connect(): void {
		SSE_In_Node::$curl_dispatch = static function ( \CurlMultiHandle $multi, array $opts ): \CurlHandle {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
	}

	private function make_ipc( string $name = 'combined.p0', string $args = 'austin combined.p0' ): array {
		$node = new Remote_IPC_Node();
		$node->name( $name );
		$sink = new Capture_Sink_Node();
		$sink->name( "{$name}:downstream" );
		$node->sink( $sink );
		$node->arguments( $args );
		return [ $node, $sink ];
	}

	/** Feed a `connected` handshake (slot + session pid) into an SSE_In. */
	private function feed_connected( SSE_In_Node $sse, int $slot, int $pid ): void {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::KEY ]   = 'connected';
		$m[ Message::VALUE ] = [ 'slot' => $slot, 'pid' => $pid ];
		$sse->process_sse_chunk( "event: msg\ndata: " . Message::packed( $m ) . "\n\n" );
	}

	private function command( string $from, string $to ): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_COMMAND;
		$m[ Message::FROM ]  = $from;
		$m[ Message::TO ]    = $to;
		$m[ Message::VALUE ] = [ 'name' => 'dump_metadata', 'arguments' => '' ];
		return $m;
	}

	public function test_send_bundles_connect_worker_input_then_command_one_batch(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node ] = $this->make_ipc( 'combined.p0' );

		$cmd = $this->command( '_metadata', 'dump_metadata' );
		$node->fill( $cmd );

		$http  = Core::node( 'combined.p0:http-out' );
		$this->assertInstanceOf( HTTP_Out_Node::class, $http );
		$batch = $this->read_private( $http, 'batch' );
		$this->assertCount( 2, $batch );

		// 1st rides a connect_worker_input {reader} to topologies (mounts the input).
		$this->assertSame( 'topologies', $batch[0][ Message::TO ] );
		$this->assertSame( 'connect_worker_input', $batch[0][ Message::VALUE ]['name'] );
		$this->assertSame( 'combined.p0', $batch[0][ Message::VALUE ]['arguments'] );

		// 2nd is the command, addressed to the worker reader + remainder.
		$this->assertSame( 'combined.p0/dump_metadata', $batch[1][ Message::TO ] );
	}

	public function test_command_to_bare_reader_when_no_remainder(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node ] = $this->make_ipc( 'combined.p0' );

		$cmd = $this->command( '_metadata', '' );
		$node->fill( $cmd );

		$batch = $this->read_private( Core::node( 'combined.p0:http-out' ), 'batch' );
		$this->assertSame( 'combined.p0', $batch[1][ Message::TO ] );
	}

	public function test_command_from_wrapped_with_session_pid_pivot(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node ] = $this->make_ipc( 'combined.p0' );
		$node->connect();
		$this->feed_connected( Core::node( 'combined.p0:sse-in' ), 7, 4242 );

		$cmd = $this->command( '_metadata', 'dump_metadata' );
		$node->fill( $cmd );

		$batch = $this->read_private( Core::node( 'combined.p0:http-out' ), 'batch' );
		$this->assertSame( Node_Names::SSE . ':4242/_metadata', $batch[1][ Message::FROM ] );
	}

	public function test_connect_steals_the_single_live_connection(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $a ] = $this->make_ipc( 'combined.p0', 'austin combined.p0' );
		[ $b ] = $this->make_ipc( 'flame.p0', 'austin flame.p0' );

		$a->connect();
		$this->assertSame( $a, Remote_IPC_Node::$active );
		$this->assertTrue( Core::node( 'combined.p0:sse-in' )->connection()['connected'] );

		$b->connect();
		$this->assertSame( $b, Remote_IPC_Node::$active );
		// Stealing the live stream closes the previous holder.
		$this->assertFalse( Core::node( 'combined.p0:sse-in' )->connection()['connected'] );
	}

	public function test_reply_records_not_sent(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node ] = $this->make_ipc( 'combined.p0' );
		$node->connect();

		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$reply[ Message::TO ]    = 'combined.p0';
		$reply[ Message::VALUE ] = [ 'success' => true ];
		$node->fill( $reply );

		// A reply is RTT bookkeeping, not a command to relay — nothing batched.
		$this->assertCount( 0, $this->read_private( Core::node( 'combined.p0:http-out' ), 'batch' ) );
	}

	public function test_only_the_active_link_ticks_a_heartbeat(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $a ] = $this->make_ipc( 'combined.p0', 'austin combined.p0' );
		[ $b ] = $this->make_ipc( 'flame.p0', 'austin flame.p0' );

		$a->connect();
		$this->feed_connected( Core::node( 'combined.p0:sse-in' ), 5, 4242 );
		$b->connect(); // steals the live stream → A is dormant
		$this->feed_connected( Core::node( 'flame.p0:sse-in' ), 9, 4243 );

		// Past the heartbeat interval, both tick. The stolen link must NOT poke its
		// (now-dead) slot — only the active link keeps its keepalive alive.
		Core::$now = \microtime( true ) + 16;
		$a->fire();
		$b->fire();

		$this->assertCount( 0, $this->read_private( Core::node( 'combined.p0:http-out' ), 'batch' ) );
		$batch_b = $this->read_private( Core::node( 'flame.p0:http-out' ), 'batch' );
		$this->assertCount( 1, $batch_b );
		$this->assertSame( 'heartbeat', $batch_b[0][ Message::VALUE ]['name'] );
	}

	public function test_node_schema_is_visible_io_inheriting_base_args(): void {
		$schema = Remote_IPC_Node::node_schema();
		$this->assertSame( 'I/O', $schema['category'] );
		$this->assertArrayNotHasKey( 'hidden', $schema );
		// arguments inherit from the base via array_merge (single source of truth).
		$names = \array_column( $schema['arguments'], 'name' );
		$this->assertSame( [ 'vault_id', 'remote_partition' ], $names );
	}
}
