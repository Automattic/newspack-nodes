<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Rest\Command_Controller;
use Newspack_Nodes\Core;
use Newspack_Nodes\HTTP_Out;
use Newspack_Nodes\CommandInterpreter;
use Newspack_Nodes\Consumer;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition;
use Newspack_Nodes\Router;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Command_Controller::class )]
class CommandControllerTest extends TestCase {

	/** @var array<int,int> status_header codes captured by HTTP_Out's seam */
	private array $status_codes = [];

	protected function setUp(): void {
		parent::setUp();
		$this->status_codes = [];
	}

	/**
	 * Production-shaped graph: Router + base CI sinking into Router +
	 * HTTP_Out registered at _http with a status_header recorder seam.
	 */
	private function build_graph(): CommandInterpreter {
		$router = new Router();
		$router->name( '_router' );
		$base_ci = new CommandInterpreter();
		$base_ci->name( '_command_interpreter' );
		$base_ci->sink( $router );

		$self     = $this;
		$http_out = new HTTP_Out(
			static function ( int $code ) use ( $self ): void {
				$self->status_codes[] = $code;
			}
		);
		$http_out->name( '_http' );
		return $base_ci;
	}

	private function make_request( array $body ): \WP_REST_Request {
		$req = new \WP_REST_Request();
		$req->set_body( \wp_json_encode( $body ) );
		$req->set_header( 'content-type', 'application/json' );
		return $req;
	}

	public function test_local_command_writes_packed_response_to_http_body(): void {
		$base_ci = $this->build_graph();
		$echo    = new CommandInterpreter();
		$echo->name( 'echo_service' );
		$echo->sink( $base_ci );
		$echo->commands(
			[
				'echo' => static fn( $self, $args ): string => "got: {$args}",
			]
		);

		$req = $this->make_request(
			[
				'type'  => Message::TM_COMMAND,
				'to'    => 'echo_service',
				'from'  => '_http',
				'id'    => 'cmd-1',
				'value' => \wp_json_encode( [ 'name' => 'echo', 'arguments' => 'hi', 'payload' => '' ] ),
			]
		);

		$ctrl = new Command_Controller();
		$ctrl->set_test_mode( true );

		\ob_start();
		$ctrl->dispatch( $req );
		$body = \ob_get_clean();

		$this->assertSame( [ 200 ], $this->status_codes );
		$msg = Message::unpacked( $body );
		$this->assertSame( Message::TM_COMMAND | Message::TM_RESPONSE, $msg[ Message::TYPE ] );
		$this->assertSame( 'cmd-1', $msg[ Message::ID ] );
		$payload = \json_decode( $msg[ Message::VALUE ], true );
		$this->assertSame( 'echo', $payload['name'] );
		$this->assertSame( 'got: hi', $payload['payload'] );
	}

	public function test_unknown_to_head_writes_tm_error_via_router_NOT_AVAILABLE(): void {
		$this->build_graph();
		$req = $this->make_request(
			[
				'type'  => Message::TM_COMMAND,
				'to'    => 'missing_service',
				'from'  => '_http',
				'id'    => 'cmd-2',
				'value' => \wp_json_encode( [ 'name' => 'whatever', 'arguments' => '', 'payload' => '' ] ),
			]
		);

		$ctrl = new Command_Controller();
		$ctrl->set_test_mode( true );
		\ob_start();
		$ctrl->dispatch( $req );
		$body = \ob_get_clean();

		$this->assertSame( [ 200 ], $this->status_codes );
		$msg = Message::unpacked( $body );
		$this->assertTrue( (bool) ( $msg[ Message::TYPE ] & Message::TM_ERROR ) );
		$this->assertStringContainsString( 'NOT_AVAILABLE', (string) $msg[ Message::VALUE ] );
	}

	public function test_blank_from_defaults_to_underscore_http(): void {
		$base_ci = $this->build_graph();
		$echo    = new CommandInterpreter();
		$echo->name( 'echo_service' );
		$echo->sink( $base_ci );
		$echo->commands( [ 'echo' => static fn( $self, $args ): string => 'ok' ] );

		$req = $this->make_request(
			[
				'type'  => Message::TM_COMMAND,
				'to'    => 'echo_service',
				'id'    => 'cmd-3',
				'value' => \wp_json_encode( [ 'name' => 'echo', 'arguments' => '', 'payload' => '' ] ),
			]
		);

		$ctrl = new Command_Controller();
		$ctrl->set_test_mode( true );
		\ob_start();
		$ctrl->dispatch( $req );
		$body = \ob_get_clean();

		$this->assertNotSame( '', $body );
		$msg = Message::unpacked( $body );
		$this->assertSame( 'cmd-3', $msg[ Message::ID ] );
	}

	public function test_dispatch_without_pregraph_lazy_builds_and_fires_request_graph_ready_hook(): void {
		// Production REST entry point has no prior bootstrap building the
		// request-scope graph for it. Dispatch must lazy-build _router /
		// _command_interpreter / _http and fire the
		// `newspack_nodes/request_graph_ready` hook so applications can
		// mount their CIs via $base_ci->make_node(...).
		$this->assertNull( Core::node( '_router' ), 'pre-condition: no graph yet' );
		$this->assertNull( Core::node( '_command_interpreter' ) );
		$this->assertNull( Core::node( '_http' ) );

		// Capture hook fires and the CI argument the hook receives.
		$fires = [];
		\add_action(
			'newspack_nodes/request_graph_ready',
			static function ( $base_ci ) use ( &$fires ): void {
				$fires[] = $base_ci;
				// Application code mounts its CIs here. Use a tiny echo CI
				// to prove dispatch can route through a hook-mounted CI.
				$echo = new CommandInterpreter();
				$echo->name( 'hook_echo' );
				$echo->sink( $base_ci );
				$echo->commands(
					[ 'echo' => static fn( $self, $args ): string => "got: {$args}" ]
				);
			}
		);

		$req = $this->make_request(
			[
				'type'  => Message::TM_COMMAND,
				'to'    => 'hook_echo',
				'from'  => '_http',
				'id'    => 'cmd-lazy-1',
				'value' => \wp_json_encode( [ 'name' => 'echo', 'arguments' => 'hi', 'payload' => '' ] ),
			]
		);

		$ctrl = new Command_Controller();
		$ctrl->set_test_mode( true );
		\ob_start();
		$ctrl->dispatch( $req );
		$body = (string) \ob_get_clean();

		// Hook fired exactly once with the base CI as the argument.
		$this->assertCount( 1, $fires, 'request_graph_ready hook must fire exactly once' );
		$this->assertInstanceOf( CommandInterpreter::class, $fires[0] );
		$this->assertSame( '_command_interpreter', $fires[0]->name() );

		// Dispatch produced a TM_COMMAND|TM_RESPONSE (not the "graph not
		// initialized" error). Use the production HTTP_Out (not the test
		// seam) — status_header is a stub in our bootstrap, so it's harmless.
		$this->assertNotSame( '', $body, 'dispatch produced no body' );
		$msg            = Message::unpacked( $body );
		$response_flags = Message::TM_COMMAND | Message::TM_RESPONSE;
		$this->assertSame(
			$response_flags,
			$msg[ Message::TYPE ] & ( $response_flags | Message::TM_ERROR ),
			'dispatch returned TM_ERROR — request graph was not lazy-built'
		);
		$this->assertSame( 'cmd-lazy-1', $msg[ Message::ID ] );
		$payload = \json_decode( $msg[ Message::VALUE ], true );
		$this->assertSame( 'got: hi', $payload['payload'] );
	}

	public function test_dispatch_lazy_init_is_idempotent_when_graph_already_present(): void {
		// Pre-build the graph (as a real Bootstrap would for non-REST entry
		// points) and prove that the second dispatch doesn't double-create
		// or re-fire the hook.
		$base_ci = $this->build_graph();
		$echo    = new CommandInterpreter();
		$echo->name( 'idem_echo' );
		$echo->sink( $base_ci );
		$echo->commands( [ 'echo' => static fn( $self, $args ): string => 'ok' ] );

		$pre_router  = Core::node( '_router' );
		$pre_base_ci = Core::node( '_command_interpreter' );
		$pre_http    = Core::node( '_http' );

		$fires = [];
		\add_action(
			'newspack_nodes/request_graph_ready',
			static function ( $ci ) use ( &$fires ): void {
				$fires[] = $ci;
			}
		);

		$req = $this->make_request(
			[
				'type'  => Message::TM_COMMAND,
				'to'    => 'idem_echo',
				'from'  => '_http',
				'id'    => 'cmd-idem',
				'value' => \wp_json_encode( [ 'name' => 'echo', 'arguments' => '', 'payload' => '' ] ),
			]
		);
		$ctrl = new Command_Controller();
		$ctrl->set_test_mode( true );
		\ob_start();
		$ctrl->dispatch( $req );
		\ob_get_clean();

		// Graph nodes are the SAME instances — no re-creation.
		$this->assertSame( $pre_router,  Core::node( '_router' ) );
		$this->assertSame( $pre_base_ci, Core::node( '_command_interpreter' ) );
		$this->assertSame( $pre_http,    Core::node( '_http' ) );

		// Hook still fires (application code may need to mount per-request).
		$this->assertCount( 1, $fires );
		$this->assertSame( $pre_base_ci, $fires[0] );
	}

	public function test_ipc_command_emits_202_ack_and_writes_to_worker_input(): void {
		$this->build_graph();

		$base      = $this->make_temp_dir( 'cmd-ctrl-ipc-' );
		$input_dir = "{$base}/ipc/firehose-workers.p0/input";
		\mkdir( $input_dir, 0755, true );

		// Mount a Partition under the worker's name — same as production
		// bootstrap after scanning the locks/ dir.
		$worker_partition = new Partition( $input_dir, 0 );
		$worker_partition->name( 'firehose-workers.p0' );

		$req = $this->make_request(
			[
				'type'  => Message::TM_COMMAND,
				'to'    => 'firehose-workers.p0/_command_interpreter',
				'from'  => '_http/4242',  // pivoted: SSE process pid
				'id'    => 'cmd-xyz',
				'value' => \wp_json_encode( [ 'name' => 'dump_metadata', 'arguments' => '', 'payload' => '' ] ),
			]
		);

		$ctrl = new Command_Controller();
		$ctrl->set_test_mode( true );
		\ob_start();
		$ctrl->dispatch( $req );
		$body = \ob_get_clean();

		// HTTP_Out never fires (no in-process reply), so the controller emits
		// the 202 ack JSON directly.
		$this->assertEmpty( $this->status_codes );
		$ack = \json_decode( $body, true );
		$this->assertTrue( $ack['queued'] ?? false );
		$this->assertSame( 'cmd-xyz', $ack['id'] );

		// Verify the message landed at the worker's input partition with TO peeled.
		// Per Task 19 implementer's findings, Partition batches writes; flush
		// manually before reading via Consumer.
		$worker_partition->flush();

		$consumer = new Consumer( $input_dir, 0, '' );
		$consumer->next_offset( 'start' );
		$got = [];
		$consumer->sink(
			new \Newspack_Nodes\Callback(
				static function ( array &$m ) use ( &$got ): void {
					$got[] = $m;
				}
			)
		);
		$consumer->poll();
		$this->assertCount( 1, $got );
		$this->assertSame( '_command_interpreter', $got[0][ Message::TO ] );
		// Consumer overwrites ID with seg:offset — decode VALUE to confirm payload identity.
		$payload = \json_decode( $got[0][ Message::VALUE ], true );
		$this->assertSame( 'dump_metadata', $payload['name'] );
	}
}
