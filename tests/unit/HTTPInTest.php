<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Rest\HTTP_In;
use Newspack_Nodes\Core;
use Newspack_Nodes\CommandInterpreter;
use Newspack_Nodes\Consumer;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition;
use Newspack_Nodes\Router;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( HTTP_In::class )]
class HTTPInTest extends TestCase {

	/** @var array<int,int> status_header codes captured by HTTP_In's seam */
	private array $status_codes = [];

	protected function setUp(): void {
		parent::setUp();
		// The base TestCase resets Core's registry and $GLOBALS['_wp_options'],
		// but NOT $GLOBALS['_wp_actions']. Hooks added in previous tests
		// (including the request_graph_ready hook tests below) leak across
		// boundaries and break later dispatches. Reset here.
		$GLOBALS['_wp_actions'] = [];
		$this->status_codes     = [];
	}

	/**
	 * Production-shaped graph: Router + base CI sinking into Router +
	 * HTTP_In registered at _http with a status_header recorder seam.
	 */
	private function build_graph(): CommandInterpreter {
		$router = new Router();
		$router->name( '_router' );
		$base_ci = new CommandInterpreter();
		$base_ci->name( '_command_interpreter' );
		$base_ci->sink( $router );

		$self     = $this;
		$http_out = new HTTP_In(
			static function ( int $code ) use ( $self ): void {
				$self->status_codes[] = $code;
			}
		);
		$http_out->name( '_http' );
		return $base_ci;
	}

	/**
	 * Translate the named fields a test expresses into a packed 7-element
	 * positional Message array (the wire shape `Message::unpacked()` requires)
	 * — the same named→positional mapping the controller's now-deleted
	 * `normalize_body_to_message()` used to perform, relocated into the harness.
	 *
	 * @param array<string,mixed> $fields Any of type/from/to/id/key/value (all optional).
	 * @return array<int,mixed> A 7-element positional Message.
	 */
	private function fields_to_message( array $fields ): array {
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = (int) ( $fields['type'] ?? Message::TM_COMMAND );
		$msg[ Message::FROM ]  = (string) ( $fields['from'] ?? '' );
		$msg[ Message::TO ]    = (string) ( $fields['to'] ?? '' );
		$msg[ Message::ID ]    = (string) ( $fields['id'] ?? '' );
		$msg[ Message::KEY ]   = (string) ( $fields['key'] ?? '' );
		// VALUE rides as whatever the test supplies — a command struct is a
		// live PHP array (`['name'=>,'arguments'=>,'payload'=>]`), not a JSON
		// string. Only the envelope/wire (Message::packed) is JSON. Don't
		// string-cast: that would flatten an array VALUE to "Array".
		$msg[ Message::VALUE ] = $fields['value'] ?? '';
		return $msg;
	}

	/**
	 * Build a POST /command request carrying a single packed Message.
	 *
	 * @param array<string,mixed> $fields Any of type/from/to/id/key/value (all optional).
	 */
	private function make_request( array $fields ): \WP_REST_Request {
		$req = new \WP_REST_Request();
		$req->set_body( Message::packed( $this->fields_to_message( $fields ) ) );
		$req->set_header( 'content-type', 'application/json' );
		return $req;
	}

	/**
	 * Build a POST /command request carrying a BATCH — a JSON list of packed
	 * Messages. dispatch() routes each in order through the one request graph.
	 *
	 * @param array<int,array<string,mixed>> $fields_list One field-set per message.
	 */
	private function make_batch_request( array $fields_list ): \WP_REST_Request {
		// JSONL wire: one packed Message per line.
		$lines = \array_map(
			fn( array $fields ): string => Message::packed( $this->fields_to_message( $fields ) ),
			$fields_list
		);
		$req = new \WP_REST_Request();
		$req->set_body( \implode( "\n", $lines ) );
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
				'value' => [ 'name' => 'echo', 'arguments' => 'hi', 'payload' => '' ],
			]
		);

		$ctrl = new HTTP_In();
		$ctrl->set_test_mode( true );

		\ob_start();
		$ctrl->dispatch( $req );
		$body = \ob_get_clean();

		$this->assertSame( [ 200 ], $this->status_codes );
		$msg = Message::unpacked( $body );
		$this->assertSame( Message::TM_COMMAND | Message::TM_RESPONSE, $msg[ Message::TYPE ] );
		$this->assertSame( 'cmd-1', $msg[ Message::ID ] );
		// Response VALUE rides as a live `['name'=>,'payload'=>]` array.
		$payload = $msg[ Message::VALUE ];
		$this->assertSame( 'echo', $payload['name'] );
		$this->assertSame( 'got: hi', $payload['payload'] );
	}

	public function test_dispatch_routes_a_batch_of_messages_in_order(): void {
		// A request body that is a LIST of packed Messages (not a single one)
		// dispatches each in order through the one request graph. This is what
		// lets the topology dashboard send `connect_worker_input` immediately
		// before its real pivoted command in the SAME request.
		$base_ci = $this->build_graph();
		$echo    = new CommandInterpreter();
		$echo->name( 'echo_service' );
		$echo->sink( $base_ci );
		$calls = [];
		$echo->commands(
			[
				'echo' => static function ( $self, $args ) use ( &$calls ): string {
					$calls[] = $args;
					return "got: {$args}";
				},
			]
		);

		$req = $this->make_batch_request(
			[
				[ 'type' => Message::TM_COMMAND, 'to' => 'echo_service', 'from' => '_http', 'id' => 'c1', 'value' => [ 'name' => 'echo', 'arguments' => 'one', 'payload' => '' ] ],
				[ 'type' => Message::TM_COMMAND, 'to' => 'echo_service', 'from' => '_http', 'id' => 'c2', 'value' => [ 'name' => 'echo', 'arguments' => 'two', 'payload' => '' ] ],
			]
		);

		$ctrl = new HTTP_In();
		$ctrl->set_test_mode( true );
		\ob_start();
		$ctrl->dispatch( $req );
		\ob_get_clean();

		$this->assertSame( [ 'one', 'two' ], $calls, 'both batched commands must route in order' );
	}

	public function test_unknown_to_head_writes_tm_error_via_router_NOT_AVAILABLE(): void {
		$this->build_graph();
		$req = $this->make_request(
			[
				'type'  => Message::TM_COMMAND,
				'to'    => 'missing_service',
				'from'  => '_http',
				'id'    => 'cmd-2',
				'value' => [ 'name' => 'whatever', 'arguments' => '', 'payload' => '' ],
			]
		);

		$ctrl = new HTTP_In();
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
				'value' => [ 'name' => 'echo', 'arguments' => '', 'payload' => '' ],
			]
		);

		$ctrl = new HTTP_In();
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
				'value' => [ 'name' => 'echo', 'arguments' => 'hi', 'payload' => '' ],
			]
		);

		$ctrl = new HTTP_In();
		$ctrl->set_test_mode( true );
		\ob_start();
		$ctrl->dispatch( $req );
		$body = (string) \ob_get_clean();

		// Hook fired exactly once with the base CI as the argument.
		$this->assertCount( 1, $fires, 'request_graph_ready hook must fire exactly once' );
		$this->assertInstanceOf( CommandInterpreter::class, $fires[0] );
		$this->assertSame( '_command_interpreter', $fires[0]->name() );

		// Dispatch produced a TM_COMMAND|TM_RESPONSE (not the "graph not
		// initialized" error). Use the production HTTP_In (not the test
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
		$payload = $msg[ Message::VALUE ];
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
				'value' => [ 'name' => 'echo', 'arguments' => '', 'payload' => '' ],
			]
		);
		$ctrl = new HTTP_In();
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

	/**
	 * `newspack_nodes_mount_substrate_cis` must be safe to invoke twice within
	 * one PHP process. The action it's hooked to (`request_graph_ready`) fires
	 * once per `HTTP_In::dispatch`, but production has seen the
	 * action handler run twice in a single request — likely via plugin file
	 * re-loaded by some bootstrap path — and the second call fatals with
	 * `node name collision: workers already registered`. That kills the whole
	 * REST response with a 500. Idempotency is the cheap fix: skip if the CIs
	 * are already mounted under this base CI.
	 */
	public function test_mount_substrate_cis_is_idempotent(): void {
		$base_ci = $this->build_graph();
		$names   = [ 'classes', 'layouts', 'topologies', 'raw-logs', 'workers' ];

		\newspack_nodes_mount_substrate_cis( $base_ci );
		foreach ( $names as $name ) {
			$this->assertNotNull( Core::node( $name ), "first mount must create '{$name}'" );
		}

		// Second invocation must not throw "node name collision".
		\newspack_nodes_mount_substrate_cis( $base_ci );

		foreach ( $names as $name ) {
			$this->assertNotNull( Core::node( $name ), "second mount must leave '{$name}' present" );
		}
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
				'value' => [ 'name' => 'dump_metadata', 'arguments' => '', 'payload' => '' ],
			]
		);

		$ctrl = new HTTP_In();
		$ctrl->set_test_mode( true );
		\ob_start();
		$ctrl->dispatch( $req );
		$body = \ob_get_clean();

		// HTTP_In never fires (no in-process reply), so the controller emits
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
		$consumer->sink( $got = new \Newspack_Nodes\Tests\CaptureSink() );
		$consumer->poll();
		$this->assertCount( 1, $got->captured );
		$this->assertSame( '_command_interpreter', $got->captured[0][ Message::TO ] );
		// Consumer overwrites ID with seg:offset; VALUE rode through
		// pack/unpack as a live array, so read it directly to confirm
		// payload identity.
		$payload = $got->captured[0][ Message::VALUE ];
		$this->assertSame( 'dump_metadata', $payload['name'] );
	}

	// ── register_routes ────────────────────────────────────────────────────

	public function test_register_routes_registers_command_post_route(): void {
		$GLOBALS['_wp_test_registered_routes'] = [];

		( new HTTP_In() )->register_routes();

		$this->assertCount( 1, $GLOBALS['_wp_test_registered_routes'] );
		$route = $GLOBALS['_wp_test_registered_routes'][0];
		$this->assertSame( 'newspack-nodes/v1', $route['namespace'] );
		$this->assertSame( '/command', $route['route'] );
		$this->assertSame( 'POST', $route['args']['methods'] );
		$this->assertIsCallable( $route['args']['callback'] );
		$this->assertIsCallable( $route['args']['permission_callback'] );
	}

	// ── emit_error: graph not initialized ──────────────────────────────────

	public function test_dispatch_emits_500_when_router_is_replaced_by_non_Router_via_hook(): void {
		// ensure_request_graph() builds _router / _http defensively if
		// missing, but the `newspack_nodes/request_graph_ready` hook fires
		// AFTER that. A hook handler can register a different object under
		// '_router' (or '_http') — the post-hook `instanceof` guard catches
		// it and emit_error() writes a 500 + TM_ERROR packed reply.
		$this->build_graph();

		\add_action(
			'newspack_nodes/request_graph_ready',
			static function (): void {
				// Replace _router with something that is NOT a Router instance.
				// A bare CommandInterpreter is a Node but not a Router, so the
				// instanceof check fails.
				Core::register_node( '_router', new CommandInterpreter() );
			}
		);

		$GLOBALS['_wp_test_status_headers'] = [];

		$req = $this->make_request(
			[
				'type'  => Message::TM_COMMAND,
				'to'    => 'something',
				'from'  => '_http',
				'id'    => 'cmd-err-1',
				'value' => '',
			]
		);

		$ctrl = new HTTP_In();
		$ctrl->set_test_mode( true );

		\ob_start();
		$ctrl->dispatch( $req );
		$body = \ob_get_clean();

		// emit_error writes status_header( 500 ) directly (not via HTTP_In's
		// seam), so the bootstrap-stub recorder captures it.
		$this->assertSame( [ 500 ], $GLOBALS['_wp_test_status_headers'] );

		// Body is a packed TM_RESPONSE|TM_ERROR with the originating ID.
		$err = Message::unpacked( $body );
		$this->assertSame( Message::TM_RESPONSE | Message::TM_ERROR, $err[ Message::TYPE ] );
		$this->assertSame( '_command', $err[ Message::FROM ] );
		$this->assertSame( '_http', $err[ Message::TO ] );
		$this->assertSame( 'cmd-err-1', $err[ Message::ID ] );
		$this->assertStringContainsString( 'request-scope graph not initialized', $err[ Message::VALUE ] );
	}

	// ── HTTP_In as a Node: response-writer behavior ──

	public function test_first_fill_sends_status_200_and_echoes_packed_message(): void {
		$headers = [];
		$writer  = new HTTP_In(
			static function ( int $code ) use ( &$headers ): void {
				$headers[] = $code;
			}
		);

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_RESPONSE;
		$m[ Message::ID ]    = 'abc';
		$m[ Message::VALUE ] = 'payload';

		\ob_start();
		$writer->fill( $m );
		$out = \ob_get_clean();

		$this->assertSame( [ 200 ], $headers );
		$this->assertSame( Message::packed( $m ), $out );
		$this->assertTrue( $writer->sent_headers );
	}

	public function test_subsequent_fills_dont_re_send_headers_but_still_echo(): void {
		$headers = [];
		$writer  = new HTTP_In(
			static function ( int $code ) use ( &$headers ): void {
				$headers[] = $code;
			}
		);

		$a                   = Message::new_message();
		$a[ Message::VALUE ] = 'first';
		$b                   = Message::new_message();
		$b[ Message::VALUE ] = 'second';

		\ob_start();
		$writer->fill( $a );
		$writer->fill( $b );
		$out = \ob_get_clean();

		$this->assertSame( [ 200 ], $headers );
		$this->assertSame( Message::packed( $a ) . Message::packed( $b ), $out );
	}

	public function test_default_send_header_closure_invokes_status_header_when_none_supplied(): void {
		// Constructor null-coalesces to a closure wrapping the real
		// \status_header(). Without a fed seam, we still need to prove that
		// branch executes on first fill — otherwise the production path is
		// uncovered. Bootstrap stubs status_header() to push the code into
		// $GLOBALS['_wp_test_status_headers'] so we can assert the default
		// closure actually called it.
		$GLOBALS['_wp_test_status_headers'] = [];
		$writer                             = new HTTP_In();

		\ob_start();
		$m = Message::new_message();
		$writer->fill( $m );
		$out = \ob_get_clean();

		$this->assertTrue( $writer->sent_headers );
		$this->assertSame( Message::packed( $m ), $out );
		$this->assertSame( [ 200 ], $GLOBALS['_wp_test_status_headers'] );
	}

	public function test_node_schema_is_hidden_with_empty_ctor_and_verbs(): void {
		// HTTP_In is bootstrap-instantiated at request scope only — never via
		// `make_node` from a topology. Hidden category + empty ctor/verbs
		// locks that contract.
		$schema = HTTP_In::node_schema();
		$this->assertSame( 'Hidden', $schema['category'] );
		$this->assertSame( [], $schema['ctor'] );
		$this->assertSame( [], $schema['verbs'] );
		$this->assertNotEmpty( $schema['description'] );
	}

	public function test_reset_allows_fresh_status_header_on_next_fill(): void {
		$headers = [];
		$writer  = new HTTP_In(
			static function ( int $code ) use ( &$headers ): void {
				$headers[] = $code;
			}
		);

		\ob_start();
		$first = Message::new_message();
		$writer->fill( $first );
		$writer->reset();
		$second = Message::new_message();
		$writer->fill( $second );
		\ob_get_clean();

		$this->assertSame( [ 200, 200 ], $headers );
		$this->assertTrue( $writer->sent_headers );
	}
}
