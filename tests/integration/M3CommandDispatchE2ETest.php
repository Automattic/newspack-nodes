<?php
/**
 * M3CommandDispatchE2ETest: M3 acceptance test for the whole substrate stack.
 *
 * Proves that every substrate CI mounted by the substrate plugin's
 * `newspack_nodes/request_graph_ready` listener (Classes_CI, Layouts_CI,
 * Topologies_CI) responds end-to-end to a representative verb when
 * driven through the production `Command_Controller` endpoint. The
 * path under test:
 *
 *   POST /newspack-nodes/v1/command  →  Command_Controller::dispatch
 *                                    →  ensure_request_graph (lazy-builds
 *                                       _router / _command_interpreter / _http)
 *                                    →  do_action newspack_nodes/request_graph_ready
 *                                       (mount hook installs each substrate CI
 *                                       via $base_ci->make_node())
 *                                    →  Router (peels TO head)
 *                                    →  substrate CI (interpret + run verb)
 *                                    →  CI sink → base CI → Router
 *                                    →  HTTP_Out (writes packed Message)
 *                                    →  ob_get_clean captures the body
 *
 * Mirrors the application-side M2CommandDispatchE2ETest in
 * newspack-event-logger-nodes — same test pattern, same uniform path,
 * different CIs. Layouts_CI checks `manage_options` per-verb, so
 * setUp seeds `_wp_test_current_user_can`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Rest\Command_Controller;
use Newspack_Nodes\Tests\TestCase;

class M3CommandDispatchE2ETest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		// Wipe the hook store and re-attach exactly one mount callback so
		// dataProvider iterations don't double-register the same hook (which
		// would collide on node names on the second tick — `name()` throws
		// on collision and `make_node()` always constructs a fresh instance).
		// Mirrors M2's pattern in newspack-event-logger-nodes.
		$GLOBALS['_wp_actions'] = [];
		\add_action( 'newspack_nodes/request_graph_ready', 'newspack_nodes_mount_substrate_cis' );

		// Layouts_CI verbs check `current_user_can( 'manage_options' )`.
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;

		// Seed Config::load_config()['base_directory'] so Layouts_CI's
		// filesystem path resolves under a per-test tmp dir. (Layouts_CI
		// `get` returns positions=null when the .layout file doesn't
		// exist — exactly what we want for the read-only round-trip.)
		// `use_base_dir()` writes a config file into the directory, so the
		// directory must exist first — `make_temp_dir()` mkdirs it.
		$this->use_base_dir( $this->make_temp_dir( 'm3-e2e-' ) );
	}

	protected function tearDown(): void {
		Core::reset();
		unset( $GLOBALS['_wp_test_current_user_can']['manage_options'] );
		parent::tearDown();
	}

	/**
	 * @dataProvider verb_provider
	 */
	public function test_each_substrate_ci_responds_to_a_representative_verb( string $to, string $verb, mixed $payload ): void {
		$ctrl = new Command_Controller();
		$ctrl->set_test_mode( true );
		\ob_start();
		$ctrl->dispatch( $this->build_request( $to, $verb, $payload ) );
		$body = (string) \ob_get_clean();

		$this->assertNotEmpty( $body, "verb '{$verb}' on '{$to}' produced no response" );
		$msg            = Message::unpacked( $body );
		$response_flags = Message::TM_COMMAND | Message::TM_RESPONSE;
		$this->assertSame(
			"e2e-{$verb}",
			$msg[ Message::ID ],
			"verb '{$verb}' returned wrong correlation id"
		);
		$this->assertSame(
			$response_flags,
			$msg[ Message::TYPE ] & ( $response_flags | Message::TM_ERROR ),
			// VALUE is a live array now — json-encode it for the failure
			// message so the diagnostic is readable, not "Array".
			"verb '{$verb}' returned TM_ERROR or wrong type. VALUE was: " . (string) \wp_json_encode( $msg[ Message::VALUE ] )
		);
	}

	/**
	 * The substrate's bundled WP_REST_Request stub already exposes
	 * get_body() / set_body() / set_header(), so unlike M2 (event-logger-
	 * nodes) no anonymous-class subclass is needed here.
	 */
	private function build_request( string $to, string $verb, mixed $payload ): \WP_REST_Request {
		// The controller requires a packed 7-element positional Message
		// (`Message::unpacked()`), so build one rather than a keyed object.
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND;
		$msg[ Message::FROM ]  = '_http';
		$msg[ Message::TO ]    = $to;
		$msg[ Message::ID ]    = "e2e-{$verb}";
		// VALUE is the command struct as a live PHP array — Message::packed
		// JSON-encodes the whole envelope (the wire), and the controller's
		// messages_from_body() decodes it back, restoring VALUE as a nested array.
		$msg[ Message::VALUE ] = [ 'name' => $verb, 'arguments' => '', 'payload' => $payload ];

		$req = new \WP_REST_Request();
		$req->set_body( Message::packed( $msg ) );
		// JSONL-as-text/plain is the command contract (the controller ignores
		// the header, but keep it consistent with the surrounding comments).
		$req->set_header( 'content-type', 'text/plain; charset=UTF-8' );
		return $req;
	}

	/**
	 * Representative verb per substrate CI. Each verb is read-only and
	 * takes either no payload or a minimal safe one. Verbs that mutate
	 * (save / delete) trigger side effects like `restart_fleet` and are
	 * covered by per-verb tests — this test proves the dispatch path,
	 * not that every verb is implemented correctly.
	 *
	 * @return array<string,array{string,string,mixed}>
	 */
	public static function verb_provider(): array {
		return [
			'classes.list'    => [ 'classes',    'list', null ],
			'layouts.get'     => [ 'layouts',    'get',  [ 'name' => 'fresh' ] ],
			'topologies.list' => [ 'topologies', 'list', null ],
		];
	}
}
