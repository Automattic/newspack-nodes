<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Node;
use Newspack_Nodes\Rest\SSE_Out_Node;
use Newspack_Nodes\Tests\TestCase;

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
#[CoversClass( SSE_Out_Node::class )]
class MessagesStreamSubscriptionResolverTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir( 'messages-stream-resolver-' );
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_group_prefixed_subscription_opens_the_offsets_dir(): void {
		\mkdir( "{$this->tmp}/offsets/combined.firehose.p0", 0755, true );
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->tmp );

		$consumers = $ctrl->open_subscription( 'offsets/combined.firehose.p0', null );

		$this->assertCount( 1, $consumers );
		$this->assertSame( 'offsets/combined.firehose.p0', $consumers[0]->stamped_as() );
	}

	public function test_group_prefixed_glob_fans_out_within_the_group(): void {
		\mkdir( "{$this->tmp}/deadletter/combined.firehose.p0", 0755, true );
		\mkdir( "{$this->tmp}/deadletter/combined.firehose.p1", 0755, true );
		// A same-named LOGS dir must not leak into the deadletter glob.
		\mkdir( "{$this->tmp}/logs/combined.firehose.p0", 0755, true );
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->tmp );

		$consumers = $ctrl->open_subscription( 'deadletter/combined.firehose.*', null );

		$this->assertSame(
			[ 'deadletter/combined.firehose.p0', 'deadletter/combined.firehose.p1' ],
			\array_map( static fn ( $c ) => $c->stamped_as(), $consumers )
		);
	}

	public function test_explicit_logs_prefix_is_rejected_not_aliased(): void {
		// `logs/x` would stamp identically to bare `x` yet skip the IPC-tail
		// preference — two spellings, different sources. One spelling only.
		\mkdir( "{$this->tmp}/logs/firehose.p0", 0755, true );
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->tmp );

		$this->expectException( \InvalidArgumentException::class );
		$ctrl->open_subscription( 'logs/firehose.p0', null );
	}

	public function test_unknown_group_prefix_is_rejected(): void {
		\mkdir( "{$this->tmp}/secrets/x.p0", 0755, true );
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->tmp );

		$this->expectException( \InvalidArgumentException::class );
		$ctrl->open_subscription( 'secrets/x.p0', null );
	}

	public function test_group_prefix_traversal_is_rejected(): void {
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->tmp );

		$this->expectException( \InvalidArgumentException::class );
		$ctrl->open_subscription( 'offsets/../logs/firehose.p0', null );
	}

	public function test_glob_subscription_returns_one_consumer_per_matched_dir(): void {
		// A `{feed}.*` glob fans out to one Consumer per matching concrete log dir
		// — the filesystem is the source of truth, not a hardcoded `.p{N}` count.
		\mkdir( "{$this->tmp}/logs/firehose.p0", 0755, true );
		\mkdir( "{$this->tmp}/logs/firehose.p1", 0755, true );
		\mkdir( "{$this->tmp}/logs/firehose.p2", 0755, true );
		// A same-prefix-but-different-feed dir must NOT match `firehose.*`.
		\mkdir( "{$this->tmp}/logs/firehose-workers.p0", 0755, true );
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->tmp );

		$consumers = $ctrl->open_subscription( 'firehose.*', null );

		$this->assertCount( 3, $consumers );
		$this->assertContainsOnlyInstancesOf( Consumer_Node::class, $consumers );
	}

	public function test_glob_subscription_stamps_concrete_dir_into_from(): void {
		// Dashboards subscribing to a multi-partition log need to know which
		// partition each line came from (rawlogs UI shows P0/P1/P2 per row). The
		// resolver stamps each Consumer with its concrete dir basename so the JS
		// side parses it without a sidecar field.
		\mkdir( "{$this->tmp}/logs/firehose.p0", 0755, true );
		\mkdir( "{$this->tmp}/logs/firehose.p1", 0755, true );
		\mkdir( "{$this->tmp}/logs/firehose.p2", 0755, true );
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->tmp );

		$consumers = $ctrl->open_subscription( 'firehose.*', null );

		$ref    = new \ReflectionProperty( Consumer_Node::class, 'stamp_override' );
		$stamps = [];
		foreach ( $consumers as $c ) {
			$stamps[] = $ref->getValue( $c );
		}
		\sort( $stamps );
		$this->assertSame( [ 'firehose.p0', 'firehose.p1', 'firehose.p2' ], $stamps );
	}

	public function test_empty_glob_returns_no_consumers(): void {
		// A valid pattern that matches nothing (feed not created yet) is not an
		// error — the stream simply has nothing to tail until a dir appears.
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->tmp );

		$this->assertSame( [], $ctrl->open_subscription( 'firehose.*', null ) );
	}

	public function test_glob_subscription_seeds_position_by_concrete_dir_name(): void {
		// Positions are keyed by the OPAQUE concrete dir name (matching the FROM
		// stamp), so each matched dir resumes independently of any `.p{N}` layout.
		\mkdir( "{$this->tmp}/logs/firehose.p1", 0755, true );
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->tmp );

		$consumers = $ctrl->open_subscription(
			'firehose.*',
			[ 'firehose.p1' => [ 'segment' => 2, 'offset' => 5 ] ]
		);

		$stamp = new \ReflectionProperty( Consumer_Node::class, 'stamp_override' );
		$segment   = new \ReflectionProperty( Consumer_Node::class, 'cursor_segment' );
		$offset   = new \ReflectionProperty( Consumer_Node::class, 'cursor_offset' );
		$seeded = null;
		foreach ( $consumers as $c ) {
			if ( 'firehose.p1' === $stamp->getValue( $c ) ) {
				$seeded = $c;
			}
		}
		$this->assertNotNull( $seeded, 'a consumer is stamped with the concrete dir name' );
		$this->assertSame( 2, $segment->getValue( $seeded ) );
		$this->assertSame( 5, $offset->getValue( $seeded ) );
	}

	public function test_reconcile_adds_new_and_removes_vanished_glob_dirs(): void {
		// Self-heal: a live glob stream picks up a partition dir that appears and
		// drops one that vanishes (partitions increasing AND decreasing).
		\mkdir( "{$this->tmp}/logs/firehose.p0", 0755, true );
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->tmp );
		$route = new Node();
		$route->name( '_reconcile_route_' . \getmypid() );

		$consumers  = [];
		$glob_owned = [];
		foreach ( $ctrl->open_subscription( 'firehose.*', null ) as $c ) {
			$c->name( $c->stamped_as() );
			$c->sink( $route );
			$consumers[ $c->stamped_as() ]  = $c;
			$glob_owned[ $c->stamped_as() ] = true;
		}
		$this->assertSame( [ 'firehose.p0' ], \array_keys( $consumers ) );

		\mkdir( "{$this->tmp}/logs/firehose.p1", 0755, true );
		$ctrl->reconcile_glob_consumers( [ 'firehose.*' ], $consumers, $glob_owned, $route );
		$this->assertArrayHasKey( 'firehose.p1', $consumers, 'a new partition dir self-heals in' );
		$this->assertCount( 2, $consumers );

		$this->rmdir_recursive( "{$this->tmp}/logs/firehose.p0" );
		$ctrl->reconcile_glob_consumers( [ 'firehose.*' ], $consumers, $glob_owned, $route );
		$this->assertSame( [ 'firehose.p1' ], \array_keys( $consumers ), 'a vanished partition dir self-heals out' );
	}

	public function test_reconcile_leaves_a_non_glob_consumer_alone(): void {
		// An exact IPC/log consumer coexisting with a glob must survive a reconcile
		// even though it's not in the glob's matched set (not glob-owned).
		\mkdir( "{$this->tmp}/logs/firehose.p0", 0755, true );
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->tmp );
		$route = new Node();
		$route->name( '_reconcile_route2_' . \getmypid() );

		$consumers  = [];
		$glob_owned = [];
		foreach ( $ctrl->open_subscription( 'firehose.*', null ) as $c ) {
			$c->name( $c->stamped_as() );
			$c->sink( $route );
			$consumers[ $c->stamped_as() ]  = $c;
			$glob_owned[ $c->stamped_as() ] = true;
		}
		// An exact IPC consumer whose name MATCHES `firehose.*` (fnmatch true) but
		// is NOT glob-owned, and has no logs/ dir. Pattern-match removal would drop
		// it; ownership-based removal must keep it.
		$exact = new Consumer_Node();
		$exact->arguments( [ "{$this->tmp}/ipc/firehose.p9/output" ] );
		$exact->set_stamp_as( 'firehose.p9' );
		$exact->name( 'firehose.p9' );
		$exact->sink( $route );
		$consumers['firehose.p9'] = $exact;

		$ctrl->reconcile_glob_consumers( [ 'firehose.*' ], $consumers, $glob_owned, $route );

		$this->assertArrayHasKey( 'firehose.p9', $consumers, 'an exact consumer matching the glob but not glob-owned survives' );
		$this->assertArrayHasKey( 'firehose.p0', $consumers );
	}

	public function test_ipc_reader_subscription_returns_one_consumer(): void {
		\mkdir( "{$this->tmp}/ipc/firehose-workers.p0/output", 0755, true );

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->tmp );

		$consumers = $ctrl->open_subscription( 'firehose-workers.p0', null );

		$this->assertCount( 1, $consumers );
		$this->assertContainsOnlyInstancesOf( Consumer_Node::class, $consumers );
	}

	public function test_ipc_subscription_falls_back_to_log_partition_when_no_worker(): void {
		// Aggregator hub path: RemoteSource subscribes as `firehose.p0` to
		// tail the spoke's firehose.log partition 0. There's NO worker
		// named `firehose.p0` on the spoke (workers live at e.g.
		// `demo-workers.p0`), so the IPC-attach throws.
		// Resolver must catch and fall through to the flat concrete partition dir.
		\mkdir( "{$this->tmp}/logs/firehose.p0", 0755, true );

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->tmp );

		$consumers = $ctrl->open_subscription( 'firehose.p0', null );

		$this->assertCount( 1, $consumers );
		$this->assertContainsOnlyInstancesOf( Consumer_Node::class, $consumers );
		$this->assertStringStartsWith(
			"{$this->tmp}/logs/firehose.p0",
			$consumers[0]->arguments()[0],
			'log fallback must tail the flat concrete partition dir, not the nested {name}.log/p{N}'
		);
	}

	public function test_ipc_subscription_tails_output_dir_when_worker_offline_but_ipc_exists(): void {
		\mkdir( "{$this->tmp}/ipc/demo-workers.p0/output", 0755, true );
		// A same-named log dir exists too — IPC output must win over the log fallback.
		\mkdir( "{$this->tmp}/logs/demo-workers.p0", 0755, true );

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->tmp );

		$consumers = $ctrl->open_subscription( 'demo-workers.p0', null );

		$this->assertCount( 1, $consumers );
		$this->assertStringStartsWith(
			"{$this->tmp}/ipc/demo-workers.p0/output",
			$consumers[0]->arguments()[0],
			'must tail the persisting IPC output dir, not fall back to the log feed'
		);
	}

	public function test_invalid_subscription_throws(): void {
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->tmp );

		$this->expectException( \InvalidArgumentException::class );
		$ctrl->open_subscription( '../etc/passwd', null );
	}

	public function test_leading_dot_subscription_throws(): void {
		// A leading `.` (e.g. `.*`) would let glob(logs/.*) match `.`/`..` and
		// escape logs/. A subscription must start with a real feed-name char.
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->tmp );

		$this->expectException( \InvalidArgumentException::class );
		$ctrl->open_subscription( '.*', null );
	}

	public function test_parse_subscriptions_splits_csv_and_trims(): void {
		$ctrl = new SSE_Out_Node();
		$this->assertSame(
			[ 'firehose', 'errors', 'completed' ],
			$ctrl->parse_subscriptions( ' firehose, errors , completed' )
		);
	}

	public function test_parse_subscriptions_empty_returns_empty(): void {
		$ctrl = new SSE_Out_Node();
		$this->assertSame( [], $ctrl->parse_subscriptions( '' ) );
	}

	// ── register_routes ─────────────────────────────────────────────────────

	public function test_register_routes_registers_stream_get_route(): void {
		$GLOBALS['_wp_test_registered_routes'] = [];

		( new SSE_Out_Node() )->register_routes();

		$this->assertCount( 1, $GLOBALS['_wp_test_registered_routes'] );
		$route = $GLOBALS['_wp_test_registered_routes'][0];
		$this->assertSame( 'newspack-nodes/v1', $route['namespace'] );
		$this->assertSame( '/messages/stream', $route['route'] );
		$this->assertSame( 'GET', $route['args']['methods'] );
		// `subscribe` is required so an EventSource missing it gets a 400 from
		// WP's own arg validator instead of hitting our handler with a blank.
		$this->assertTrue( $route['args']['args']['subscribe']['required'] );
		$this->assertArrayNotHasKey( 'interval', $route['args']['args'] );
		$this->assertFalse( $route['args']['args']['positions']['required'] );
		$this->assertIsCallable( $route['args']['callback'] );
		$this->assertIsCallable( $route['args']['permission_callback'] );
	}

	// ── parse_positions ─────────────────────────────────────────────────────

	public function test_parse_positions_returns_null_on_empty_string(): void {
		$ctrl = new SSE_Out_Node();
		$this->assertNull( $ctrl->parse_positions( '' ) );
	}

	public function test_parse_positions_decodes_valid_json_object(): void {
		$ctrl = new SSE_Out_Node();
		// Browser sends `{"0":"3:1024","1":"7:0"}` — partition→position map.
		// Returned as an associative array; the consumer-walker uses the
		// partition index as key.
		$decoded = $ctrl->parse_positions( '{"0":"3:1024","1":"7:0"}' );
		$this->assertIsArray( $decoded );
		$this->assertSame( '3:1024', $decoded[0] );
		$this->assertSame( '7:0',    $decoded[1] );
	}

	public function test_parse_positions_returns_null_when_json_is_not_an_array(): void {
		$ctrl = new SSE_Out_Node();
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
		// is_array($position) branch (cursor_segment/cursor_offset direct seed).
		\mkdir( "{$this->tmp}/logs/firehose.p0", 0755, true );

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->tmp );

		$consumers = $ctrl->open_subscription(
			'firehose.p0',
			[ 'firehose.p0' => [ 'segment' => 5, 'offset' => 1024 ] ]
		);

		$this->assertCount( 1, $consumers );
		$consumer = $consumers[0];
		// next_offset's array branch seeds cursor_segment / cursor_offset directly.
		// Reflect on the protected fields to confirm the resolver routed
		// the supplied position through (instead of silently falling
		// through to the 'end' default which would skip historical events).
		$segment = new \ReflectionProperty( $consumer, 'cursor_segment' );
		$offset = new \ReflectionProperty( $consumer, 'cursor_offset' );
		$this->assertSame( 5, $segment->getValue( $consumer ) );
		$this->assertSame( 1024, $offset->getValue( $consumer ) );
	}
}
