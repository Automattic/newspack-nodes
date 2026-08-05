<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Log_Sources;
use Newspack_Nodes\Rest\Log_Stream_Out_Node;
use Newspack_Nodes\Tail_Node;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;

/**
 * The `/log/stream` SSE controller: mirrors `/messages/stream` exactly on the
 * wire, but resolves subscriptions against the fixed `Log_Sources` registry
 * and opens `Tail` readers instead of Consumers. The subscribe param carries
 * registry NAMES only — a caller can never supply a path.
 */
#[CoversClass( Log_Stream_Out_Node::class )]
class LogStreamOutNodeTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->make_temp_dir( 'log-stream-' );
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		parent::tearDown();
	}

	// ── open_subscription: file-mode sources ───────────────────────────────

	public function test_known_name_opens_one_file_mode_tail_stamped_by_registry_name(): void {
		$path = "{$this->tmp}/gyro-live.log";
		\file_put_contents( $path, "abcdefgh\n" );
		Log_Sources::$builtin_sources = static fn (): array => [ 'gyro' => $path ];

		$tails = ( new Log_Stream_Out_Node() )->open_subscription( 'gyro', null );

		$this->assertCount( 1, $tails );
		$tail = $tails[0];
		$this->assertInstanceOf( Tail_Node::class, $tail );
		$this->assertSame( 'gyro', $tail->stamped_as() );
		$this->assertSame( Tail_Node::MODE_FILE, $this->read_private( $tail, 'source_mode' ) );
		$this->assertSame( $path, $this->read_private( $tail, 'source_file' ) );
		// Ephemeral SSE reader: the browser holds the cursor, no durable state.
		$this->assertSame( '', $this->read_private( $tail, 'offsetlog_dir' ) );
		$this->assertSame( '', $this->read_private( $tail, 'deadletter_dir' ) );
		// No position → live tail from END (9 bytes, distinct from offset 0).
		$this->assertSame( 9, $this->read_private( $tail, 'cursor_offset' ) );
	}

	public function test_position_keyed_by_name_seeds_the_file_mode_resume_candidate(): void {
		$path = "{$this->tmp}/gyro-live.log";
		\file_put_contents( $path, "abcdefgh\n" );
		Log_Sources::$builtin_sources = static fn (): array => [ 'gyro' => $path ];

		$tails = ( new Log_Stream_Out_Node() )->open_subscription(
			'gyro',
			[ 'gyro' => [ 'segment' => 4242, 'offset' => 77 ] ]
		);

		// File mode defers an array seek until the handle opens on first poll.
		$this->assertSame(
			[
				'inode'  => 4242,
				'offset' => 77,
			],
			$this->read_private( $tails[0], 'file_seek_candidate' )
		);
	}

	// ── open_subscription: topology-inferred segmented sources ─────────────

	public function test_topology_source_opens_a_segmented_tail_with_the_resolved_path(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		$dir = "{$this->tmp}/topologies";
		\mkdir( $dir, 0755, true );
		\file_put_contents(
			"{$dir}/lstream.tsl",
			"var num_partitions = 2\n"
			. "make_node Log beacon:log <config:logs_dir>/beacon-7e.p<partition>/beacon-7e 1 2 7\n"
		);
		Topology_Registry::register_stock_dir( $dir );
		$this->use_base_dir( $this->tmp, [ 'topologies' => [ 'lstream' ] ] );

		$tails = ( new Log_Stream_Out_Node() )->open_subscription(
			'beacon-7e.p1',
			[ 'beacon-7e.p1' => [ 'segment' => 3, 'offset' => 9 ] ]
		);

		$this->assertCount( 1, $tails );
		$tail = $tails[0];
		$this->assertSame( Tail_Node::MODE_SEGMENTED, $this->read_private( $tail, 'source_mode' ) );
		$this->assertSame( "{$this->tmp}/logs/beacon-7e.p1/beacon-7e", $this->read_private( $tail, 'source_file' ) );
		$this->assertSame( 'beacon-7e.p1', $tail->stamped_as() );
		// Segmented seek seeds the cursor directly (Consumer's array branch).
		$this->assertSame( 3, $this->read_private( $tail, 'cursor_segment' ) );
		$this->assertSame( 9, $this->read_private( $tail, 'cursor_offset' ) );
	}

	// ── open_subscription: names only, never paths ─────────────────────────

	public function test_unknown_name_throws_a_teaching_error_listing_known_sources(): void {
		$path = "{$this->tmp}/gyro.log";
		Log_Sources::$builtin_sources = static fn (): array => [ 'gyro' => $path ];
		$ctrl = new Log_Stream_Out_Node();

		try {
			$ctrl->open_subscription( 'nope-1189', null );
			$this->fail( 'expected InvalidArgumentException' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertStringContainsString( 'unknown log source', $e->getMessage() );
			$this->assertStringContainsString( 'gyro', $e->getMessage(), 'the error teaches the known names' );
		}
	}

	public function test_a_caller_supplied_path_is_never_a_registry_name(): void {
		$path = "{$this->tmp}/gyro.log";
		Log_Sources::$builtin_sources = static fn (): array => [ 'gyro' => $path ];
		$ctrl = new Log_Stream_Out_Node();

		foreach ( [ '/etc/passwd', '../../etc/passwd', 'gyro/../gyro' ] as $evil ) {
			try {
				$ctrl->open_subscription( $evil, null );
				$this->fail( "expected InvalidArgumentException for {$evil}" );
			} catch ( \InvalidArgumentException $e ) {
				$this->assertStringContainsString( 'unknown log source', $e->getMessage() );
			}
		}
	}

	// ── register_routes ────────────────────────────────────────────────────

	public function test_register_routes_registers_log_stream_get_route(): void {
		$GLOBALS['_wp_test_registered_routes'] = [];

		( new Log_Stream_Out_Node() )->register_routes();

		$this->assertCount( 1, $GLOBALS['_wp_test_registered_routes'] );
		$route = $GLOBALS['_wp_test_registered_routes'][0];
		$this->assertSame( 'newspack-nodes/v1', $route['namespace'] );
		$this->assertSame( '/log/stream', $route['route'] );
		$this->assertSame( 'GET', $route['args']['methods'] );
		$this->assertTrue( $route['args']['args']['subscribe']['required'] );
		$this->assertFalse( $route['args']['args']['positions']['required'] );
		$this->assertIsCallable( $route['args']['callback'] );
		$this->assertIsCallable( $route['args']['permission_callback'] );
	}
}
