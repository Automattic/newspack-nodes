<?php
/**
 * ServiceCITest: unit tests for the Service_CI base class — three shared
 * verb-helper seams (require_manage_options, decode_args, require_valid_name)
 * that substrate + application interpreters both reach for. Tests exercise each
 * helper via a transparent subclass that exposes them publicly so the
 * helpers can be asserted in isolation, without dragging in VerbHarness +
 * the request-scope interpreter graph.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Service_CI_Node::class )]
class ServiceCITest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		// Deny by default so the manage_options happy path is explicit.
		$GLOBALS['_wp_test_current_user_can'] = [];
	}

	protected function tearDown(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		parent::tearDown();
	}

	// ── require_manage_options ───────────────────────────────────────────────

	public function test_require_manage_options_passes_when_capability_granted(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		// No assertion needed — just confirm it doesn't throw.
		ServiceCITestProbe::require_manage_options_probe();
		$this->assertTrue( true );
	}

	public function test_require_manage_options_throws_when_capability_denied(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'permission denied: manage_options required' );
		ServiceCITestProbe::require_manage_options_probe();
	}

	// ── require_valid_name ───────────────────────────────────────────────────

	public function test_require_valid_name_returns_name_when_valid(): void {
		$this->assertSame(
			'my-topology_42',
			ServiceCITestProbe::require_valid_name_probe( 'my-topology_42' )
		);
	}

	public function test_require_valid_name_throws_when_name_empty(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'invalid name' );
		ServiceCITestProbe::require_valid_name_probe( '' );
	}

	public function test_require_valid_name_throws_when_name_violates_default_pattern(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'invalid name' );
		ServiceCITestProbe::require_valid_name_probe( 'has spaces' );
	}

	public function test_require_valid_name_throws_on_path_traversal_attempt(): void {
		$this->expectException( \RuntimeException::class );
		ServiceCITestProbe::require_valid_name_probe( '../etc/passwd' );
	}

	public function test_require_valid_name_respects_custom_pattern(): void {
		// Custom pattern allows colons + dots (the layout-id pattern).
		$this->assertSame(
			'firehose:partition.config',
			ServiceCITestProbe::require_valid_name_probe(
				'firehose:partition.config',
				'/^[a-zA-Z0-9_:.-]+$/'
			)
		);
	}

	public function test_require_valid_name_rejects_when_custom_pattern_excludes_it(): void {
		$this->expectException( \RuntimeException::class );
		ServiceCITestProbe::require_valid_name_probe(
			'has-dash',
			'/^[a-zA-Z0-9_]+$/'
		);
	}

	// ── central gate: commands_from_schema wraps EVERY verb ──────────────────

	public function test_schema_verb_is_denied_without_manage_options(): void {
		// The probe's `ping` verb itself never calls require_manage_options;
		// the gate must come from commands_from_schema wrapping it. With the
		// cap denied (default) the dispatch must return the permission-error
		// string, not the verb's sentinel.
		$result = VerbHarness::fire( new ServiceCITestProbe(), 'probe', 'ping' );
		$this->assertSame( 'permission denied: manage_options required', $result );
	}

	public function test_schema_verb_runs_with_manage_options(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		$result = VerbHarness::fire( new ServiceCITestProbe(), 'probe', 'ping' );
		$this->assertSame( 'pong', $result );
	}

	public function test_auto_injected_help_is_also_gated(): void {
		// `help` is injected by the base commands() accessor, not declared in the
		// schema — so the gate must catch it too, else it's an ungated bypass.
		$result = VerbHarness::fire( new ServiceCITestProbe(), 'probe', 'help' );
		$this->assertSame( 'permission denied: manage_options required', $result );
	}

	public function test_auto_injected_help_runs_after_manage_options_gate_passes(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;

		$result = VerbHarness::fire( new ServiceCITestProbe(), 'probe', 'help' );

		$this->assertStringContainsString( 'help', $result );
		$this->assertStringContainsString( 'ping', $result );
	}

	public function test_schema_with_non_array_commands_installs_no_service_verbs(): void {
		$probe = new ServiceCINonArrayCommandsProbe();

		$this->assertSame( [ 'help' ], \array_keys( $probe->commands() ) );
	}

	public function test_schema_skips_non_array_verb_entries(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;

		$result = VerbHarness::fire( new ServiceCINonArrayVerbProbe(), 'probe', 'ok' );

		$this->assertSame( 'ok', $result );
	}

	public function test_split_first_token_preserves_verbatim_remainder(): void {
		$this->assertSame(
			[ 'save', "topology-name make_node Echo e\n" ],
			ServiceCITestProbe::split_first_token_probe( "  save topology-name make_node Echo e\n" )
		);
	}

	public function test_split_first_token_returns_empty_remainder_for_lone_token(): void {
		$this->assertSame(
			[ 'status', '' ],
			ServiceCITestProbe::split_first_token_probe( '  status  ' )
		);
	}

	// ── slice_verb: shape fn → JSON-returning handler ────────────────────────

	public function test_slice_verb_builds_handler_that_json_encodes_the_shape(): void {
		$handler = ServiceCITestProbe::slice_verb_probe(
			static fn ( Command_Interpreter_Node $ci ): array => [ 'ok' => 1 ]
		);
		$interpreter = new ServiceCITestProbe();

		$this->assertSame( '{"ok":1}', $handler( $interpreter, '' ) );
	}

	public function test_slice_verb_passes_the_interpreter_to_the_shape(): void {
		$ci = new ServiceCITestProbe();
		$ci->name( 'probe-named' );
		$handler = ServiceCITestProbe::slice_verb_probe(
			static fn ( Command_Interpreter_Node $self ): array => [ 'name' => $self->name() ]
		);

		$this->assertSame( '{"name":"probe-named"}', $handler( $ci, '' ) );
	}

	public function test_slice_verb_handler_is_gated_when_registered_through_schema(): void {
		// The slice handler itself never self-gates; registering it via node_schema
		// must let commands_from_schema's central wrapper deny it without the cap.
		$result = VerbHarness::fire( new ServiceCISliceVerbProbe(), 'probe', 'slice' );
		$this->assertSame( 'permission denied: manage_options required', $result );
	}

	public function test_slice_verb_handler_runs_through_schema_with_manage_options(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;

		$result = VerbHarness::fire( new ServiceCISliceVerbProbe(), 'probe', 'slice' );

		$this->assertSame( '{"sliced":true}', $result );
	}
}

/**
 * Subclass that re-exports Service_CI's protected helpers as public static
 * methods. The helpers are protected because the legitimate callers are
 * subclass closures (which can use `self::`); tests need a public surface
 * to invoke them in isolation. Constructing the probe is not required —
 * the helpers are static.
 */
class ServiceCITestProbe extends Service_CI_Node {

	public static function require_manage_options_probe(): void {
		self::require_manage_options();
	}

	public static function require_valid_name_probe(
		string $name,
		string $pattern = '/^[a-zA-Z0-9_-]+$/'
	): string {
		return self::require_valid_name( $name, $pattern );
	}

	public static function split_first_token_probe( string $args ): array {
		return self::split_first_token( $args );
	}

	public static function slice_verb_probe( callable $shape ): \Closure {
		return self::slice_verb( $shape );
	}

	/**
	 * One verb whose handler does NOT self-gate — so any auth must come from
	 * the base's central wrapper in commands_from_schema(). Returns a sentinel
	 * the gate test asserts against.
	 */
	public static function node_schema(): array {
		return [
			'category' => 'Hidden',
			'commands' => [
				[
					'name'        => 'ping',
					'description' => 'Probe verb that returns a sentinel; never self-gates.',
					'handler'     => static function ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): string {
						return 'pong';
					},
				],
			],
		];
	}
}

/** Registers a slice_verb()-built handler via node_schema to exercise the central gate end-to-end. */
class ServiceCISliceVerbProbe extends Service_CI_Node {
	public static function node_schema(): array {
		return [
			'category' => 'Hidden',
			'commands' => [
				[
					'name'        => 'slice',
					'description' => 'A slice_verb()-built handler that JSON-encodes a fixed shape.',
					'handler'     => self::slice_verb( static fn ( Command_Interpreter_Node $ci ): array => [ 'sliced' => true ] ),
				],
			],
		];
	}
}

class ServiceCINonArrayCommandsProbe extends Service_CI_Node {
	public static function node_schema(): array {
		return [
			'category' => 'Hidden',
			'commands' => 'not-a-list',
		];
	}
}

class ServiceCINonArrayVerbProbe extends Service_CI_Node {
	public static function node_schema(): array {
		return [
			'category' => 'Hidden',
			'commands' => [
				'not-a-verb',
				[
					'name'    => 'ok',
					'handler' => static fn (): string => 'ok',
				],
			],
		];
	}
}
