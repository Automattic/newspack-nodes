<?php
/**
 * LayoutsCITest: unit tests for Layouts_CI, the M3 service-interpreter for
 * topology layout persistence. Mirrors ClassesCITest's VerbHarness
 * pattern with a per-test filesystem fixture (use_base_dir() points
 * Config at a tmp directory; the verb writes its .layout file under
 * `{base}/layouts/`).
 *
 * The interpreter returns raw payloads (decoded JSON) rather than the legacy
 * {code, message, status} envelopes. Errors bubble as RuntimeException;
 * CommandInterpreter::interpret() catches them and emits TM_COMMAND |
 * TM_ERROR. VerbHarness::fire() unwraps the success payload and
 * surfaces error payloads as plain strings, so tests assert "no
 * exception + decoded shape" on success and "RuntimeException +
 * message" on failure.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Rest\Layouts_CI_Node;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Layouts_CI_Node::class )]
class LayoutsCITest extends TestCase {

	private string $base_dir;

	protected function setUp(): void {
		parent::setUp();
		$this->base_dir = $this->make_temp_dir( 'layouts-ci-' );
		$this->use_base_dir( $this->base_dir );
		// Verbs gate on manage_options; allow it by default. Tests that
		// exercise the denial path override before firing.
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
	}

	protected function tearDown(): void {
		VerbHarness::reset();
		$this->rmdir_recursive( $this->base_dir );
		$GLOBALS['_wp_test_current_user_can'] = [];
		// Restore env var to the bootstrap baseline so the next test that
		// relies on the default config isn't pointed at the deleted per-
		// test config file.
		\putenv(
			'LOCAL_NEWSPACK_NODES_CONF=' . \dirname( __DIR__ ) . '/newspack-nodes-test-config.php'
		);
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	// ── schema + get verb ─────────────────────────────────────────────────

	public function test_node_schema_declares_its_verbs(): void {
		$schema = Layouts_CI_Node::node_schema();
		$names  = \array_map( static fn ( array $v ): string => $v['name'], $schema['commands'] );
		\sort( $names );
		$this->assertSame( [ 'get', 'save' ], $names );
		$this->assertNotEmpty( $schema['description'] );
	}

	public function test_get_returns_null_positions_when_file_missing(): void {
		$result = VerbHarness::fire(
			new Layouts_CI_Node(),
			'layouts',
			'get',
			'never-saved'
		);

		$this->assertIsArray( $result );
		$this->assertSame( 'never-saved', $result['name'] );
		$this->assertNull( $result['positions'] );
	}

	public function test_get_returns_saved_positions(): void {
		\mkdir( "{$this->base_dir}/layouts", 0755, true );
		// Non-whole floats survive json_encode/json_decode as floats.
		$payload = [ 'positions' => [ 'node_a' => [ 10.5, 20.25 ], 'node_b' => [ 0, 0 ] ] ];
		\file_put_contents(
			"{$this->base_dir}/layouts/saved.layout",
			(string) \json_encode( $payload )
		);

		$result = VerbHarness::fire(
			new Layouts_CI_Node(),
			'layouts',
			'get',
			'saved'
		);

		$this->assertSame( 'saved', $result['name'] );
		$this->assertSame(
			[ 'node_a' => [ 10.5, 20.25 ], 'node_b' => [ 0, 0 ] ],
			$result['positions']
		);
	}

	public function test_get_returns_null_positions_when_file_is_garbage_json(): void {
		\mkdir( "{$this->base_dir}/layouts", 0755, true );
		\file_put_contents( "{$this->base_dir}/layouts/garbage.layout", '{not json}' );

		$result = VerbHarness::fire(
			new Layouts_CI_Node(),
			'layouts',
			'get',
			'garbage'
		);

		$this->assertSame( 'garbage', $result['name'] );
		$this->assertNull( $result['positions'] );
	}

	public function test_get_returns_null_positions_when_positions_key_absent(): void {
		\mkdir( "{$this->base_dir}/layouts", 0755, true );
		\file_put_contents(
			"{$this->base_dir}/layouts/no-positions.layout",
			(string) \json_encode( [ 'something_else' => true ] )
		);

		$result = VerbHarness::fire(
			new Layouts_CI_Node(),
			'layouts',
			'get',
			'no-positions'
		);

		$this->assertNull( $result['positions'] );
	}

	public function test_get_strips_extra_top_level_keys(): void {
		// Even if the saved file has extra top-level keys, the response only
		// surfaces `positions`.
		\mkdir( "{$this->base_dir}/layouts", 0755, true );
		\file_put_contents(
			"{$this->base_dir}/layouts/extra.layout",
			(string) \json_encode(
				[
					'positions' => [ 'n' => [ 1, 2 ] ],
					'secret'    => 'leaked?',
				]
			)
		);

		$result = VerbHarness::fire(
			new Layouts_CI_Node(),
			'layouts',
			'get',
			'extra'
		);

		$this->assertArrayHasKey( 'positions', $result );
		$this->assertArrayNotHasKey( 'secret', $result );
	}

	public function test_get_rejects_invalid_name(): void {
		// Substrate interpreter contract: verb throws RuntimeException →
		// CommandInterpreter::interpret() catches it and emits the
		// message string as a TM_COMMAND|TM_ERROR payload. VerbHarness
		// returns the raw string (the message isn't valid JSON).
		$result = VerbHarness::fire(
			new Layouts_CI_Node(),
			'layouts',
			'get',
			[ 'bad name!' ]
		);
		$this->assertIsString( $result );
		$this->assertStringContainsString( 'invalid name', $result );
	}

	public function test_get_rejects_name_with_slash(): void {
		$result = VerbHarness::fire(
			new Layouts_CI_Node(),
			'layouts',
			'get',
			'a/b'
		);
		$this->assertIsString( $result );
		$this->assertStringContainsString( 'invalid name', $result );
	}

	public function test_get_rejects_without_manage_options(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$result = VerbHarness::fire(
			new Layouts_CI_Node(),
			'layouts',
			'get',
			'anything'
		);
		$this->assertIsString( $result );
		$this->assertStringContainsString( 'permission denied', $result );
	}

	// ── save verb ─────────────────────────────────────────────────────────

	public function test_save_writes_clean_positions_and_returns_payload(): void {
		$result = VerbHarness::fire(
			new Layouts_CI_Node(),
			'layouts',
			'save',
			'happy ' . (string) \json_encode( [
				'node_a' => [ 10.5, 20.5 ],
				'node_b' => [ -3, 7.25 ],
			] )
		);

		$this->assertSame( 'happy', $result['name'] );
		$this->assertSame( "{$this->base_dir}/layouts/happy.layout", $result['path'] );
		// Whole floats are JSON-normalized to ints in transit through
		// the verb's wp_json_encode + the harness's json_decode — so
		// -3.0 round-trips as int -3. Non-whole floats survive.
		$this->assertEquals(
			[
				'node_a' => [ 10.5, 20.5 ],
				'node_b' => [ -3, 7.25 ],
			],
			$result['positions']
		);

		// File on disk holds the same JSON shape.
		$on_disk = \json_decode( (string) \file_get_contents( $result['path'] ), true );
		$this->assertEquals(
			[ 'node_a' => [ 10.5, 20.5 ], 'node_b' => [ -3, 7.25 ] ],
			$on_disk['positions']
		);
	}

	public function test_save_creates_layouts_dir_if_missing(): void {
		$this->assertDirectoryDoesNotExist( "{$this->base_dir}/layouts" );

		VerbHarness::fire(
			new Layouts_CI_Node(),
			'layouts',
			'save',
			'first ' . (string) \json_encode( [ 'n' => [ 1, 2 ] ] )
		);

		$this->assertDirectoryExists( "{$this->base_dir}/layouts" );
	}

	public function test_save_then_get_round_trips_positions(): void {
		$interpreter = new Layouts_CI_Node();
		VerbHarness::fire(
			$interpreter,
			'layouts',
			'save',
			'roundtrip ' . (string) \json_encode( [
				'alpha' => [ 100.5, 200.25 ],
				'beta'  => [ -50.5, 75.25 ],
			] )
		);
		VerbHarness::reset();

		$result = VerbHarness::fire(
			new Layouts_CI_Node(),
			'layouts',
			'get',
			'roundtrip'
		);

		$this->assertSame(
			[ 'alpha' => [ 100.5, 200.25 ], 'beta' => [ -50.5, 75.25 ] ],
			$result['positions']
		);
	}

	public function test_save_drops_invalid_position_entries(): void {
		// Mix valid + invalid in a single call: non-string ID (int),
		// id-with-disallowed-chars, non-array value, too-few-coords, and
		// non-finite coordinates. The valid entry must survive; the
		// invalid ones must be dropped silently.
		// "42" is the only string-key that decodes to an integer key in
		// PHP — verifies the is_string() guard.
		$positions = [
			'keep_me'   => [ 1, 2 ],
			'bad node!' => [ 3, 4 ],
			'also/bad'  => [ 5, 6 ],
			'bad_val'   => 'not-an-array',
			'too_short' => [ 1 ],
			'bad_inf'   => [ '1e500', 2 ],
			'42'        => [ 7, 8 ],
		];

		$result = VerbHarness::fire( new Layouts_CI_Node(), 'layouts', 'save', [ 'mixed', (string) \json_encode( $positions ) ] );

		$clean = $result['positions'];
		$this->assertArrayHasKey( 'keep_me', $clean );
		$this->assertArrayNotHasKey( 'bad node!', $clean );
		$this->assertArrayNotHasKey( 'also/bad', $clean );
		$this->assertArrayNotHasKey( 'bad_val', $clean );
		$this->assertArrayNotHasKey( 'too_short', $clean );
		$this->assertArrayNotHasKey( 'bad_inf', $clean );
		$this->assertArrayNotHasKey( 42, $clean );
		$this->assertArrayNotHasKey( '42', $clean );
	}

	public function test_save_accepts_dotted_and_colon_node_ids(): void {
		$result = VerbHarness::fire(
			new Layouts_CI_Node(),
			'layouts',
			'save',
			'compound ' . (string) \json_encode( [
				'requests:partition:config' => [ 1, 2 ],
				'firehose.in'               => [ 3, 4 ],
				'node-with-dash'            => [ 5, 6 ],
				'node_with_underscore'      => [ 7, 8 ],
			] )
		);

		$this->assertCount( 4, $result['positions'] );
	}

	public function test_save_accepts_empty_positions(): void {
		$result = VerbHarness::fire(
			new Layouts_CI_Node(),
			'layouts',
			'save',
			'empty ' . (string) \json_encode( [] )
		);

		$this->assertSame( [], $result['positions'] );
	}

	public function test_save_rejects_invalid_name(): void {
		$result = VerbHarness::fire(
			new Layouts_CI_Node(),
			'layouts',
			'save',
			'bad! ' . (string) \json_encode( [] )
		);
		$this->assertIsString( $result );
		$this->assertStringContainsString( 'invalid name', $result );
	}

	public function test_save_rejects_missing_positions(): void {
		$result = VerbHarness::fire(
			new Layouts_CI_Node(),
			'layouts',
			'save',
			'foo'
		);
		$this->assertIsString( $result );
		$this->assertStringContainsString( 'positions', $result );
	}

	public function test_save_rejects_positions_not_array(): void {
		$result = VerbHarness::fire(
			new Layouts_CI_Node(),
			'layouts',
			'save',
			'foo ' . (string) \json_encode( 'oops' )
		);
		$this->assertIsString( $result );
		$this->assertStringContainsString( 'positions', $result );
	}

	public function test_save_rejects_body_too_large(): void {
		// Arguments just over 1 MiB. The size guard measures the whole packed
		// envelope, so a big positions blob trips it before name/JSON parsing.
		$args = 'big ' . (string) \json_encode( [ 'n' => [ 1, 2 ], '_pad' => \str_repeat( 'x', 1048577 ) ] );
		$this->assertGreaterThan( 1048576, \strlen( $args ) );

		$result = VerbHarness::fire( new Layouts_CI_Node(), 'layouts', 'save', $args );
		$this->assertIsString( $result );
		$this->assertStringContainsString( 'too large', $result );
	}

	public function test_save_accepts_large_positions_under_one_mib(): void {
		// A captured graph's layout (thousands of node positions) exceeds the
		// old 64 KiB guard but stays under the 1 MiB cap — it must save.
		$positions = [];
		for ( $i = 0; $i < 6000; $i++ ) {
			$positions[ "node_$i" ] = [ $i * 1.5, $i * 2.0 ];
		}
		$args = 'big ' . (string) \json_encode( $positions );
		$this->assertGreaterThan( 65536, \strlen( $args ) );
		$this->assertLessThan( 1048576, \strlen( $args ) );

		$result = VerbHarness::fire( new Layouts_CI_Node(), 'layouts', 'save', $args );

		$this->assertIsArray( $result );
		$this->assertSame( 'big', $result['name'] );
		$this->assertCount( 6000, $result['positions'] );
	}

	public function test_save_rejects_without_manage_options(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$result = VerbHarness::fire(
			new Layouts_CI_Node(),
			'layouts',
			'save',
			'nope ' . (string) \json_encode( [] )
		);
		$this->assertIsString( $result );
		$this->assertStringContainsString( 'permission denied', $result );
	}
}
