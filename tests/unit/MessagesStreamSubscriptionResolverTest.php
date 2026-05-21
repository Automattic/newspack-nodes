<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Consumer;
use Newspack_Nodes\Rest\Messages_Stream_Controller;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Unit tests for the M5-cutover SSE controller's subscription resolver.
 *
 * Locks the contract for `open_subscription` (one Consumer per log
 * partition; exactly one Consumer per IPC reader; throw on anything
 * that doesn't match either shape) and the trivial CSV parsing of
 * `parse_subscriptions`. The route registration is just enough to
 * surface signature regressions — the drain-loop body itself lands in
 * Task 18.
 */
#[CoversClass( Messages_Stream_Controller::class )]
class MessagesStreamSubscriptionResolverTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir( 'messages-stream-resolver-' );
	}

	protected function tearDown(): void {
		// Reset the static seam so a test that reassigns it can't leak into
		// later tests (today no other test touches it, but Task 18 will add
		// more tests against this controller).
		Messages_Stream_Controller::$attach_to_worker = null;
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_log_partition_subscription_returns_one_consumer_per_partition(): void {
		// The Partition constructor doesn't require the partition_dir to
		// pre-exist (get_segments tolerates a missing dir); creating the
		// base log dir is enough to mirror the production layout
		// `{base}/logs/{name}.log/p{N}/`.
		\mkdir( "{$this->tmp}/logs/firehose.log", 0755, true );
		$ctrl = new Messages_Stream_Controller();
		$ctrl->set_base_dir( $this->tmp );
		$ctrl->set_num_partitions( 3 );

		$consumers = $ctrl->open_subscription( 'firehose', null );

		$this->assertCount( 3, $consumers );
		$this->assertContainsOnlyInstancesOf( Consumer::class, $consumers );
	}

	public function test_log_subscription_stamps_partition_into_from(): void {
		// Dashboards subscribing to a multi-partition log need to know which
		// partition each line came from (rawlogs UI shows P0/P1/P2 alongside
		// each row). The resolver overrides Consumer's FROM stamp with the
		// subscription-scoped `{sub}.p{N}` shape so the JS side can parse it
		// without a separate sidecar field. Without this, every partition's
		// stream emits FROM=`firehose` and the dashboard loses the per-row
		// partition column.
		\mkdir( "{$this->tmp}/logs/firehose.log", 0755, true );
		$ctrl = new Messages_Stream_Controller();
		$ctrl->set_base_dir( $this->tmp );
		$ctrl->set_num_partitions( 3 );

		$consumers = $ctrl->open_subscription( 'firehose', null );

		$ref    = new \ReflectionProperty( Consumer::class, 'stamp_override' );
		$stamps = [];
		foreach ( $consumers as $c ) {
			$stamps[] = $ref->getValue( $c );
		}
		\sort( $stamps );
		$this->assertSame( [ 'firehose.p0', 'firehose.p1', 'firehose.p2' ], $stamps );
	}

	public function test_ipc_reader_subscription_returns_one_consumer(): void {
		// IPC pattern `{type}.p{N}` resolves through `Cli::attach_to_worker`,
		// which requires a worker lock dir to exist (typo guard).
		\mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		\mkdir( "{$this->tmp}/ipc/firehose-workers.p0/output", 0755, true );

		$ctrl = new Messages_Stream_Controller();
		$ctrl->set_base_dir( $this->tmp );

		$consumers = $ctrl->open_subscription( 'firehose-workers.p0', null );

		$this->assertCount( 1, $consumers );
		$this->assertContainsOnlyInstancesOf( Consumer::class, $consumers );
	}

	public function test_ipc_subscription_uses_attach_to_worker_seam_when_set(): void {
		// Mutation guard for the seam branch in `open_subscription`. The
		// existing IPC test goes through the real `Cli::attach_to_worker`,
		// so the `self::$attach_to_worker ?? ...` closure-property branch is
		// dead to coverage. Set the seam to a recording closure and verify
		// it gets invoked with the right args.
		$recorded = [];
		Messages_Stream_Controller::$attach_to_worker = static function ( string $reader_id, string $base_dir ) use ( &$recorded ): array {
			$recorded[] = [
				'reader_id' => $reader_id,
				'base_dir'  => $base_dir,
			];
			return [
				'input'     => "{$base_dir}/ipc/{$reader_id}/input",
				'output'    => "{$base_dir}/ipc/{$reader_id}/output",
				'type'      => 'firehose-workers',
				'partition' => 0,
			];
		};

		\mkdir( "{$this->tmp}/ipc/firehose-workers.p0/output", 0755, true );

		$ctrl = new Messages_Stream_Controller();
		$ctrl->set_base_dir( $this->tmp );
		$consumers = $ctrl->open_subscription( 'firehose-workers.p0', null );

		$this->assertCount( 1, $consumers );
		$this->assertContainsOnlyInstancesOf( Consumer::class, $consumers );
		$this->assertCount( 1, $recorded );
		$this->assertSame( 'firehose-workers.p0', $recorded[0]['reader_id'] );
		$this->assertSame( $this->tmp, $recorded[0]['base_dir'] );
	}

	public function test_ipc_subscription_falls_back_to_log_partition_when_no_worker(): void {
		// Aggregator hub path: RemoteSource subscribes as `firehose.p0` to
		// tail the spoke's firehose.log partition 0. There's NO worker
		// named `firehose.p0` on the spoke (workers live at e.g.
		// `firehose-workers-and-jobs.p0`), so the IPC-attach throws.
		// Resolver must catch and fall through to log-name + partition.
		\mkdir( "{$this->tmp}/logs/firehose.log/p0", 0755, true );

		$ctrl = new Messages_Stream_Controller();
		$ctrl->set_base_dir( $this->tmp );

		$consumers = $ctrl->open_subscription( 'firehose.p0', null );

		$this->assertCount( 1, $consumers );
		$this->assertContainsOnlyInstancesOf( Consumer::class, $consumers );
	}

	public function test_invalid_subscription_throws(): void {
		$ctrl = new Messages_Stream_Controller();
		$ctrl->set_base_dir( $this->tmp );

		$this->expectException( \InvalidArgumentException::class );
		$ctrl->open_subscription( '../etc/passwd', null );
	}

	public function test_parse_subscriptions_splits_csv_and_trims(): void {
		$ctrl = new Messages_Stream_Controller();
		$this->assertSame(
			[ 'firehose', 'errors', 'completed' ],
			$ctrl->parse_subscriptions( ' firehose, errors , completed' )
		);
	}

	public function test_parse_subscriptions_empty_returns_empty(): void {
		$ctrl = new Messages_Stream_Controller();
		$this->assertSame( [], $ctrl->parse_subscriptions( '' ) );
	}

	// ── register_routes ─────────────────────────────────────────────────────

	public function test_register_routes_registers_stream_get_route(): void {
		$GLOBALS['_wp_test_registered_routes'] = [];

		( new Messages_Stream_Controller() )->register_routes();

		$this->assertCount( 1, $GLOBALS['_wp_test_registered_routes'] );
		$route = $GLOBALS['_wp_test_registered_routes'][0];
		$this->assertSame( 'newspack-nodes/v1', $route['namespace'] );
		$this->assertSame( '/messages/stream', $route['route'] );
		$this->assertSame( 'GET', $route['args']['methods'] );
		// `subscribe` is required so an EventSource missing it gets a 400 from
		// WP's own arg validator instead of hitting our handler with a blank.
		$this->assertTrue( $route['args']['args']['subscribe']['required'] );
		$this->assertFalse( $route['args']['args']['interval']['required'] );
		$this->assertSame( 2000, $route['args']['args']['interval']['default'] );
		$this->assertFalse( $route['args']['args']['positions']['required'] );
		$this->assertIsCallable( $route['args']['callback'] );
		$this->assertIsCallable( $route['args']['permission_callback'] );
	}

	// ── parse_positions ─────────────────────────────────────────────────────

	public function test_parse_positions_returns_null_on_empty_string(): void {
		$ctrl = new Messages_Stream_Controller();
		$this->assertNull( $ctrl->parse_positions( '' ) );
	}

	public function test_parse_positions_decodes_valid_json_object(): void {
		$ctrl = new Messages_Stream_Controller();
		// Browser sends `{"0":"3:1024","1":"7:0"}` — partition→position map.
		// Returned as an associative array; the consumer-walker uses the
		// partition index as key.
		$decoded = $ctrl->parse_positions( '{"0":"3:1024","1":"7:0"}' );
		$this->assertIsArray( $decoded );
		$this->assertSame( '3:1024', $decoded[0] );
		$this->assertSame( '7:0',    $decoded[1] );
	}

	public function test_parse_positions_returns_null_when_json_is_not_an_array(): void {
		$ctrl = new Messages_Stream_Controller();
		// A bare JSON string / int / bool decodes successfully but isn't an
		// array. Resolver must reject so a poisoned `positions` param doesn't
		// later break Consumer::next_offset's positions[$partition] lookup.
		$this->assertNull( $ctrl->parse_positions( '"not an array"' ) );
		$this->assertNull( $ctrl->parse_positions( '123' ) );
		$this->assertNull( $ctrl->parse_positions( 'completely invalid json' ) );
	}

	// ── open_subscription: positions reach Consumer::next_offset ────────────

	public function test_log_subscription_seeks_to_supplied_position(): void {
		// `{type}.p{N}` aggregator-hub fallback path with positions supplied.
		// The IPC attach fails (no worker), so the resolver falls through to
		// the log-file consumer; with a positions map it must call
		// next_offset($positions[$partition]) instead of 'end'.
		//
		// Browser shape: `{ "0": { seg: 5, off: 1024 }, ... }`. PHP receives
		// the JSON-decoded version, which matches Consumer::next_offset's
		// is_array($position) branch (cursor_seg/cursor_off direct seed).
		\mkdir( "{$this->tmp}/logs/firehose.log/p0", 0755, true );

		$ctrl = new Messages_Stream_Controller();
		$ctrl->set_base_dir( $this->tmp );

		$consumers = $ctrl->open_subscription(
			'firehose.p0',
			[ 0 => [ 'seg' => 5, 'off' => 1024 ] ]
		);

		$this->assertCount( 1, $consumers );
		$consumer = $consumers[0];
		// next_offset's array branch seeds cursor_seg / cursor_off directly.
		// Reflect on the protected fields to confirm the resolver routed
		// the supplied position through (instead of silently falling
		// through to the 'end' default which would skip historical events).
		$seg = new \ReflectionProperty( $consumer, 'cursor_seg' );
		$seg->setAccessible( true );
		$off = new \ReflectionProperty( $consumer, 'cursor_off' );
		$off->setAccessible( true );
		$this->assertSame( 5, $seg->getValue( $consumer ) );
		$this->assertSame( 1024, $off->getValue( $consumer ) );
	}
}
