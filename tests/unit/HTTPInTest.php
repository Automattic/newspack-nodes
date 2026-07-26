<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Rest\HTTP_In_Node;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Core;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( HTTP_In_Node::class )]
class HTTPInTest extends TestCase {

	/** @var array<int,int> status_header codes captured by HTTP_In's seam */
	private array $status_codes = [];

	protected function tearDown(): void {
		Command_Auth::$claim_nonce = null;
		parent::tearDown();
	}

	protected function setUp(): void {
		parent::setUp();
		// The base TestCase resets Core's registry and $GLOBALS['_wp_options'],
		// but NOT $GLOBALS['_wp_actions']. Hooks added in previous tests
		// (including the request_graph_ready hook tests below) leak across
		// boundaries and break later dispatches. Reset here.
		$GLOBALS['_wp_actions'] = [];
		$this->status_codes     = [];
		// Ingress no longer signs, so a request must arrive signed like a real
		// client's. Same-site secret() signing is the `wp nodes cli` path.
		Command_Auth::$claim_nonce = static fn ( string $nonce, int $ttl ): bool => true;
	}

	/**
	 * Production-shaped graph: Router + base interpreter sinking into Router +
	 * HTTP_In registered at _output (the egress boundary) with a status_header
	 * recorder seam. A reply's TO=FROM walks `_output/…` back to this node, so
	 * the recorder captures the 200 status its fill() emits.
	 */
	private function build_graph(): Command_Interpreter_Node {
		$router = new Router_Node();
		$router->name( '_router' );
		$base_interpreter = new Command_Interpreter_Node();
		$base_interpreter->name( '_command_interpreter' );
		$base_interpreter->sink( $router );

		$self     = $this;
		$http_out = new HTTP_In_Node(
			static function ( int $code ) use ( $self ): void {
				$self->status_codes[] = $code;
			}
		);
		$http_out->name( '_output' );
		return $base_interpreter;
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
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = (int) ( $fields['type'] ?? Message::TM_COMMAND );
		$message[ Message::FROM ]  = (string) ( $fields['from'] ?? '' );
		$message[ Message::TO ]    = (string) ( $fields['to'] ?? '' );
		$message[ Message::ID ]    = (string) ( $fields['id'] ?? '' );
		$message[ Message::KEY ]   = (string) ( $fields['key'] ?? '' );
		// VALUE rides as whatever the test supplies — a command struct is a
		// live PHP array (`['name'=>,'arguments'=>,'payload'=>]`), not a JSON
		// string. Only the envelope/wire (Message::packed) is JSON. Don't
		// string-cast: that would flatten an array VALUE to "Array".
		$message[ Message::VALUE ] = $fields['value'] ?? '';
		// Ingress no longer signs, so a request arrives signed like a real
		// client's. `sign => false` lets a test supply its own envelope.
		if ( false !== ( $fields['sign'] ?? true ) ) {
			Command_Auth::sign( $message );
		}
		return $message;
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

	/**
	 * A command that already carries a session envelope must reach the graph with
	 * its handle intact. `stamp()` replaces the whole `auth` array, so an
	 * unconditional re-sign at ingress strips the handle and re-keys the message
	 * to the local secret — which means an expired or revoked session executes
	 * anyway, and the verify-by-handle branch is unreachable on the only live
	 * wire ingress.
	 */
	/**
	 * The flag day. HTTP_In used to sign whatever arrived, on the grounds that
	 * WordPress had already authenticated the caller — which made the boundary an
	 * oracle: authority came from ARRIVAL, so anything reaching it acquired
	 * authority regardless of what put it there. Every minter now signs, so
	 * ingress signing is gone and an unsigned command stays unsigned.
	 */
	public function test_dispatch_does_not_sign_an_unsigned_command(): void {
		$base_interpreter = $this->build_graph();
		$capture          = new Capture_Sink_Node();
		$capture->name( 'capture_service' );
		$capture->sink( $base_interpreter );

		$req = $this->make_request(
			[
				'type'  => Message::TM_COMMAND,
				'to'    => 'capture_service',
				'from'  => '_http',
				'sign'  => false,
				'value' => [ 'name' => 'echo', 'arguments' => [] ],
			]
		);

		$ctrl = new HTTP_In_Node();
		$ctrl->set_test_mode( true );
		\ob_start();
		$ctrl->dispatch( $req );
		\ob_get_clean();

		$this->assertCount( 1, $capture->captured );
		$this->assertArrayNotHasKey(
			'auth',
			$capture->captured[0][ Message::VALUE ],
			'ingress must not confer authority on arrival'
		);
	}

	public function test_dispatch_leaves_an_already_signed_session_envelope_alone(): void {
		$base_interpreter = $this->build_graph();
		$capture          = new Capture_Sink_Node();
		$capture->name( 'capture_service' );
		$capture->sink( $base_interpreter );

		$req = $this->make_request(
			[
				'type'  => Message::TM_COMMAND,
				'to'    => 'capture_service',
				'from'  => '_http',
				'sign'  => false,
				'value' => [
					'name'      => 'echo',
					'arguments' => [],
					'auth'      => [
						'nonce'  => \str_repeat( 'b', 32 ),
						'sig'    => 'signed-by-the-hub-4242',
						'handle' => 'aaaabbbbccccddddeeeeffff00001111',
					],
				],
			]
		);

		$ctrl = new HTTP_In_Node();
		$ctrl->set_test_mode( true );
		\ob_start();
		$ctrl->dispatch( $req );
		\ob_get_clean();

		$this->assertCount( 1, $capture->captured );
		$auth = $capture->captured[0][ Message::VALUE ]['auth'];
		$this->assertSame( 'aaaabbbbccccddddeeeeffff00001111', $auth['handle'] );
		$this->assertSame( 'signed-by-the-hub-4242', $auth['sig'] );
	}

	public function test_local_command_writes_packed_response_to_http_body(): void {
		$base_interpreter = $this->build_graph();
		$echo    = new Command_Interpreter_Node();
		$echo->name( 'echo_service' );
		$echo->sink( $base_interpreter );
		$echo->commands(
			[
				'echo' => static fn( $self, $args ): string => 'got: ' . \implode( ' ', $args ),
			]
		);

		$req = $this->make_request(
			[
				'type'  => Message::TM_COMMAND,
				'to'    => 'echo_service',
				'from'  => '_http',
				'id'    => 'cmd-1',
				'value' => [ 'name' => 'echo', 'arguments' => [ 'hi' ], 'payload' => '' ],
			]
		);

		$ctrl = new HTTP_In_Node();
		$ctrl->set_test_mode( true );

		\ob_start();
		$ctrl->dispatch( $req );
		$body = \ob_get_clean();

		$this->assertSame( [ 200 ], $this->status_codes );
		$message = Message::unpacked( $body );
		$this->assertSame( Message::TM_COMMAND | Message::TM_RESPONSE, $message[ Message::TYPE ] );
		$this->assertSame( 'cmd-1', $message[ Message::ID ] );
		// Response VALUE rides as a live `['name'=>,'payload'=>]` array.
		$payload = $message[ Message::VALUE ];
		$this->assertSame( 'echo', $payload['name'] );
		$this->assertSame( 'got: hi', $payload['payload'] );
	}

	public function test_log_verb_broadcasts_its_stderr_line_into_the_jsonl_body(): void {
		// `log` is a BROADCAST verb (unlike `echo`, which replies): it writes a
		// stderr line and returns nothing. In the ephemeral /command process the
		// wired stderr sink is `_http`, so the line rides back as a JSONL body
		// record (a bare TM_BYTESTREAM, not a command response). This is how `log`
		// at cwd /_sse · /_http surfaces in the browser console.
		$this->build_graph();
		$req = $this->make_request(
			[
				'type'  => Message::TM_COMMAND,
				'to'    => '',
				'from'  => '_http',
				'id'    => 'cmd-log',
				'value' => [ 'name' => 'log', 'arguments' => [ 'hello', 'world' ], 'payload' => '' ],
			]
		);

		$ctrl = new HTTP_In_Node();
		$ctrl->set_test_mode( true );
		\ob_start();
		$ctrl->dispatch( $req );
		$body = \ob_get_clean();

		$lines = \array_values( \array_filter( \explode( "\n", $body ), static fn( $l ) => '' !== $l ) );
		$this->assertCount( 1, $lines, 'log broadcasts one stderr line and returns no response' );
		$message = Message::unpacked( $lines[0] );
		$this->assertSame( Message::TM_BYTESTREAM, $message[ Message::TYPE ] );
		$this->assertStringContainsString( 'hello world', (string) $message[ Message::VALUE ] );
		$this->assertStringContainsString( '_command_interpreter:', (string) $message[ Message::VALUE ] );
	}

	public function test_empty_to_command_is_interpreted_by_the_request_scope_interpreter(): void {
		// A command addressed to the request scope itself (TO='') — e.g. the browser
		// `cd /_sse; <verb>` — must be interpreted by the base CommandInterpreter,
		// NOT dropped by _router (which can't peel an empty TO). dispatch sinks
		// through the base interpreter, mirroring the client's Shell → interpreter → _router spine.
		$this->build_graph();

		$req = $this->make_request(
			[
				'type'  => Message::TM_COMMAND,
				'to'    => '',
				'from'  => '_http',
				'id'    => 'cmd-empty',
				'value' => [ 'name' => 'help', 'arguments' => [], 'payload' => '' ],
			]
		);

		$ctrl = new HTTP_In_Node();
		$ctrl->set_test_mode( true );
		\ob_start();
		$ctrl->dispatch( $req );
		$body = \ob_get_clean();

		$this->assertSame( [ 200 ], $this->status_codes );
		$message = Message::unpacked( $body );
		$this->assertSame( Message::TM_COMMAND | Message::TM_RESPONSE, $message[ Message::TYPE ] );
		$this->assertSame( 'cmd-empty', $message[ Message::ID ] );
		$this->assertSame( 'help', $message[ Message::VALUE ]['name'] );
	}

	/**
	 * Ingress used to re-anchor TIMESTAMP to the server clock before signing, so
	 * a browser 20+s skewed still verified. It cannot any more: the minter signs
	 * TIMESTAMP, so it is signed material and re-anchoring would destroy the
	 * signature. The tolerance moved to the mint — /auth reports the server clock
	 * and the client aligns to it — so what ingress must now do is REFUSE a stale
	 * command rather than quietly rescue it.
	 */
	public function test_a_stale_client_timestamp_is_refused_not_rescued(): void {
		$base_interpreter = $this->build_graph();
		$echo             = new Command_Interpreter_Node();
		$echo->name( 'echo_service' );
		$echo->sink( $base_interpreter );
		$ran = [];
		$echo->commands(
			[
				'echo' => static function ( $self, $args ) use ( &$ran ): string {
					$ran[] = \implode( ' ', $args );
					return 'ok';
				},
			]
		);

		// Signed an hour ago — far outside Command_Auth's freshness window.
		$stale                       = Message::new_message();
		$stale[ Message::TYPE ]      = Message::TM_COMMAND;
		$stale[ Message::TIMESTAMP ] = (int) Core::$now - 3600;
		$stale[ Message::TO ]        = 'echo_service';
		$stale[ Message::FROM ]      = '_http';
		$stale[ Message::VALUE ]     = [ 'name' => 'echo', 'arguments' => [ 'hi' ] ];
		Command_Auth::sign( $stale );

		$req = new \WP_REST_Request();
		$req->set_body( Message::packed( $stale ) );
		$req->set_header( 'content-type', 'application/json' );

		$ctrl = new HTTP_In_Node();
		$ctrl->set_test_mode( true );
		\ob_start();
		$ctrl->dispatch( $req );
		\ob_get_clean();

		$this->assertSame( [], $ran, 'a stale command must not execute' );
	}

	public function test_dispatch_routes_a_batch_of_messages_in_order(): void {
		// A request body that is a LIST of packed Messages (not a single one)
		// dispatches each in order through the one request graph. This is what
		// lets the topology dashboard send `connect_worker_input` immediately
		// before its real attached command in the SAME request.
		$base_interpreter = $this->build_graph();
		$echo    = new Command_Interpreter_Node();
		$echo->name( 'echo_service' );
		$echo->sink( $base_interpreter );
		$calls = [];
		$echo->commands(
			[
				'echo' => static function ( $self, $args ) use ( &$calls ): string {
					$calls[] = \implode( ' ', $args );
					return 'got: ' . \implode( ' ', $args );
				},
			]
		);

		$req = $this->make_batch_request(
			[
				[ 'type' => Message::TM_COMMAND, 'to' => 'echo_service', 'from' => '_http', 'id' => 'c1', 'value' => [ 'name' => 'echo', 'arguments' => [ 'one' ], 'payload' => '' ] ],
				[ 'type' => Message::TM_COMMAND, 'to' => 'echo_service', 'from' => '_http', 'id' => 'c2', 'value' => [ 'name' => 'echo', 'arguments' => [ 'two' ], 'payload' => '' ] ],
			]
		);

		$ctrl = new HTTP_In_Node();
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
				'value' => [ 'name' => 'whatever', 'arguments' => [], 'payload' => '' ],
			]
		);

		$ctrl = new HTTP_In_Node();
		$ctrl->set_test_mode( true );
		\ob_start();
		$ctrl->dispatch( $req );
		$body = \ob_get_clean();

		$this->assertSame( [ 200 ], $this->status_codes );
		$message = Message::unpacked( $body );
		$this->assertTrue( (bool) ( $message[ Message::TYPE ] & Message::TM_ERROR ) );
		$this->assertStringContainsString( 'NOT_AVAILABLE', (string) $message[ Message::VALUE ] );
	}

	public function test_blank_from_defaults_to_underscore_http(): void {
		$base_interpreter = $this->build_graph();
		$echo    = new Command_Interpreter_Node();
		$echo->name( 'echo_service' );
		$echo->sink( $base_interpreter );
		$echo->commands( [ 'echo' => static fn( $self, $args ): string => 'ok' ] );

		$req = $this->make_request(
			[
				'type'  => Message::TM_COMMAND,
				'to'    => 'echo_service',
				'id'    => 'cmd-3',
				'value' => [ 'name' => 'echo', 'arguments' => [], 'payload' => '' ],
			]
		);

		$ctrl = new HTTP_In_Node();
		$ctrl->set_test_mode( true );
		\ob_start();
		$ctrl->dispatch( $req );
		$body = \ob_get_clean();

		$this->assertNotSame( '', $body );
		$message = Message::unpacked( $body );
		$this->assertSame( 'cmd-3', $message[ Message::ID ] );
	}

	public function test_dispatch_without_pregraph_lazy_builds_and_fires_request_graph_ready_hook(): void {
		// Production REST entry point has no prior bootstrap building the
		// request-scope graph for it. Dispatch must lazy-build _router /
		// _command_interpreter / _output and fire the
		// `newspack_nodes/request_graph_ready` hook so applications can
		// mount their interpreters via $base_interpreter->make_node(...).
		$this->assertNull( Core::node( '_router' ), 'pre-condition: no graph yet' );
		$this->assertNull( Core::node( '_command_interpreter' ) );
		$this->assertNull( Core::node( '_output' ) );

		// Capture hook fires and the interpreter argument the hook receives.
		$fires = [];
		\add_action(
			'newspack_nodes/request_graph_ready',
			static function ( $base_interpreter ) use ( &$fires ): void {
				$fires[] = $base_interpreter;
				// Application code mounts its interpreters here. Use a tiny echo interpreter
				// to prove dispatch can route through a hook-mounted interpreter.
				$echo = new Command_Interpreter_Node();
				$echo->name( 'hook_echo' );
				$echo->sink( $base_interpreter );
				$echo->commands(
					[ 'echo' => static fn( $self, $args ): string => 'got: ' . \implode( ' ', $args ) ]
				);
			}
		);

		$req = $this->make_request(
			[
				'type'  => Message::TM_COMMAND,
				'to'    => 'hook_echo',
				'from'  => '_http',
				'id'    => 'cmd-lazy-1',
				'value' => [ 'name' => 'echo', 'arguments' => [ 'hi' ], 'payload' => '' ],
			]
		);

		$ctrl = new HTTP_In_Node();
		$ctrl->set_test_mode( true );
		\ob_start();
		$ctrl->dispatch( $req );
		$body = (string) \ob_get_clean();

		// Hook fired exactly once with the base interpreter as the argument.
		$this->assertCount( 1, $fires, 'request_graph_ready hook must fire exactly once' );
		$this->assertInstanceOf( Command_Interpreter_Node::class, $fires[0] );
		$this->assertSame( '_command_interpreter', $fires[0]->name() );

		// Dispatch produced a TM_COMMAND|TM_RESPONSE (not the "graph not
		// initialized" error). Use the production HTTP_In (not the test
		// seam) — status_header is a stub in our bootstrap, so it's harmless.
		$this->assertNotSame( '', $body, 'dispatch produced no body' );
		$message            = Message::unpacked( $body );
		$response_flags = Message::TM_COMMAND | Message::TM_RESPONSE;
		$this->assertSame(
			$response_flags,
			$message[ Message::TYPE ] & ( $response_flags | Message::TM_ERROR ),
			'dispatch returned TM_ERROR — request graph was not lazy-built'
		);
		$this->assertSame( 'cmd-lazy-1', $message[ Message::ID ] );
		$payload = $message[ Message::VALUE ];
		$this->assertSame( 'got: hi', $payload['payload'] );
	}

	public function test_dispatch_lazy_init_is_idempotent_when_graph_already_present(): void {
		// Pre-build the graph (as a real Bootstrap would for non-REST entry
		// points) and prove that the second dispatch doesn't double-create
		// or re-fire the hook.
		$base_interpreter = $this->build_graph();
		$echo    = new Command_Interpreter_Node();
		$echo->name( 'idem_echo' );
		$echo->sink( $base_interpreter );
		$echo->commands( [ 'echo' => static fn( $self, $args ): string => 'ok' ] );

		$pre_router  = Core::node( '_router' );
		$pre_base_interpreter = Core::node( '_command_interpreter' );
		$pre_output  = Core::node( '_output' );

		$fires = [];
		\add_action(
			'newspack_nodes/request_graph_ready',
			static function ( $interpreter ) use ( &$fires ): void {
				$fires[] = $interpreter;
			}
		);

		$req = $this->make_request(
			[
				'type'  => Message::TM_COMMAND,
				'to'    => 'idem_echo',
				'from'  => '_http',
				'id'    => 'cmd-idem',
				'value' => [ 'name' => 'echo', 'arguments' => [], 'payload' => '' ],
			]
		);
		$ctrl = new HTTP_In_Node();
		$ctrl->set_test_mode( true );
		\ob_start();
		$ctrl->dispatch( $req );
		\ob_get_clean();

		// Graph nodes are the SAME instances — no re-creation.
		$this->assertSame( $pre_router,  Core::node( '_router' ) );
		$this->assertSame( $pre_base_interpreter, Core::node( '_command_interpreter' ) );
		$this->assertSame( $pre_output,  Core::node( '_output' ) );

		// Hook still fires (application code may need to mount per-request).
		$this->assertCount( 1, $fires );
		$this->assertSame( $pre_base_interpreter, $fires[0] );
	}

	/**
	 * `newspack_nodes_mount_substrate_cis` must be safe to invoke twice within
	 * one PHP process. The action it's hooked to (`request_graph_ready`) fires
	 * once per `HTTP_In::dispatch`, but production has seen the
	 * action handler run twice in a single request — likely via plugin file
	 * re-loaded by some bootstrap path — and the second call fatals with
	 * `node name collision: workers already registered`. That kills the whole
	 * REST response with a 500. Idempotency is the cheap fix: skip if the interpreters
	 * are already mounted under this base interpreter.
	 */
	public function test_mount_substrate_cis_is_idempotent(): void {
		$base_interpreter = $this->build_graph();
		$names   = [ 'classes', 'layouts', 'topologies', 'raw-logs', 'workers' ];

		\newspack_nodes_mount_substrate_cis( $base_interpreter );
		foreach ( $names as $name ) {
			$this->assertNotNull( Core::node( $name ), "first mount must create '{$name}'" );
		}

		// Second invocation must not throw "node name collision".
		\newspack_nodes_mount_substrate_cis( $base_interpreter );

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
		$worker_partition = new Partition_Node();
		$worker_partition->arguments( [ "{$input_dir}" ] );
		$worker_partition->name( 'firehose-workers.p0' );

		$req = $this->make_request(
			[
				'type'  => Message::TM_COMMAND,
				'to'    => 'firehose-workers.p0/_command_interpreter',
				'from'  => '_http/4242',  // attached: SSE process pid
				'id'    => 'cmd-xyz',
				'value' => [ 'name' => 'dump_metadata', 'arguments' => [], 'payload' => '' ],
			]
		);

		$ctrl = new HTTP_In_Node();
		$ctrl->set_test_mode( true );
		\ob_start();
		$ctrl->dispatch( $req );
		$body = \ob_get_clean();

		// Routed onward (no in-process reply): the controller emits a bare 202 with
		// no body. The send_header seam isn't used (that's only HTTP_In::fill's
		// response-writer path); the client treats an empty response as "nothing to route."
		$this->assertEmpty( $this->status_codes );
		$this->assertSame( '', $body );

		// Verify the message landed at the worker's input partition with TO peeled.
		// Per Task 19 implementer's findings, Partition batches writes; flush
		// manually before reading via Consumer.
		$worker_partition->flush();

		$consumer = new Consumer_Node();
		$consumer->arguments( [ "{$input_dir}" ] );
		$consumer->next_offset( 'start' );
		$consumer->sink( $got = new \Newspack_Nodes\Tests\Capture_Sink_Node() );
		$this->pump_consumer( $consumer );
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

		( new HTTP_In_Node() )->register_routes();

		$this->assertCount( 1, $GLOBALS['_wp_test_registered_routes'] );
		$route = $GLOBALS['_wp_test_registered_routes'][0];
		$this->assertSame( 'newspack-nodes/v1', $route['namespace'] );
		$this->assertSame( '/command', $route['route'] );
		$this->assertSame( 'POST', $route['args']['methods'] );
		$this->assertIsCallable( $route['args']['callback'] );
		$this->assertIsCallable( $route['args']['permission_callback'] );
	}

	// ── check_permission: capability + rate limit ─────────────────────────

	/**
	 * Reset rate-limit state between assertions. The rate-limit reads from /
	 * writes to the transient store and reads `get_current_user_id()` —
	 * clearing both keeps test cases independent.
	 */
	private function reset_rl_state(): void {
		$GLOBALS['_wp_test_transients']       = [];
		$GLOBALS['_wp_test_current_user_can'] = [];
		$GLOBALS['_wp_test_current_user_id']  = 0;
		$GLOBALS['_wp_actions']               = [];
		HTTP_In_Node::$rate_limit_disabled    = false;
	}

	public function test_check_permission_rejects_when_user_lacks_manage_options(): void {
		$this->reset_rl_state();
		// No capability granted.
		$ctrl = new HTTP_In_Node();
		$req  = new \WP_REST_Request( 'POST' );

		$result = $ctrl->check_permission( $req );

		$this->assertNotTrue( $result, 'lacking manage_options must NOT pass permission' );
	}

	public function test_check_permission_accepts_under_the_cap(): void {
		$this->reset_rl_state();
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		$GLOBALS['_wp_test_current_user_id']                    = 7;

		$ctrl = new HTTP_In_Node();
		$req  = new \WP_REST_Request( 'POST' );

		$this->assertTrue( $ctrl->check_permission( $req ) );
	}

	public function test_check_permission_returns_429_after_burst_exceeded(): void {
		$this->reset_rl_state();
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		$GLOBALS['_wp_test_current_user_id']                    = 7;

		$ctrl = new HTTP_In_Node();
		$req  = new \WP_REST_Request( 'POST' );

		// Burn through the burst budget. Every one of these must pass.
		for ( $i = 0; $i < HTTP_In_Node::RATE_LIMIT_BURST; $i++ ) {
			$this->assertTrue(
				$ctrl->check_permission( $req ),
				"request #{$i} (under cap) must pass"
			);
		}

		// One more in the same window must trip the limit.
		$result = $ctrl->check_permission( $req );
		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'rate_limited', $result->get_error_code() );
		$data = $result->get_error_data();
		$this->assertSame( 429, $data['status'] );
	}

	public function test_steady_one_request_per_second_never_trips_the_limit(): void {
		// Repro of the production complaint: a single client polling /command
		// at 1 req/sec eventually got a 429. The old bucket implementation
		// re-set the transient TTL on every write, so a steady stream NEVER
		// let the window expire — the counter just grew until it hit BURST
		// (after ~30 seconds at 1/s). The fix is per-second buckets: each
		// floor(microtime) gets its own counter, so 1 req/sec stays at
		// count=1 per bucket forever.
		$this->reset_rl_state();
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		$GLOBALS['_wp_test_current_user_id']                    = 7;

		$ctrl = new HTTP_In_Node();
		$req  = new \WP_REST_Request( 'POST' );

		// Run 5 * BURST one-per-second iterations. None may 429.
		$base = 1700000000.0;
		for ( $i = 0; $i < HTTP_In_Node::RATE_LIMIT_BURST * 5; $i++ ) {
			HTTP_In_Node::$clock_now_seam = $base + $i; // each iteration is a fresh second
			$result                       = $ctrl->check_permission( $req );
			$this->assertTrue(
				$result,
				"steady 1 req/sec iteration #{$i} must pass (got "
					. ( $result instanceof \WP_Error ? $result->get_error_code() : 'non-WP_Error' )
					. ')'
			);
		}
		HTTP_In_Node::$clock_now_seam = null;
	}

	public function test_rate_limit_counter_resets_after_window_expires(): void {
		$this->reset_rl_state();
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		$GLOBALS['_wp_test_current_user_id']                    = 7;

		$ctrl = new HTTP_In_Node();
		$req  = new \WP_REST_Request( 'POST' );

		// Saturate the window.
		for ( $i = 0; $i < HTTP_In_Node::RATE_LIMIT_BURST; $i++ ) {
			$ctrl->check_permission( $req );
		}
		$this->assertInstanceOf( \WP_Error::class, $ctrl->check_permission( $req ) );

		// Simulate window expiry by purging the per-user transient (the
		// bootstrap's transient store is keyed by name; deleting it is
		// observationally identical to the entry having timed out).
		$GLOBALS['_wp_test_transients'] = [];

		$this->assertTrue(
			$ctrl->check_permission( $req ),
			'after the window expires the counter must reset and pass again'
		);
	}

	public function test_rate_limit_is_per_user(): void {
		$this->reset_rl_state();
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;

		$ctrl = new HTTP_In_Node();
		$req  = new \WP_REST_Request( 'POST' );

		// User 7 saturates their bucket.
		$GLOBALS['_wp_test_current_user_id'] = 7;
		for ( $i = 0; $i < HTTP_In_Node::RATE_LIMIT_BURST; $i++ ) {
			$ctrl->check_permission( $req );
		}
		$this->assertInstanceOf( \WP_Error::class, $ctrl->check_permission( $req ) );

		// User 9 — separate counter — is still under the cap.
		$GLOBALS['_wp_test_current_user_id'] = 9;
		$this->assertTrue( $ctrl->check_permission( $req ) );
	}

	public function test_rate_limit_disabled_static_bypasses_the_limit(): void {
		$this->reset_rl_state();
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		$GLOBALS['_wp_test_current_user_id']                    = 7;

		HTTP_In_Node::$rate_limit_disabled = true;

		$ctrl = new HTTP_In_Node();
		$req  = new \WP_REST_Request( 'POST' );

		// Far past the burst cap — bypass means every call passes.
		for ( $i = 0; $i < HTTP_In_Node::RATE_LIMIT_BURST * 5; $i++ ) {
			$this->assertTrue(
				$ctrl->check_permission( $req ),
				"request #{$i} must pass while rate_limit_disabled is true"
			);
		}

		// Restore to keep other tests honest.
		HTTP_In_Node::$rate_limit_disabled = false;
	}

	public function test_register_routes_wires_check_permission_as_permission_callback(): void {
		$this->reset_rl_state();
		$GLOBALS['_wp_test_registered_routes'] = [];

		( new HTTP_In_Node() )->register_routes();

		$route = $GLOBALS['_wp_test_registered_routes'][0];
		// The permission callback must be the controller's check_permission
		// method (so it can rate-limit), not a bare manage_options closure.
		$cb = $route['args']['permission_callback'];
		$this->assertIsArray( $cb );
		$this->assertInstanceOf( HTTP_In_Node::class, $cb[0] );
		$this->assertSame( 'check_permission', $cb[1] );
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
				Core::register_node( '_router', new Command_Interpreter_Node() );
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

		$ctrl = new HTTP_In_Node();
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
		$writer  = new HTTP_In_Node(
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
		// JSONL: one packed Message per line.
		$this->assertSame( Message::packed( $m ) . "\n", $out );
		$this->assertTrue( $writer->sent_headers );
	}

	public function test_subsequent_fills_dont_re_send_headers_but_still_echo(): void {
		$headers = [];
		$writer  = new HTTP_In_Node(
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
		// JSONL: one packed Message per line (newline-delimited).
		$this->assertSame(
			Message::packed( $a ) . "\n" . Message::packed( $b ) . "\n",
			$out
		);
	}

	public function test_default_send_header_closure_invokes_status_header_when_none_supplied(): void {
		// Constructor null-coalesces to a closure wrapping the real
		// \status_header(). Without a fed seam, we still need to prove that
		// branch executes on first fill — otherwise the production path is
		// uncovered. Bootstrap stubs status_header() to push the code into
		// $GLOBALS['_wp_test_status_headers'] so we can assert the default
		// closure actually called it.
		$GLOBALS['_wp_test_status_headers'] = [];
		$writer                             = new HTTP_In_Node();

		\ob_start();
		$m = Message::new_message();
		$writer->fill( $m );
		$out = \ob_get_clean();

		$this->assertTrue( $writer->sent_headers );
		// JSONL: one packed Message per line.
		$this->assertSame( Message::packed( $m ) . "\n", $out );
		$this->assertSame( [ 200 ], $GLOBALS['_wp_test_status_headers'] );
	}

	public function test_node_schema_is_hidden_with_empty_ctor_and_verbs(): void {
		// HTTP_In is bootstrap-instantiated at request scope only — never via
		// `make_node` from a topology. Hidden category + empty ctor/verbs
		// locks that contract.
		$schema = HTTP_In_Node::node_schema();
		$this->assertSame( 'Hidden', $schema['category'] );
		$this->assertSame( [], $schema['arguments'] );
		$this->assertSame( [], $schema['commands'] );
		$this->assertNotEmpty( $schema['description'] );
	}

	public function test_reset_allows_fresh_status_header_on_next_fill(): void {
		$headers = [];
		$writer  = new HTTP_In_Node(
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
