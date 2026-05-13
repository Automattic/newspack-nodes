<?php
namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Rest\TopologyStreamController;
use Newspack_Nodes\Tests\TestCase;

class TopologyStreamControllerTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir( 'topology-stream-test-' );
		\mkdir( $this->tmp . '/locks', 0755, true );
		$GLOBALS['_current_user_can'] = true;
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_stream_returns_404_when_worker_lock_missing(): void {
		$ctrl = new TopologyStreamController();
		$ctrl->set_base_dir( $this->tmp );

		$req = new \WP_REST_Request();
		$req->set_param( 'topology', 'firehose-workers' );
		$req->set_param( 'partition', 0 );

		$resp = $ctrl->stream( $req );
		$this->assertInstanceOf( \WP_Error::class, $resp );
		$this->assertSame( 404, $resp->get_error_data()['status'] ?? 0 );
	}

	public function test_stream_emits_hello_event_when_worker_is_live(): void {
		\mkdir( $this->tmp . '/locks/firehose-workers.p0.lock.d', 0755, true );

		$ctrl = new TopologyStreamController();
		$ctrl->set_base_dir( $this->tmp );
		$ctrl->set_test_mode( true );

		$req = new \WP_REST_Request();
		$req->set_param( 'topology', 'firehose-workers' );
		$req->set_param( 'partition', 0 );

		\ob_start();
		$ctrl->stream( $req );
		$out = \ob_get_clean();

		$this->assertStringContainsString( "event: hello\n", $out );
		$this->assertStringContainsString( '"topology":"firehose-workers"', $out );
		$this->assertStringContainsString( '"partition":0', $out );
	}

	public function test_stream_forwards_worker_output_messages_as_msg_events(): void {
		\mkdir( $this->tmp . '/locks/firehose-workers.p0.lock.d', 0755, true );

		// Pre-populate the output Partition with one packed Message — simulates
		// what a worker would have written via _repl conduit before the
		// controller attached.
		$output_dir = $this->tmp . '/ipc/firehose-workers.p0/output/p0';
		\mkdir( $output_dir, 0755, true );
		$msg = \Newspack_Nodes\Message::new_message();
		$msg[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_BYTESTREAM;
		$msg[ \Newspack_Nodes\Message::FROM ]  = 'producer';
		$msg[ \Newspack_Nodes\Message::VALUE ] = 'hello-from-worker';
		\file_put_contents( $output_dir . '/0.log', \Newspack_Nodes\Message::packed( $msg ) . "\n" );

		$ctrl = new TopologyStreamController();
		$ctrl->set_base_dir( $this->tmp );
		$ctrl->set_test_mode( true );

		$req = new \WP_REST_Request();
		$req->set_param( 'topology', 'firehose-workers' );
		$req->set_param( 'partition', 0 );

		\ob_start();
		$ctrl->stream( $req );
		$out = \ob_get_clean();

		$this->assertStringContainsString( "event: msg\n", $out );
		$this->assertStringContainsString( '"from":"producer"', $out );
		$this->assertStringContainsString( '"value":"hello-from-worker"', $out );
	}

	public function test_stream_writes_initial_ls_al_command_to_worker_input(): void {
		\mkdir( $this->tmp . '/locks/firehose-workers.p0.lock.d', 0755, true );

		$ctrl = new TopologyStreamController();
		$ctrl->set_base_dir( $this->tmp );
		$ctrl->set_test_mode( true );

		$req = new \WP_REST_Request();
		$req->set_param( 'topology', 'firehose-workers' );
		$req->set_param( 'partition', 0 );

		\ob_start();
		$ctrl->stream( $req );
		\ob_get_clean();

		// The worker's input Partition for this topology should now contain
		// at least one TM_COMMAND addressed to _command_interpreter.
		$input_log = $this->tmp . '/ipc/firehose-workers.p0/input/p0/0.log';
		$this->assertFileExists( $input_log );
		$content = (string) \file_get_contents( $input_log );
		$lines   = \array_filter( \explode( "\n", $content ) );
		$this->assertNotEmpty( $lines, 'cmd-out Partition should have at least one line' );
		$msg = \Newspack_Nodes\Message::unpacked( (string) \reset( $lines ) );
		$this->assertTrue( (bool) ( $msg[ \Newspack_Nodes\Message::TYPE ] & \Newspack_Nodes\Message::TM_COMMAND ) );
		$payload = \json_decode( (string) $msg[ \Newspack_Nodes\Message::VALUE ], true );
		$this->assertSame( 'dump_metadata', $payload['name']      ?? '' );
		$this->assertSame( '',              $payload['arguments'] ?? '' );
	}

	public function test_stream_writes_periodic_ls_ct_at_one_second_cadence(): void {
		// Test-mode loop runs until tick_limit ticks have fired. Tick 1 is
		// Every tick fires `dump_metadata` (single-poll architecture —
		// returns counter+sink+target+debug_state for every node in
		// one envelope, replacing the older `ls -als` initial +
		// `ls -ct` periodic pair).
		\mkdir( $this->tmp . '/locks/firehose-workers.p0.lock.d', 0755, true );

		$ctrl = new TopologyStreamController();
		$ctrl->set_base_dir( $this->tmp );
		$ctrl->set_test_mode( true );
		$ctrl->set_test_tick_limit( 3 );

		$req = new \WP_REST_Request();
		$req->set_param( 'topology', 'firehose-workers' );
		$req->set_param( 'partition', 0 );

		\ob_start();
		$ctrl->stream( $req );
		\ob_get_clean();

		$input_log = $this->tmp . '/ipc/firehose-workers.p0/input/p0/0.log';
		$content   = (string) \file_get_contents( $input_log );
		$lines     = \array_filter( \explode( "\n", $content ) );
		$commands  = \array_map(
			static function ( string $packed ) {
				$msg     = \Newspack_Nodes\Message::unpacked( $packed );
				$decoded = \json_decode( (string) $msg[ \Newspack_Nodes\Message::VALUE ], true );
				return ( $decoded['name'] ?? '' ) . ' ' . ( $decoded['arguments'] ?? '' );
			},
			$lines
		);
		// Each tick fires dump_metadata (every STATS_INTERVAL_S) AND
		// uptime (every UPTIME_INTERVAL_S). In test mode both timers
		// reset to 0 between iterations so both fire on every tick.
		$dump_metadata_count = \count( \array_filter( $commands, static fn ( $c ) => 'dump_metadata ' === $c ) );
		$uptime_count        = \count( \array_filter( $commands, static fn ( $c ) => 'uptime ' === $c ) );
		$this->assertSame( 3, $dump_metadata_count, 'one dump_metadata per tick' );
		$this->assertSame( 3, $uptime_count, 'one uptime per tick' );
	}
}
