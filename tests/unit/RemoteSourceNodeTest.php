<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Probe_Record;
use Newspack_Nodes\Remote_Consumer_Node;
use Newspack_Nodes\Remote_Source_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\SSE_In_Node;
use Newspack_Nodes\Topic_Probe_Node;
use Newspack_Nodes\Vault;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

/**
 * The broker: one SSE connection to a spoke carrying every stream its pairs
 * name, a Remote_Consumer reader per stamp, the shared valve, the heartbeat
 * and the status snapshot. Reader behaviour lives in RemoteConsumerNodeTest.
 */
#[CoversClass( Remote_Source_Node::class )]
class RemoteSourceNodeTest extends TestCase {

	private string $base_dir = '';

	protected function setUp(): void {
		parent::setUp();
		$this->base_dir = $this->make_temp_dir();
		$this->use_base_dir( $this->base_dir );
		Core::$memd             = new InMemoryMemcached();
		Core::$var['partition'] = '0';
		// A live graph always has _router: the readers route through it.
		( new Router_Node() )->name( '_router' );
		// The tick housekeeps once per wall-second; start on a known one.
		Core::$now = 500.0;
	}

	protected function tearDown(): void {
		unset( Core::$var['partition'] );
		Command_Auth::forget_session( 'austin' );
		Core::$memd                = null;
		\Newspack_Nodes\Event_Framework::$curl_dispatch = null;
		// The SSE_In patrons register easy cURL handles on the process-lifetime
		// Event_Framework singleton; reset it so handles don't leak into later suites.
		Event_Framework::reset();
		Vault::get_instance()->reset_cache();
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	protected function seed_vault( string $id, array $entry ): void {
		// A spoke that can be sent to has authed; the heartbeat signs for it.
		Command_Auth::remember_session( $id, \str_repeat( 'b', 32 ), 'spoke-session-key' );
		parent::seed_vault( $id, $entry );
	}

	/** @return list<string> Broker tokens: vault, the two roots, then one pair per argument. */
	private function remote_args( string $name = 'remote-austin', string $vault = 'austin', string ...$pairs ): array {
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		return [ $vault, "{$offsets}/{$name}", "{$base}/deadletter/{$name}", ...( [] === $pairs ? [ 'firehose.p0:downstream' ] : $pairs ) ];
	}

	/** A named broker sinking into _router, its first tick not yet run. */
	private function broker( string $name = 'remote-austin', ?array $args = null ): Remote_Source_Node {
		$node = new Remote_Source_Node();
		$node->name( $name );
		$node->sink( Core::node( '_router' ) );
		$node->arguments( $args ?? $this->remote_args( $name ) );
		return $node;
	}

	/**
	 * Build a named broker over one `firehose.p0:downstream` pair, its first tick
	 * run so the exact pair's reader exists.
	 *
	 * @return array{0:Remote_Source_Node,1:\Newspack_Nodes\Remote_Consumer_Node,2:Capture_Sink_Node}
	 */
	private function make_remote( string $name = 'remote-austin', ?array $args = null ): array {
		$sink = new Capture_Sink_Node();
		$sink->name( 'downstream' );
		$node = $this->broker( $name, $args );
		$node->fire();
		return [ $node, Core::node( "{$name}:firehose.p0" ), $sink ];
	}

	/** A `msg` frame from the default pair's stream, unless the fields name another FROM. */
	private static function stream_frame( array $fields ): string {
		return self::sse_frame( 'msg', $fields + [ Message::FROM => 'firehose.p0' ] );
	}

	/** `msg_frame()`, stamped with the default pair's stream. */
	private static function stream_msg( string $id, string $key, mixed $value ): string {
		return self::stream_frame( [ Message::TYPE => Message::TM_STRUCT, Message::ID => $id, Message::KEY => $key, Message::VALUE => $value ] );
	}

	/**
	 * The broker's readers, read off its sibling map and keyed by stamp.
	 *
	 * @return array<string,Remote_Consumer_Node>
	 */
	private function readers( Remote_Source_Node $node ): array {
		$readers = [];
		foreach ( ( new \ReflectionMethod( $node, 'siblings' ) )->invoke( $node ) as $sibling ) {
			if ( $sibling instanceof Remote_Consumer_Node ) {
				$readers[ $sibling->stamp() ] = $sibling;
			}
		}
		return $readers;
	}

	/** The status snapshot the broker publishes under its own key. */
	private function status_of( Remote_Source_Node $node ): mixed {
		return Core::$memd->get( Remote_Source_Node::status_key_for( $node->name(), Core::int( $this->read_private( $node, 'bound_partition' ) ) ) );
	}

	// ---------------------------------------------------------------------
	// The tick, the transports and the arguments.
	// ---------------------------------------------------------------------

	public function test_the_tick_housekeeps_once_per_wall_second(): void {
		$node = new class() extends Remote_Source_Node {
			public int $housekeeping_runs = 0;
			protected function publish_status(): void {
				++$this->housekeeping_runs;
			}
			protected function should_connect(): bool {
				return true;
			}
		};
		$node->name( 'src-a' );
		$ref = new \ReflectionProperty( \Newspack_Nodes\Remote_Link_Node::class, 'sse_in' );
		$ref->setValue( $node, new \Newspack_Nodes\SSE_In_Node() );

		Core::$now = 2000.0;
		$node->fire();
		$node->fire();
		$node->fire();
		$this->assertSame( 1, $node->housekeeping_runs, 'housekeeping latched to the wall-second' );
	}

	/**
	 * The two transports are owned siblings, so a rename carries them. Left
	 * inline, `{old}:sse-in` and `{old}:http-out` stay registered under a
	 * spelling nothing resolves while `{new}:sse-in` resolves to null.
	 */
	public function test_renaming_a_connected_source_moves_its_transports(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );
		$sse  = Core::node( 'remote-austin:sse-in' );
		$http = Core::node( 'remote-austin:http-out' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		$this->assertInstanceOf( HTTP_Out_Node::class, $http );

		$node->name( 'remote-galveston' );

		$this->assertSame( $sse, Core::node( 'remote-galveston:sse-in' ) );
		$this->assertSame( $http, Core::node( 'remote-galveston:http-out' ) );
		$this->assertNull( Core::node( 'remote-austin:sse-in' ) );
		$this->assertNull( Core::node( 'remote-austin:http-out' ) );
		// target is a stored STRING; the moved Null needs re-addressing.
		$this->assertSame( 'remote-galveston:null', $http->target() );
	}

	/**
	 * A refused transport name must leave every slot empty, or `ensure_patrons()`
	 * hands back an unnamed SSE_In on every later tick — one reading the spoke
	 * while the registry, `ls` and `command_node` all see nothing.
	 */
	public function test_a_refused_transport_name_caches_no_patron(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example' ] );
		$squatter = new Capture_Sink_Node();
		$squatter->name( 'remote-austin:http-out' );
		$node = $this->broker( 'remote-austin' );

		$e = $this->caught(
			fn () => $node->fire(),
			'expected the squatted http-out slot to be refused'
		);
		$this->assertStringContainsString( 'remote-austin:http-out already registered', $e->getMessage() );

		$this->assertNull( $this->read_private( $node, 'sse_in' ) );
	}

	public function test_arguments_parses_positional_tokens(): void {
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		$node    = $this->broker( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'firehose.p0:downstream', 'sources/php:php-errors:partition' ) );

		$this->assertSame( 'austin', $this->read_private( $node, 'vault_id' ) );
		$this->assertSame( "{$offsets}/remote-austin", $this->read_private( $node, 'offsetlog_root' ) );
		$this->assertSame( "{$base}/deadletter/remote-austin", $this->read_private( $node, 'deadletter_root' ) );
		$this->assertSame(
			[ [ 'source' => 'firehose.p0', 'target' => 'downstream' ], [ 'source' => 'sources/php', 'target' => 'php-errors:partition' ] ],
			$this->read_private( $node, 'pairs' ),
			'a pair splits on its first colon, so a target may carry one'
		);
	}

	public function test_arguments_arms_recurring_timer(): void {
		$node = $this->broker();
		$this->assertGreaterThan( 0, $node->interval_ms );
		$this->assertFalse( $node->oneshot );
	}

	public function test_a_pair_without_a_target_is_refused(): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( "a pair is <source>:<target>, got 'firehose.p0'" );
		$this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'firehose.p0' ) );
	}

	/** @return array<string,array{string}> Label => a pair whose source no spoke can stream. */
	public static function unsubscribable_pairs(): array {
		return [
			'an upper-case partition'        => [ 'Firehose.p0:audit-17' ],
			'a parent dir'                   => [ '../x:y' ],
			'three segments'                 => [ 'sources/php/x:audit-17' ],
			'a glob opening the name'        => [ '*:catchall-81' ],
			'a grouped glob opening the name' => [ 'offsets/*:audit-26' ],
			'a glob over the source registry' => [ 'sources/ph*:audit-26' ],
			'a space'                        => [ 'fire hose.p0:audit-17' ],
			'an explicit logs prefix'        => [ 'logs/x:y' ],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider( 'unsubscribable_pairs' )]
	public function test_a_pair_no_spoke_can_stream_is_refused_at_arguments( string $pair ): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( "names a source no spoke can stream: '{$pair}'" );
		$this->broker( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'firehose.p0:downstream', $pair ) );
	}

	public function test_a_glob_and_a_registry_source_pass(): void {
		$node = $this->broker( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'kea-*:herd-52', 'sources/php:php-errors', 'offsets/kea-*:audit-26' ) );

		$this->assertSame( [ 'kea-*', 'sources/php', 'offsets/kea-*' ], \array_column( $this->read_private( $node, 'pairs' ), 'source' ) );
	}

	public function test_a_broker_naming_no_pair_is_refused(): void {
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'name at least one <source>:<target> pair' );
		$this->broker( 'remote-austin', [ 'austin', "{$offsets}/remote-austin", "{$offsets}/dead" ] );
	}

	public function test_pairs_of_skips_a_malformed_token(): void {
		$this->assertSame(
			[ [ 'source' => 'errors.*', 'target' => 'audit-77' ] ],
			Remote_Source_Node::pairs_of( [ 'firehose.p0', ':orphan', 'errors.*:audit-77', 'sources/php:' ] )
		);
	}

	public function test_split_pair_splits_at_the_first_colon_outside_angle_brackets(): void {
		$this->assertSame(
			[ 'source' => '<zeta:lane>.p{partition}', 'target' => 'lane-sink-3' ],
			Remote_Source_Node::split_pair( '<zeta:lane>.p{partition}:lane-sink-3' )
		);
		$this->assertSame(
			[ 'source' => 'sources/php', 'target' => 'php-errors:partition' ],
			Remote_Source_Node::split_pair( 'sources/php:php-errors:partition' )
		);
		$this->assertSame( [ 'source' => '<zeta:lane>', 'target' => '' ], Remote_Source_Node::split_pair( '<zeta:lane>' ) );
	}

	public function test_split_pair_counts_bracket_depth_and_leaves_an_unclosed_one_whole(): void {
		$this->assertSame(
			[ 'source' => '<<yak:b>:c>.p{partition}', 'target' => 'sink-4' ],
			Remote_Source_Node::split_pair( '<<yak:b>:c>.p{partition}:sink-4' )
		);
		$this->assertSame(
			[ 'source' => '<yak:x:sink-4', 'target' => '' ],
			Remote_Source_Node::split_pair( '<yak:x:sink-4' )
		);
		$this->assertSame(
			[ 'source' => 'a>b', 'target' => 'sink-4' ],
			Remote_Source_Node::split_pair( 'a>b:sink-4' ),
			'a stray close never takes the depth below zero'
		);
	}

	public function test_a_pair_with_an_unclosed_bracket_is_refused(): void {
		$this->expectException( \InvalidArgumentException::class );
		Remote_Source_Node::parse_pair( '<yak:x:sink-4' );
	}

	/** Nothing reads a broker's target, so a connect onto one is refused rather than stored. */
	public function test_a_connect_onto_a_broker_is_refused(): void {
		[ $node, $child ] = $this->make_remote();
		$ci               = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$ci->sink( Core::node( '_router' ) );

		try {
			$ci->dispatch( 'connect_node', [ 'remote-austin', 'tapir-sink-8' ] );
			$this->fail( 'a broker has no target to connect' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'remote-austin takes no target: Remote_Source declares has_target false', $e->getMessage() );
		}
		$this->assertSame( '', $node->target() );
		$this->assertSame( 'downstream', $child->target(), 'each reader keeps its pair target' );
		$this->assertFalse( Core::class_fans_out( Remote_Source_Node::class ), 'a broker is no fan-out' );
		$this->assertFalse( Remote_Source_Node::node_schema()['has_target'] );
	}

	/** Each pair's target is a destination the broker writes through a reader, so the canvas draws it. */
	public function test_the_canvas_draws_one_edge_per_pair(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$ci->sink( Core::node( '_router' ) );
		$this->broker( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'firehose.p0:okapi-sink-9', 'sources/php:php-errors:partition', 'errors.*:okapi-sink-9' ) );

		$meta = $ci->dispatch( 'dump_metadata', [ 'remote-austin' ] );

		$this->assertSame( [ 'okapi-sink-9', 'php-errors:partition' ], $meta['remote-austin']['targets'] );
		$this->assertSame( '', $meta['remote-austin']['target'] );
	}

	public function test_dump_config_roundtrips_the_broker_and_its_pairs(): void {
		$tokens = $this->remote_args( 'remote-austin', 'austin', 'firehose.p0:downstream', 'sources/php:php-errors:partition' );
		$node   = $this->broker( 'remote-austin', $tokens );
		$twin   = $this->broker( 'remote-twin', $node->arguments() );

		$this->assertSame( $tokens, $twin->arguments() );
		$line = \strtok( $node->dump_config(), "\n" );
		$this->assertStringContainsString( 'firehose.p0:downstream sources/php:php-errors:partition', (string) $line );
		$bare = static fn ( string $l ): string => (string) \preg_replace( '/^make_node Remote_Source \S+ /', '', $l );
		$this->assertSame( $bare( (string) $line ), $bare( (string) \strtok( $twin->dump_config(), "\n" ) ) );
	}

	public function test_valve_backpressures_only_on_buffer_water_marks(): void {
		// Edge-triggered buffer management: DISARM only when the buffer crosses above
		// high-water, RE-ARM only when it drains back below low-water. The valve stays
		// OPEN through normal flow (the old disarm-on-every-line gate stop-started the
		// spoke and lagged the hub 10-20s). No disarm on an empty buffer, no arm per poll.
		[ $node, $child ] = $this->make_remote();
		$sse = new class() extends SSE_In_Node {
			public int $arms    = 0;
			public int $disarms = 0;
			public function arm(): void {
				++$this->arms; }
			public function disarm(): void {
				++$this->disarms; }
		};
		( new \ReflectionProperty( \Newspack_Nodes\Remote_Link_Node::class, 'sse_in' ) )->setValue( $node, $sse );
		$buffer = new \ReflectionProperty( Remote_Consumer_Node::class, 'buffer' );
		$armed  = new \ReflectionProperty( Remote_Source_Node::class, 'pump_armed' );
		$disarm = new \ReflectionMethod( $node, 'pump_maybe_disarm' );

		// Armed + below high-water: valve stays open (continuous flow).
		$armed->setValue( $node, true );
		$buffer->setValue( $child, \str_repeat( 'x', 100 * 1024 ) );
		$disarm->invoke( $node );
		$this->assertSame( 0, $sse->disarms, 'below high-water stays armed' );

		// Armed + above high-water: disarm once (backpressure).
		$buffer->setValue( $child, \str_repeat( 'x', 600 * 1024 ) );
		$disarm->invoke( $node );
		$this->assertSame( 1, $sse->disarms );
		$this->assertFalse( $armed->getValue( $node ), 'disarm flips the valve state' );

		// Disarmed + still above low-water: NO re-arm (hysteresis band).
		$buffer->setValue( $child, \str_repeat( 'x', 300 * 1024 ) );
		$node->pump_maybe_arm();
		$this->assertSame( 0, $sse->arms, 'above low-water does not re-arm' );

		// Disarmed + drained below low-water: re-arm.
		$buffer->setValue( $child, \str_repeat( 'x', 10 * 1024 ) );
		$node->pump_maybe_arm();
		$this->assertSame( 1, $sse->arms, 're-arm once drained below low-water' );

		// Armed + empty buffer: NO idle disarm, NO redundant arm-on-poll.
		$buffer->setValue( $child, '' );
		$node->pump_maybe_arm();
		$disarm->invoke( $node );
		$this->assertSame( 1, $sse->arms, 'no arm-on-poll when already armed' );
		$this->assertSame( 1, $sse->disarms, 'no disarm on an empty buffer' );
	}

	public function test_the_valve_closes_on_the_connections_whole_backlog(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'firehose.p0:downstream', 'sources/php:php-errors' ) );
		$this->drain_connect_queue();
		$sse  = Core::node( 'remote-austin:sse-in' );
		$blob = \str_repeat( 'q', 270000 );
		foreach ( [ 'firehose.p0', 'sources/php' ] as $i => $from ) {
			$sse->process_sse_chunk( self::sse_frame( 'msg', [ Message::TYPE => Message::TM_BYTESTREAM, Message::FROM => $from, Message::ID => "1:{$i}:1", Message::VALUE => $blob ] ) );
		}

		$this->assertFalse( $this->read_private( $node, 'pump_armed' ), 'two half-full readers fill one connection' );
	}

	public function test_first_tick_creates_and_configures_sse_in_patron(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ , $child ] = $this->make_remote( 'remote-austin' );

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		$this->assertSame( 'https://austin.example', $this->read_private( $sse, 'url' ) );
		$this->assertSame( 'u', $this->read_private( $sse, 'auth_username' ) );
		( $sse->on_connecting )();
		$this->assertSame( [ 'firehose.p0' ], $this->read_private( $sse, 'subscribe' ) );
		// SSE_In hands each raw `msg` payload to the broker's routing seam; the
		// target a line takes belongs to the READER its stamp names.
		$this->assertInstanceOf( \Closure::class, $sse->on_message, 'the raw-delivery seam is wired' );
		$this->assertSame( 'downstream', $child->target() );
	}

	public function test_first_tick_creates_http_out_patron(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->make_remote( 'remote-austin' );

		$http = Core::node( 'remote-austin:http-out' );
		$this->assertInstanceOf( HTTP_Out_Node::class, $http );
		$this->assertSame( 'austin', $this->read_private( $http, 'vault_id' ) );
	}

	public function test_delegates_counter_bytes_read_largest_msg_to_its_sse_in(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );
		$sse = Core::node( 'remote-austin:sse-in' );

		$sse->process_sse_chunk( "event: heartbeat\ndata: {}\n\n" );
		$sse->process_sse_chunk( self::stream_frame( [
			Message::TYPE  => Message::TM_STRUCT,
			Message::KEY   => 'k',
			Message::VALUE => [ 'a' => 1 ],
		] ) );

		// The broker reports the stream stats of its SSE_In child, not its own
		// (which never reads the wire).
		$this->assertGreaterThan( 0, $sse->bytes_read() );
		$this->assertSame( $sse->bytes_read(), $node->bytes_read() );
		$this->assertSame( $sse->counter(), $node->counter() );
		$this->assertSame( $sse->largest_msg_sent(), $node->largest_msg_sent() );
	}

	public function test_missing_vault_entry_stays_disconnected_no_patrons(): void {
		$this->make_remote( 'remote-ghost', $this->remote_args( 'remote-ghost', 'ghost' ) );

		$this->assertNull( Core::node( 'remote-ghost:sse-in' ) );
		$this->assertNull( Core::node( 'remote-ghost:http-out' ) );
	}

	public function test_remove_node_tears_down_patrons_and_readers(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );
		$this->assertInstanceOf( SSE_In_Node::class, Core::node( 'remote-austin:sse-in' ) );
		$this->assertInstanceOf( HTTP_Out_Node::class, Core::node( 'remote-austin:http-out' ) );

		$node->remove_node();

		$this->assertNull( Core::node( 'remote-austin:sse-in' ) );
		$this->assertNull( Core::node( 'remote-austin:http-out' ) );
		$this->assertNull( Core::node( 'remote-austin:firehose.p0' ) );
		$this->assertNull( Core::node( 'remote-austin:firehose.p0:offsetlog' ) );
		$this->assertNull( Core::node( 'remote-austin:firehose.p0:deadletter' ) );
		$this->assertSame( [], $this->readers( $node ) );
	}

	public function test_node_schema_visible_io_with_args(): void {
		$schema = Remote_Source_Node::node_schema();
		$this->assertSame( 'I/O', $schema['category'] );
		$this->assertArrayNotHasKey( 'hidden', $schema );
		$this->assertSame( [ 'vault_id', 'offsetlog_root', 'deadletter_root' ], \array_column( $schema['arguments'], 'name' ) );
		$this->assertSame( [ 'set_multi_writer', 'assume_clean_shutdown' ], \array_column( $schema['commands'], 'name' ) );
	}

	/**
	 * A reader's cursor dir is an ARGUMENT of the broker: the topology writes
	 * the root, so it can carry `<topology>`, and each reader nests under it.
	 */
	public function test_a_readers_dirs_nest_under_the_broker_roots(): void {
		$node = $this->broker( 'src-a', [ 'zebra-vault', "{$this->base_dir}/offsets/combined", "{$this->base_dir}/dead/combined", 'sources/php:php-errors' ] );
		$node->fire();
		$child = Core::node( 'src-a:sources:php' );

		$this->assertSame( "{$this->base_dir}/offsets/combined/sources:php", $this->read_private( $child, 'offsetlog_dir' ) );
		$this->assertSame( "{$this->base_dir}/dead/combined/sources:php", $this->read_private( $child, 'deadletter_dir' ) );
	}

	// ---------------------------------------------------------------------
	// Ownership: a reader of a source naming no partition belongs to p0.
	// ---------------------------------------------------------------------

	/**
	 * Build and connect a broker over two fixed pairs and two partitioned
	 * ones, under whatever partition is bound.
	 *
	 * @return array{0:Remote_Source_Node,1:array<string,string>} The broker, then the last request's query.
	 */
	private function owned_broker(): array {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$asked = [];
		$this->record_requests( $asked );
		$node = $this->broker( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'sources/php:php-errors', 'firehose.p{partition}:downstream', 'jobstats.p{partition}:downstream', 'errors.*:downstream' ) );
		$node->fire();
		$this->drain_connect_queue();
		return [ $node, \end( $asked ) ];
	}

	public function test_off_partition_zero_a_pair_naming_no_partition_builds_no_reader(): void {
		Core::$var['partition'] = '2';
		[ $node, $query ] = $this->owned_broker();

		$this->assertSame( [ 'firehose.p2', 'jobstats.p2' ], \array_keys( $this->readers( $node ) ) );
		$this->assertNull( Core::node( 'remote-austin:sources:php' ) );
		$this->assertSame( 'firehose.p2,jobstats.p2', $query['subscribe'], 'neither sources/php nor the glob rides the stream' );
		$this->assertDirectoryDoesNotExist( \Newspack_Nodes\Config::get_offsets_directory() . '/remote-austin/sources:php' );
		$this->assertStringContainsString( "sources/php:php-errors firehose.p{partition}:downstream jobstats.p{partition}:downstream errors.*:downstream", $node->dump_config(), 'the pairs replay as written' );
	}

	public function test_on_partition_zero_every_pair_builds_its_reader(): void {
		[ $node, $query ] = $this->owned_broker();

		$this->assertSame( [ 'sources/php', 'firehose.p0', 'jobstats.p0' ], \array_keys( $this->readers( $node ) ) );
		$this->assertSame( 'sources/php,firehose.p0,jobstats.p0,errors.*', $query['subscribe'] );
	}

	/** Outside a worker a per-partition pair names no partition's log, so it is refused. */
	public function test_outside_a_worker_a_per_partition_pair_is_refused(): void {
		unset( Core::$var['partition'] );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( "Remote_Source: pair 'firehose.p{partition}:downstream' names {partition}, but no partition is bound" );
		$this->broker( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'sources/php:php-errors', 'firehose.p{partition}:downstream' ) );
	}

	/** Outside a worker a fixed pair is owned, as ADR-33 has it. */
	public function test_outside_a_worker_a_fixed_pair_builds_its_reader(): void {
		unset( Core::$var['partition'] );
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$node = $this->broker( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'sources/php:php-errors', 'firehose.p3:downstream' ) );
		$node->fire();

		$this->assertSame( [ 'sources/php', 'firehose.p3' ], \array_keys( $this->readers( $node ) ) );
	}

	// ---------------------------------------------------------------------
	// Pairs: one reader per stamp, one request for all of them.
	// ---------------------------------------------------------------------

	public function test_each_pair_gets_a_reader_named_for_its_stamp(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'firehose.p0:downstream', 'sources/php:php-errors' ) );

		$this->assertSame( [ 'firehose.p0', 'sources/php' ], \array_keys( $this->readers( $node ) ) );
		$this->assertInstanceOf( Remote_Consumer_Node::class, Core::node( 'remote-austin:sources:php' ) );
		$this->assertSame( 'php-errors', Core::node( 'remote-austin:sources:php' )->target() );
	}

	public function test_one_request_carries_every_pair_from_its_own_cursor(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$asked = [];
		\Newspack_Nodes\Event_Framework::$curl_dispatch = static function ( array $opts ) use ( &$asked ): \CurlHandle {
			\parse_str( (string) \parse_url( Core::as_string( $opts[ \CURLOPT_URL ] ), PHP_URL_QUERY ), $query );
			$asked[] = $query;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
		$this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'firehose.p0:downstream', 'sources/php:php-errors' ) );
		Core::node( 'remote-austin:firehose.p0' )->next_offset( [ 'segment' => 14, 'offset' => 2203 ] );
		$this->drain_connect_queue();

		$this->assertSame( 'firehose.p0,sources/php', \end( $asked )['subscribe'] );
		$this->assertSame(
			[ 'firehose.p0' => [ 'segment' => 14, 'offset' => 2203 ], 'sources/php' => Consumer_Node::SEEK_END ],
			\json_decode( \end( $asked )['positions'], true )
		);
	}

	public function test_each_line_reaches_the_reader_its_stamp_names(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$php = new Capture_Sink_Node();
		$php->name( 'php-errors' );
		[ , , $sink ] = $this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'firehose.p0:downstream', 'sources/php:php-errors' ) );
		$sse = Core::node( 'remote-austin:sse-in' );
		foreach ( [ [ 'firehose.p0/job-worker.p0', '3:0:40', 'fh-6612' ], [ 'sources/php', '91827:400:52', 'php-7715' ] ] as [ $from, $crumb, $value ] ) {
			$sse->process_sse_chunk( self::sse_frame( 'msg', [ Message::TYPE => Message::TM_BYTESTREAM, Message::FROM => $from, Message::ID => $crumb, Message::VALUE => $value ] ) );
		}
		Core::node( 'remote-austin:firehose.p0' )->poll();
		Core::node( 'remote-austin:sources:php' )->poll();

		$this->assertSame( [ 'fh-6612' ], \array_column( $sink->captured, Message::VALUE ) );
		$this->assertSame( [ 'php-7715' ], \array_column( $php->captured, Message::VALUE ) );
		$this->assertSame( [ 'segment' => 91827, 'offset' => 452 ], Core::node( 'remote-austin:sources:php' )->connect_position() );
	}

	public function test_a_pair_target_naming_no_node_still_advances(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ , $child ] = $this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'firehose.p0:nowhere-3318' ) );
		Core::node( 'remote-austin:sse-in' )->process_sse_chunk( self::stream_msg( '4:100:30', '', [ 'p' => 1 ] ) );

		$child->poll();

		$this->assertSame( [ 'segment' => 4, 'offset' => 130 ], $child->connect_position() );
		$this->assertSame( 0, $this->count_log_records( $this->read_private( $child, 'deadletter_dir' ) ), 'an unrouted line is not poison' );
	}

	public function test_a_line_no_pair_matches_is_dropped(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$errors = $this->capture_stderr();
		[ $node, $child ] = $this->make_remote();

		Core::node( 'remote-austin:sse-in' )->process_sse_chunk( self::sse_frame( 'msg', [ Message::TYPE => Message::TM_BYTESTREAM, Message::FROM => 'jobstats.p5', Message::ID => '1:0:10', Message::VALUE => 'stray-5501' ] ) );

		$this->assertSame( [ 'firehose.p0' ], \array_keys( $this->readers( $node ) ) );
		$this->assertSame( 0, $child->buffered_bytes(), 'no reader is handed it' );
		$this->assertStringContainsString( 'dropping a line no pair claims: jobstats.p5', \implode( '', $errors->getArrayCopy() ) );
	}

	public function test_a_line_with_no_stamp_is_dropped(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$errors   = $this->capture_stderr();
		[ $node ] = $this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'kea*:herd-52' ) );

		Core::node( 'remote-austin:sse-in' )->process_sse_chunk( self::sse_frame( 'msg', [ Message::TYPE => Message::TM_BYTESTREAM, Message::FROM => '', Message::ID => '1:0:10', Message::VALUE => 'unstamped-4417' ] ) );

		$this->assertSame( [], $this->readers( $node ) );
		$this->assertNull( Core::node( 'remote-austin:' ) );
		$this->assertStringContainsString( 'refusing a stamp outside the stream name grammar', \implode( '', $errors->getArrayCopy() ) );
	}

	/**
	 * A glob's `*` matches any run of a segment, so a spoke can send a stamp
	 * the pair claims that no stream would be named — a doubled dot, a space,
	 * a NUL, a name too long for a directory — or one naming a slot the
	 * broker keeps for itself.
	 *
	 * @return array<string,array{string,string,string}> Label => pair, the stamp a spoke sends, the refusal logged.
	 */
	public static function hostile_stamps(): array {
		$grammar = 'refusing a stamp outside the stream name grammar';
		return [
			'a doubled dot under a glob'          => [ 'kea*:herd-52', 'kea..', $grammar ],
			'a grouped doubled dot under a glob'  => [ 'offsets/kea*:audit-26', 'offsets/kea..', $grammar ],
			'a space'                             => [ 'kea*:herd-52', 'kea hose.p0', $grammar ],
			'a NUL'                               => [ 'kea*:herd-52', "kea\0hose.p0", $grammar ],
			'a name too long for a directory'     => [ 'kea*:herd-52', 'kea' . \str_repeat( 'w', 300 ), $grammar ],
			'the slot of the broker\'s null sink' => [ 'n*:herd-52', 'null', 'refusing a stamp that names a slot the broker keeps: null' ],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider( 'hostile_stamps' )]
	public function test_a_stamp_outside_the_name_grammar_builds_no_reader( string $pair, string $stamp, string $refusal ): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$errors   = $this->capture_stderr();
		$offsets  = \Newspack_Nodes\Config::get_offsets_directory();
		$dead     = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' ) . '/deadletter';
		$before   = [ $this->tree( $offsets ), $this->tree( $dead ) ];
		[ $node ] = $this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', $pair ) );

		Core::node( 'remote-austin:sse-in' )->process_sse_chunk( self::sse_frame( 'msg', [ Message::TYPE => Message::TM_BYTESTREAM, Message::FROM => $stamp, Message::ID => '4:0:30', Message::VALUE => 'hostile-6731' ] ) );
		foreach ( $this->readers( $node ) as $reader ) {
			$reader->poll();
		}
		$node->hand_off_cursor();

		$this->assertSame( $before, [ $this->tree( $offsets ), $this->tree( $dead ) ], 'no directory or file appears for it' );
		$this->assertSame( [], $this->readers( $node ) );
		$this->assertStringContainsString( $refusal, \implode( '', $errors->getArrayCopy() ) );
		$this->assertStringNotContainsString( "\0", \implode( '', $errors->getArrayCopy() ), 'no byte of a refused stamp reaches stderr' );
	}

	public function test_a_handshake_naming_an_invalid_stamp_builds_no_reader(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'kea*:herd-52' ) );

		Core::node( 'remote-austin:sse-in' )->process_sse_chunk( self::connected_frame( 'SLOT 3 OWNER 31313131 CURSORS kea..x=6:30,kea-55.p1=8:20' ) );

		$this->assertSame( [ 'kea-55.p1' ], \array_keys( $this->readers( $node ) ) );
	}

	public function test_a_handshake_naming_a_reserved_slot_builds_no_reader(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'n*:herd-52' ) );

		Core::node( 'remote-austin:sse-in' )->process_sse_chunk( self::connected_frame( 'SLOT 3 OWNER 31313131 CURSORS null=4:10,nest-5.p1=2:3' ) );

		$this->assertSame( [ 'nest-5.p1' ], \array_keys( $this->readers( $node ) ) );
		$this->assertInstanceOf( \Newspack_Nodes\Null_Node::class, Core::node( 'remote-austin:null' ), 'the broker keeps its own slot' );
	}

	/** @return array<string,array{string}> Label => an exact pair whose reader would take a slot the broker keeps. */
	public static function reserved_pairs(): array {
		return [
			'the SSE_In patron'   => [ 'sse-in:audit-17' ],
			'the HTTP_Out patron' => [ 'http-out:audit-17' ],
			'the null sink'       => [ 'null:audit-17' ],
			'the interpreter'     => [ 'config:audit-17' ],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider( 'reserved_pairs' )]
	public function test_an_exact_pair_naming_a_reserved_slot_is_refused_at_make_node( string $pair ): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( "names a slot the broker keeps: '{$pair}'" );
		( new \Newspack_Nodes\Command_Interpreter_Node() )->make_node( 'Remote_Source', 'remote-austin', ...$this->remote_args( 'remote-austin', 'austin', $pair ) );
	}

	public function test_a_replay_keeps_counting_the_glob_readers_already_built(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$send     = static function ( string $from ): void {
			Core::node( 'remote-austin:sse-in' )->process_sse_chunk( self::sse_frame( 'msg', [ Message::TYPE => Message::TM_BYTESTREAM, Message::FROM => $from, Message::ID => '5:0:9', Message::VALUE => "line-{$from}" ] ) );
		};
		[ $node ] = $this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'kea-*:herd-52' ) );
		for ( $i = 1; $i <= Remote_Source_Node::MAX_READERS; $i++ ) {
			$send( "kea-{$i}" );
		}

		$node->arguments( $this->remote_args( 'remote-austin', 'austin', 'kea-*:herd-61' ) );
		$send( 'kea-' . ( Remote_Source_Node::MAX_READERS + 9 ) );

		$this->assertCount( Remote_Source_Node::MAX_READERS, $this->readers( $node ), 'readers with no dir yet still count after a replay' );
	}

	public function test_the_reader_cap_holds_across_a_recycle_and_spares_exact_pairs(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$offsets  = \Newspack_Nodes\Config::get_offsets_directory();
		$args     = $this->remote_args( 'remote-austin', 'austin', 'kea-*:herd-52' );
		$send     = static function ( string $from ): void {
			Core::node( 'remote-austin:sse-in' )->process_sse_chunk( self::sse_frame( 'msg', [ Message::TYPE => Message::TM_BYTESTREAM, Message::FROM => $from, Message::ID => '3:0:9', Message::VALUE => "line-{$from}" ] ) );
		};
		[ $node ] = $this->make_remote( 'remote-austin', $args );
		for ( $i = 1; $i <= Remote_Source_Node::MAX_READERS; $i++ ) {
			$send( "kea-{$i}" );
		}
		foreach ( $this->readers( $node ) as $reader ) {
			$reader->poll();
		}
		$node->hand_off_cursor();
		$dirs = \glob( "{$offsets}/remote-austin/*", \GLOB_ONLYDIR );
		$this->assertCount( Remote_Source_Node::MAX_READERS, $dirs, 'each reader left its cursor dir' );

		$node->remove_node();
		$node = $this->broker( 'remote-austin', $args );
		$node->fire();
		$send( 'kea-' . ( Remote_Source_Node::MAX_READERS + 7 ) );
		$this->assertSame( [], $this->readers( $node ), 'the dirs a glob left count toward the cap' );
		$this->assertSame( $dirs, \glob( "{$offsets}/remote-austin/*", \GLOB_ONLYDIR ), 'and no new dir appears' );

		$send( 'kea-7' );
		$this->assertSame( [ 'kea-7' ], \array_keys( $this->readers( $node ) ), 'a stamp whose dir is there already costs nothing new' );

		$node->arguments( $this->remote_args( 'remote-austin', 'austin', 'kea-*:herd-52', 'firehose.p0:downstream' ) );
		$send( 'firehose.p0' );
		$this->assertInstanceOf( Remote_Consumer_Node::class, Core::node( 'remote-austin:firehose.p0' ), 'an exact pair is bounded by configuration, not the cap' );
	}

	public function test_a_glob_builds_at_most_max_readers(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$errors   = $this->capture_stderr();
		[ $node ] = $this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'kea-*:herd-52' ) );
		$sse      = Core::node( 'remote-austin:sse-in' );
		$send     = static function ( int $i ) use ( $sse ): void {
			$sse->process_sse_chunk( self::sse_frame( 'msg', [ Message::TYPE => Message::TM_BYTESTREAM, Message::FROM => "kea-{$i}", Message::ID => "{$i}:0:9", Message::VALUE => "kea-line-{$i}" ] ) );
		};

		for ( $i = 1; $i <= Remote_Source_Node::MAX_READERS; $i++ ) {
			$send( $i );
		}
		$this->assertCount( Remote_Source_Node::MAX_READERS, $this->readers( $node ) );
		$send( Remote_Source_Node::MAX_READERS + 1 );

		$this->assertCount( Remote_Source_Node::MAX_READERS, $this->readers( $node ) );
		$this->assertNull( Core::node( 'remote-austin:kea-' . ( Remote_Source_Node::MAX_READERS + 1 ) ) );
		$this->assertStringContainsString( 'refusing a reader past MAX_READERS', \implode( '', $errors->getArrayCopy() ) );
	}

	/** @return list<string> Every path under $dir, relative to it, sorted. */
	private function tree( string $dir ): array {
		if ( ! \is_dir( $dir ) ) {
			return [];
		}
		$paths = [];
		$walk  = new \RecursiveIteratorIterator( new \RecursiveDirectoryIterator( $dir, \FilesystemIterator::SKIP_DOTS ), \RecursiveIteratorIterator::SELF_FIRST );
		foreach ( $walk as $path => $info ) {
			$paths[] = \substr( (string) $path, \strlen( $dir ) );
		}
		\sort( $paths );
		return $paths;
	}

	/** Collect every stderr line the test raises. */
	private function capture_stderr(): \ArrayObject {
		$errors = new \ArrayObject();
		Core::set_stderr_handler( static function ( string $text ) use ( $errors ): void {
			$errors[] = $text;
		} );
		return $errors;
	}

	public function test_a_torn_frame_is_dropped_at_the_broker(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node, $child ] = $this->make_remote();

		Core::node( 'remote-austin:sse-in' )->process_sse_chunk( "event: msg\ndata: torn-frame-4410\n\n" );

		$this->assertSame( 0, $child->buffered_bytes(), 'a frame with no stamp reaches no reader' );
		$this->assertSame( [ 'firehose.p0' ], \array_keys( $this->readers( $node ) ) );
	}

	public function test_a_relayed_line_carries_the_reader_before_the_spoke_trail(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$php = new Capture_Sink_Node();
		$php->name( 'php-errors' );
		$this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'sources/php:php-errors' ) );
		Core::node( 'remote-austin:sse-in' )->process_sse_chunk( self::sse_frame( 'msg', [ Message::TYPE => Message::TM_BYTESTREAM, Message::FROM => 'sources/php', Message::ID => '44120:96:58', Message::VALUE => "PHP Notice: 2290\n" ] ) );

		Core::node( 'remote-austin:sources:php' )->poll();

		$this->assertSame( 'remote-austin:sources:php/sources/php', $php->captured[0][ Message::FROM ] );
		$this->assertSame( '44120:96:58', $php->captured[0][ Message::ID ], 'the crumb stays the spoke\'s' );
	}

	public function test_a_trail_past_max_from_size_is_dropped_and_passed(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$errors = [];
		Core::set_stderr_handler( static function ( string $text ) use ( &$errors ): void {
			$errors[] = $text;
		} );
		[ , $child, $sink ] = $this->make_remote();
		$long = 'firehose.p0/' . \str_repeat( 'hop-7/', 200 );
		Core::node( 'remote-austin:sse-in' )->process_sse_chunk( self::sse_frame( 'msg', [ Message::TYPE => Message::TM_STRUCT, Message::FROM => $long, Message::ID => '6:300:45', Message::VALUE => [ 'p' => 3 ] ] ) );

		$child->poll();

		$this->assertSame( [], $sink->captured );
		$this->assertSame( [ 'segment' => 6, 'offset' => 345 ], $child->connect_position(), 'the refusal is consumed like a forward' );
		$this->assertStringContainsString( 'path exceeded ' . Node::MAX_FROM_SIZE . ' bytes', \implode( '', $errors ) );
		$this->assertSame( 0, $this->count_log_records( $this->read_private( $child, 'deadletter_dir' ) ), 'an over-long trail is not poison' );
	}

	public function test_a_replay_dropping_a_pair_retracts_only_its_children(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node, $kept ] = $this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'firehose.p0:downstream', 'sources/php:php-errors' ) );
		Core::node( 'remote-austin:sources:php' )->next_offset( [ 'segment' => 6123, 'offset' => 77 ] );
		$kept->next_offset( [ 'segment' => 58, 'offset' => 3307 ] );

		$node->arguments( $this->remote_args( 'remote-austin', 'austin', 'firehose.p0:downstream' ) );

		$this->assertNull( Core::node( 'remote-austin:sources:php' ) );
		$this->assertSame( $kept, Core::node( 'remote-austin:firehose.p0' ), 'the surviving reader is the same instance' );
		$this->assertSame( [ 'segment' => 58, 'offset' => 3307 ], $kept->connect_position(), 'with its cursor intact' );
		$this->assertSame( [ 'firehose.p0' ], \array_keys( $this->readers( $node ) ) );
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$this->assertSame( [ 6123, 77 ], $this->frame_in( "{$offsets}/remote-austin/sources:php" ), 'the retracted reader handed its cursor off' );
	}

	public function test_a_replay_dropping_a_pair_restreams_without_it(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$asked = [];
		$this->record_requests( $asked );
		[ $node ] = $this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'firehose.p0:downstream', 'sources/php:php-errors' ) );
		$this->drain_connect_queue();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertSame( 'firehose.p0,sources/php', \end( $asked )['subscribe'] );

		$node->arguments( $this->remote_args( 'remote-austin', 'austin', 'firehose.p0:downstream' ) );
		$this->assertNull( $sse->test_get_handle(), 'the dropped source leaves the stream' );
		Core::$now = 640.0;
		$node->fire();
		$this->drain_connect_queue();

		$this->assertSame( 'firehose.p0', \end( $asked )['subscribe'] );
	}

	public function test_a_replay_retargets_a_surviving_reader(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node, $child ] = $this->make_remote();

		$node->arguments( $this->remote_args( 'remote-austin', 'austin', 'firehose.p0:audit-6604' ) );

		$this->assertSame( $child, Core::node( 'remote-austin:firehose.p0' ) );
		$this->assertSame( 'audit-6604', $child->target() );
	}

	public function test_a_replay_moving_the_roots_moves_each_readers_dirs_and_keeps_a_pause(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node, $child ] = $this->make_remote();
		$child->pause();
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );

		$node->arguments( [ 'austin', "{$offsets}/moved-7721", "{$base}/deadletter/moved-7721", 'firehose.p0:downstream' ] );

		$this->assertSame( $child, Core::node( 'remote-austin:firehose.p0' ) );
		$this->assertSame( "{$offsets}/moved-7721/firehose.p0", $this->read_private( $child, 'offsetlog_dir' ) );
		$this->assertSame( "{$base}/deadletter/moved-7721/firehose.p0", $this->read_private( $child, 'deadletter_dir' ) );
		$this->assertSame( "{$offsets}/moved-7721/firehose.p0", $this->read_private( $child, 'offsetlog' )->partition_dir() );
		$this->assertFalse( $child->is_live(), 'a paused reader stays paused across the move' );
	}

	public function test_a_replay_changing_only_a_target_keeps_the_stream(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$asked = [];
		$this->record_requests( $asked );
		[ $node, $child ] = $this->make_remote();
		$this->drain_connect_queue();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertNotNull( $sse->test_get_handle() );

		$node->arguments( $this->remote_args( 'remote-austin', 'austin', 'firehose.p0:audit-3318' ) );

		$this->assertSame( 'audit-3318', $child->target() );
		$this->assertNotNull( $sse->test_get_handle(), 'a target names no stream, so the stream stands' );
	}

	public function test_a_replay_moving_the_roots_renames_the_offsetlog_whole(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node, $child ] = $this->make_remote();
		$child->next_offset( [ 'segment' => 41, 'offset' => 2719 ] );
		$child->hand_off_cursor();
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		$frames  = \count( \glob( "{$offsets}/remote-austin/firehose.p0/*.log" ) );

		$node->arguments( [ 'austin', "{$offsets}/moved-5306", "{$base}/deadletter/moved-5306", 'firehose.p0:downstream' ] );

		$this->assertGreaterThan( $frames, \count( \glob( "{$offsets}/moved-5306/firehose.p0/*.log" ) ), 'every frame arrives, the pre-move one on top' );
		$this->assertSame( [ 41, 2719 ], $this->frame_in( "{$offsets}/moved-5306/firehose.p0" ) );
		$this->assertDirectoryDoesNotExist( "{$offsets}/remote-austin/firehose.p0" );
	}

	public function test_a_replay_moving_the_roots_resumes_at_the_cursor_past_the_last_checkpoint(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node, $child ] = $this->make_remote();
		$child->next_offset( [ 'segment' => 41, 'offset' => 2719 ] );
		$child->hand_off_cursor();
		$child->next_offset( [ 'segment' => 43, 'offset' => 6187 ] );
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		$moved   = [ 'austin', "{$offsets}/moved-3946", "{$base}/deadletter/moved-3946", 'firehose.p0:downstream' ];

		$node->arguments( $moved );
		$successor = $this->broker( 'remote-boston', $moved );
		$successor->fire();

		$this->assertSame(
			[ 'segment' => 43, 'offset' => 6187 ],
			Core::node( 'remote-boston:firehose.p0' )->connect_position(),
			'the move replays nothing the reader had already passed'
		);
	}

	public function test_a_replay_moving_the_roots_before_any_restore_carries_the_old_frame(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node, $child ] = $this->make_remote();
		$child->next_offset( [ 'segment' => 17, 'offset' => 963 ] );
		$child->hand_off_cursor();
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		// A second broker on the same roots: a successor that has read nothing yet.
		$node = $this->broker( 'remote-boston', $this->remote_args() );
		$node->fire();

		$node->arguments( [ 'austin', "{$offsets}/moved-8842", "{$base}/deadletter/moved-8842", 'firehose.p0:downstream' ] );

		$this->assertSame( [ 17, 963 ], $this->frame_in( "{$offsets}/moved-8842/firehose.p0" ), 'the frame no restore had read yet moves too' );
	}

	public function test_a_replay_moving_the_roots_onto_an_existing_dir_keeps_both_and_reads_neither(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node, $child ] = $this->make_remote();
		$child->next_offset( [ 'segment' => 29, 'offset' => 5150 ] );
		$child->hand_off_cursor();
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		$old     = "{$offsets}/remote-austin/firehose.p0";
		// A frame that will not unpack: reading it would throw.
		\file_put_contents( $old . '/' . \array_values( \array_diff( \scandir( $old ), [ '.', '..' ] ) )[0], "not a packed frame\n", \FILE_APPEND );
		\mkdir( "{$offsets}/taken-7194/firehose.p0", 0755, true );

		$node->arguments( [ 'austin', "{$offsets}/taken-7194", "{$base}/deadletter/taken-7194", 'firehose.p0:downstream' ] );

		$this->assertDirectoryExists( $old, 'the old cursor stays where it was' );
		$this->assertNull( $this->frame_in( "{$offsets}/taken-7194/firehose.p0" ), 'nothing was carried into a dir that already existed' );
		$this->assertStringContainsString( $old, \implode( '', Core::$recent_log ), 'the warning names the dir left behind' );
	}

	public function test_a_stop_due_during_the_move_still_completes_it_with_the_cursor_carried(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node, $child ] = $this->make_remote();
		$child->next_offset( [ 'segment' => 41, 'offset' => 2719 ] );
		$child->hand_off_cursor();
		// Restored once, then advanced; paused, so no tick checkpoints it first.
		$child->connect_position();
		$child->pause();
		$child->next_offset( [ 'segment' => 47, 'offset' => 1093 ] );
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );

		$stop = $this->with_stop_due(
			static function () use ( $node, $offsets, $base ): void {
				// Unthrottle the pump, so the move's first write checks the stop.
				( new \ReflectionProperty( Event_Framework::class, 'last_pump' ) )->setValue( Event_Framework::instance(), 0.0 );
				$node->arguments( [ 'austin', "{$offsets}/moved-6620", "{$base}/deadletter/moved-6620", 'firehose.p0:downstream' ] );
				Event_Framework::instance()->stop_check();
			}
		);

		$this->assertNotNull( $stop, 'the stop arrived, after the move' );

		$this->assertSame( [ 47, 1093 ], $this->frame_in( "{$offsets}/moved-6620/firehose.p0" ), 'the cursor was carried' );
		$this->assertDirectoryDoesNotExist( "{$offsets}/remote-austin/firehose.p0" );
		$this->assertSame( "{$offsets}/moved-6620/firehose.p0", $this->read_private( $child, 'offsetlog' )->partition_dir() );
	}

	public function test_a_move_does_not_count_as_a_crash(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node, $child ] = $this->make_remote();
		$child->next_offset( [ 'segment' => 41, 'offset' => 2719 ] );
		$child->hand_off_cursor();
		$child->next_offset( [ 'segment' => 52, 'offset' => 388 ] );
		( new \ReflectionProperty( Remote_Consumer_Node::class, 'attempts' ) )->setValue( $child, Remote_Consumer_Node::CRASH_MAX_ATTEMPTS - 1 );
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );

		$node->arguments( [ 'austin', "{$offsets}/moved-1158", "{$base}/deadletter/moved-1158", 'firehose.p0:downstream' ] );
		$child->connect_position();

		$this->assertFalse( $this->read_private( $child, 'crawl' ), 'a healthy reader that moved is no crash suspect' );
		$this->assertLessThanOrEqual( 1, $this->read_private( $child, 'attempts' ) );
		$this->assertSame( [], \glob( "{$base}/deadletter/moved-1158/firehose.p0/*.log" ) ?: [], 'nothing was dead-lettered' );
	}

	public function test_a_move_onto_a_dir_holding_a_frame_resumes_at_that_frame_and_says_so(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node, $child ] = $this->make_remote();
		$child->next_offset( [ 'segment' => 41, 'offset' => 2719 ] );
		$child->hand_off_cursor();
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		$taken   = new Partition_Node();
		$taken->arguments( [ "{$offsets}/taken-2271/firehose.p0" ] );
		$frame                   = Message::new_message();
		$frame[ Message::TYPE ]  = Message::TM_STRUCT;
		$frame[ Message::VALUE ] = [ 'segment' => 77, 'offset' => 1234, 'attempts' => 0, 'reason' => '', 'first_crash_ts' => null ];
		$taken->fill( $frame );
		$taken->flush();

		$node->arguments( [ 'austin', "{$offsets}/taken-2271", "{$base}/deadletter/taken-2271", 'firehose.p0:downstream' ] );

		$this->assertSame( [ 'segment' => 77, 'offset' => 1234 ], $child->connect_position() );
		$this->assertStringContainsString( '77:1234', \implode( '', Core::$recent_log ), 'the warning names the cursor the reader now follows' );
	}

	public function test_a_move_onto_an_empty_existing_dir_follows_the_cursor_in_memory_and_says_so(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node, $child ] = $this->make_remote();
		$child->next_offset( [ 'segment' => 41, 'offset' => 2719 ] );
		$child->hand_off_cursor();
		$child->next_offset( [ 'segment' => 58, 'offset' => 4410 ] );
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		\mkdir( "{$offsets}/taken-9035/firehose.p0", 0755, true );

		$node->arguments( [ 'austin', "{$offsets}/taken-9035", "{$base}/deadletter/taken-9035", 'firehose.p0:downstream' ] );

		$this->assertSame( [ 'segment' => 58, 'offset' => 4410 ], $child->connect_position() );
		$log = \implode( '', Core::$recent_log );
		$this->assertStringContainsString( '58:4410', $log );
		$this->assertStringContainsString( 'nothing durable', $log );
	}

	public function test_a_replay_moving_the_roots_renames_the_dead_letters_too(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote();
		$offsets  = \Newspack_Nodes\Config::get_offsets_directory();
		$base     = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		$old      = "{$base}/deadletter/remote-austin/firehose.p0";
		if ( ! \is_dir( $old ) ) {
			\mkdir( $old, 0755, true );
		}
		\file_put_contents( "{$old}/0.log", "quarantined-6631\n" );

		$node->arguments( [ 'austin', "{$offsets}/moved-2087", "{$base}/deadletter/moved-2087", 'firehose.p0:downstream' ] );

		$this->assertStringEqualsFile( "{$base}/deadletter/moved-2087/firehose.p0/0.log", "quarantined-6631\n" );
		$this->assertDirectoryDoesNotExist( $old );
	}

	public function test_a_broker_sink_change_reaches_every_reader(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node, $child ] = $this->make_remote();
		$elsewhere = new Capture_Sink_Node();
		$elsewhere->name( 'elsewhere-2209' );

		$node->sink( $elsewhere );

		$this->assertSame( $elsewhere, $child->sink() );
	}

	/** @return array{0:int,1:int}|null The newest frame's segment and offset in $dir. */
	private function frame_in( string $dir ): ?array {
		$partition = new Partition_Node();
		$partition->arguments( [ $dir ] );
		$frame = Remote_Consumer_Node::last_frame_of( $partition );
		return null === $frame ? null : [ $frame['segment'], $frame['offset'] ];
	}

	/** Record each request's decoded query, through the connect seam. */
	private function record_requests( array &$asked ): void {
		\Newspack_Nodes\Event_Framework::$curl_dispatch = static function ( array $opts ) use ( &$asked ): \CurlHandle {
			\parse_str( (string) \parse_url( Core::as_string( $opts[ \CURLOPT_URL ] ), PHP_URL_QUERY ), $query );
			$asked[] = $query;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
	}

	public function test_an_operational_handoff_reaches_every_reader_and_a_cooperative_one_none(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node, $child ] = $this->make_remote();
		$child->next_offset( [ 'segment' => 2, 'offset' => 9091 ] );

		$node->hand_off_cursor( 'timeout' );
		$this->assertSame( 0, $this->count_offsetlog_records( $child ), 'the worker sweep reaches the reader itself' );
		$node->hand_off_cursor();
		$this->assertSame( [ 2, 9091 ], [ $this->newest_offsetlog_frame( $child )['segment'], $this->newest_offsetlog_frame( $child )['offset'] ] );
	}

	public function test_a_connect_queued_before_pause_does_not_reopen_the_stream(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ , $child ] = $this->make_remote( 'remote-austin' );
		$sse = Core::node( 'remote-austin:sse-in' );

		$child->pause();
		$this->drain_connect_queue();

		$this->assertNull( $sse->test_get_handle(), 'a paused source holds no spoke slot' );
	}

	public function test_a_paused_reader_leaves_the_stream_and_play_brings_it_back(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$asked = [];
		$this->record_requests( $asked );
		Core::$now = 2000.0;
		[ $node ] = $this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'firehose.p0:downstream', 'sources/php:php-errors' ) );
		$this->drain_connect_queue();
		$php = Core::node( 'remote-austin:sources:php' );
		$php->next_offset( [ 'segment' => 7702, 'offset' => 88 ] );

		$php->pause();
		Core::$now = 2001.0;
		$node->fire();
		$this->drain_connect_queue();
		$this->assertSame( 'firehose.p0', \end( $asked )['subscribe'] );

		$php->play();
		Core::$now = 2002.0;
		$node->fire();
		$this->drain_connect_queue();
		$this->assertSame( 'firehose.p0,sources/php', \end( $asked )['subscribe'] );
		$this->assertSame( [ 'segment' => 7702, 'offset' => 88 ], \json_decode( \end( $asked )['positions'], true )['sources/php'] );
	}

	public function test_with_every_reader_paused_the_broker_holds_no_stream(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$asked = [];
		$this->record_requests( $asked );
		Core::$now = 3000.0;
		[ $node, $child ] = $this->make_remote();
		$this->drain_connect_queue();
		$child->pause();

		Core::$now = 3001.0;
		$node->fire();
		$this->assertNull( \Newspack_Nodes\Remote_Link_Node::shift_connect_queue(), 'the tick queues no connect' );
		$this->drain_connect_queue();

		$this->assertCount( 1, $asked, 'no request after the last reader paused' );
		$this->assertNull( Core::node( 'remote-austin:sse-in' )->test_get_handle() );
	}

	public function test_three_pauses_in_one_tick_reconnect_once(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$asked = [];
		$this->record_requests( $asked );
		Core::$now = 4000.0;
		[ $node ] = $this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'jobstats.p0:downstream', 'topicprobe.p0:downstream', 'tablestats.p0:downstream', 'firehose.p0:downstream' ) );
		$this->drain_connect_queue();
		foreach ( [ 'jobstats.p0', 'topicprobe.p0', 'tablestats.p0' ] as $stamp ) {
			// Past the connect backoff, so an immediate reconnect would not be refused.
			Core::$now += 30.0;
			Core::node( "remote-austin:{$stamp}" )->pause();
		}

		Core::$now += 1.0;
		$node->fire();
		$this->drain_connect_queue();

		$this->assertCount( 2, $asked, 'one connect, then one reconnect for the three pauses' );
		$this->assertSame( 'firehose.p0', \end( $asked )['subscribe'] );
	}

	public function test_a_glob_pair_builds_a_reader_per_stamp_and_skips_a_paused_one(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$asked = [];
		$this->record_requests( $asked );
		Core::$now = 5000.0;
		[ $node ] = $this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'errors.*:downstream' ) );
		$this->drain_connect_queue();
		$this->assertSame( [], $this->readers( $node ), 'a glob builds nothing until a stamp appears' );
		$sse = Core::node( 'remote-austin:sse-in' );
		$sse->process_sse_chunk( self::connected_frame( 'SLOT 3 OWNER 31313131 CURSORS errors.p0=4:10,errors.p2=8:20' ) );
		$this->assertSame( [ 'errors.p0', 'errors.p2' ], \array_keys( $this->readers( $node ) ) );

		Core::node( 'remote-austin:errors.p2' )->pause();
		Core::$now = 5001.0;
		$node->fire();
		$this->drain_connect_queue();

		$positions = \json_decode( \end( $asked )['positions'], true );
		$this->assertSame( 'errors.*', \end( $asked )['subscribe'] );
		$this->assertSame( \Newspack_Nodes\Rest\SSE_Out_Node::SKIP, $positions['errors.p2'] );
		$this->assertSame( [ 'segment' => 4, 'offset' => 10 ], $positions['errors.p0'] );
	}

	public function test_a_stamp_two_pairs_match_belongs_to_the_first(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'firehose.*:audit-91', 'firehose.p0:downstream' ) );

		$this->assertSame( 'audit-91', Core::node( 'remote-austin:firehose.p0' )->target() );
		$this->assertSame( [ 'firehose.p0' ], \array_keys( $this->readers( $node ) ) );
	}

	public function test_a_live_seek_restarts_the_stream_and_a_paused_one_does_not(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$asked = [];
		$this->record_requests( $asked );
		Core::$now = 6000.0;
		[ $node ] = $this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'firehose.p0:downstream', 'sources/php:php-errors' ) );
		$this->drain_connect_queue();
		$sse = Core::node( 'remote-austin:sse-in' );
		$php = Core::node( 'remote-austin:sources:php' );
		$this->assertNotNull( $sse->test_get_handle() );

		$php->pause();
		Core::$now = 6030.0;
		$node->fire();
		$this->drain_connect_queue();
		$this->assertCount( 2, $asked, 'one reconnect for the pause' );
		$this->assertSame( 'firehose.p0', \end( $asked )['subscribe'], 'a paused reader stays out of the request' );

		// A tick of its own, so no reconnect the pause owed can absorb it.
		$php->next_offset( [ 'segment' => 3, 'offset' => 5 ] );
		$this->assertNotNull( $sse->test_get_handle(), 'paused, a seek leaves the stream open' );
		Core::$now = 6045.0;
		$node->fire();
		$this->drain_connect_queue();
		$this->assertCount( 2, $asked, 'none for the seek' );

		$php->play();
		Core::$now = 6060.0;
		$node->fire();
		$this->drain_connect_queue();
		$this->assertSame( 'firehose.p0,sources/php', \end( $asked )['subscribe'] );
		$this->assertNotNull( $sse->test_get_handle() );
		$php->next_offset( [ 'segment' => 9, 'offset' => 1 ] );
		$this->assertNull( $sse->test_get_handle(), 'live, a seek drops the stream for the tick to reopen' );
	}

	// ---------------------------------------------------------------------
	// Multi-writer seal-grace and the fanned-out reader toggle.
	// ---------------------------------------------------------------------

	public function test_seal_grace_seeds_a_patron_created_after_the_verb(): void {
		// The aggregator configures its spokes before anything connects, so the
		// flag has to survive until the patron exists.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$node = $this->broker( 'remote-austin' );
		$node->set_multi_writer( true );

		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		$this->assertTrue( $this->read_private( $sse, 'multi_writer' ) );
	}

	public function test_seal_grace_reaches_a_live_patron_and_drops_the_stream(): void {
		// It rides a connect-time query parameter, so the current stream has to
		// go for the far-side reader to pick the change up.
		$node = $this->broker();
		$sse  = $this->seal_grace_spy();
		( new \ReflectionProperty( \Newspack_Nodes\Remote_Link_Node::class, 'sse_in' ) )->setValue( $node, $sse );

		$node->set_multi_writer( true );

		$this->assertTrue( $sse->seal_grace );
		$this->assertSame( 1, $sse->disconnects, 'the stream is re-established to carry the new parameter' );
	}

	public function test_reasserting_the_same_seal_grace_leaves_the_stream_up(): void {
		// The verb is what an operator or an idempotent apply script invokes, and
		// re-asserting a value the source already holds should cost nothing.
		$node = $this->broker();
		$sse  = $this->seal_grace_spy();
		( new \ReflectionProperty( \Newspack_Nodes\Remote_Link_Node::class, 'sse_in' ) )->setValue( $node, $sse );
		$node->set_multi_writer( true );

		$node->set_multi_writer( true );

		$this->assertSame( 1, $sse->disconnects, 'only the change drops the stream' );
	}

	/** SSE_In double recording the seal-grace pushed to it and every disconnect. */
	private function seal_grace_spy(): SSE_In_Node {
		return new class() extends SSE_In_Node {
			public ?bool $seal_grace = null;
			public int $disconnects  = 0;
			public function set_multi_writer( bool $flag ): void {
				$this->seal_grace = $flag; }
			public function disconnect(): void {
				++$this->disconnects; }
		};
	}

	public function test_set_multi_writer_is_a_declared_verb(): void {
		$verbs = \array_column( Remote_Source_Node::node_schema()['commands'], 'name' );
		$this->assertContains( 'set_multi_writer', $verbs );
	}

	public function test_dump_config_roundtrips_set_multi_writer(): void {
		// A console serialize → replay that dropped the flag would silently put
		// the hub back on a reader that orphans stragglers.
		$node = $this->broker( 'remote-austin' );
		$node->set_multi_writer( true );

		$matched = \preg_match(
			'/command_node remote-austin:config set_multi_writer (\S+)/',
			$node->dump_config(),
			$matches
		);

		$this->assertSame( 1, $matched, 'the flag is emitted with an explicit argument' );
		$replayed    = $this->broker( 'remote-austin-replayed' );
		$interpreter = $this->read_private( $replayed, 'interpreter' );
		$interpreter->dispatch( 'set_multi_writer', [ $matches[1] ] );
		$this->assertTrue( $this->read_private( $replayed, 'multi_writer' ), 'and replays back to on' );
	}

	public function test_assume_clean_shutdown_fans_out_to_every_reader_present_and_later(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node, $child ] = $this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'firehose.p0:downstream', 'errors.*:audit-31' ) );

		$this->read_private( $node, 'interpreter' )->dispatch( 'assume_clean_shutdown', [ 'true' ] );
		Core::node( 'remote-austin:sse-in' )->process_sse_chunk( self::sse_frame( 'msg', [ Message::TYPE => Message::TM_BYTESTREAM, Message::FROM => 'errors.p4', Message::ID => '2:0:9', Message::VALUE => 'late-3141' ] ) );

		$this->assertTrue( $this->read_private( $child, 'assume_clean_shutdown' ) );
		$this->assertTrue( $this->read_private( Core::node( 'remote-austin:errors.p4' ), 'assume_clean_shutdown' ), 'a reader built later takes it too' );
		$this->assertStringContainsString( 'command_node remote-austin:config assume_clean_shutdown true', $node->dump_config() );
	}

	// ---------------------------------------------------------------------
	// Heartbeat and status snapshot.
	// ---------------------------------------------------------------------

	public function test_heartbeat_skipped_when_slot_unknown(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->make_remote( 'remote-austin' );

		$http = Core::node( 'remote-austin:http-out' );
		$this->assertCount( 0, $this->read_private( $http, 'batch' ) );
	}

	public function test_heartbeat_command_contains_exact_slot_and_owner(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );

		// Give the SSE_In a complete lease via the connected handshake.
		$sse = Core::node( 'remote-austin:sse-in' );
		self::set_slot( $sse, 7, 42424243 );

		// Advance clock past the heartbeat interval (16s) but under the stale timeout (45s).
		Core::$now = \microtime( true ) + 16;
		$node->fire();

		$http  = Core::node( 'remote-austin:http-out' );
		$batch = $this->read_private( $http, 'batch' );
		$this->assertCount( 1, $batch );
		$envelope = $batch[0];
		$this->assertSame( Message::TM_COMMAND, $envelope[ Message::TYPE ] );
		$this->assertSame( 'remote-austin', $envelope[ Message::FROM ] );
		$this->assertSame( 'workers', $envelope[ Message::TO ] );
		$value = $envelope[ Message::VALUE ];
		$this->assertSame( 'heartbeat', $value['name'] );
		$this->assertSame( [ '7', '42424243' ], $value['arguments'] );
	}

	public function test_heartbeat_reply_into_fill_records_rtt_and_response(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );
		$sse = Core::node( 'remote-austin:sse-in' );
		self::set_slot( $sse, 5 );
		Core::$now = \microtime( true ) + 16;
		$node->fire(); // sends heartbeat, records send-time

		// Simulate the spoke's heartbeat reply routed back into fill(). The spoke's
		// interpreter wraps a command response as TM_COMMAND|TM_RESPONSE; fill()
		// records the RTT for that type and relays anything else to HTTP_Out.
		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$reply[ Message::TO ]    = 'remote-austin';
		$reply[ Message::VALUE ] = [
			'name'    => 'heartbeat',
			'payload' => [ 'success' => true, 'slot' => 5 ],
		];
		$node->fill( $reply );

		$status = $this->status_of( $node );
		$this->assertIsArray( $status );
		$this->assertArrayHasKey( 'last_heartbeat_response', $status );
		$this->assertArrayHasKey( 'last_heartbeat_rtt', $status );
		$this->assertNotNull( $status['last_heartbeat_response'] );
	}

	public function test_heartbeat_command_error_clears_prior_success_and_records_reason(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );
		// Twelve digits: no midfix's pid or uptime can hold the owner.
		self::set_slot( Core::node( 'remote-austin:sse-in' ), 7, 731942580617 );
		Core::$now = 1748960000.0;
		$node->fire();

		$success                   = Message::new_message();
		$success[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$success[ Message::VALUE ] = [
			'name'    => 'heartbeat',
			'payload' => [ 'success' => true, 'slot' => 7 ],
		];
		$node->fill( $success );
		$this->assertNotNull( $this->status_of( $node )['last_heartbeat_response'] );

		$lines = [];
		Core::set_stderr_handler(
			static function ( string $line ) use ( &$lines ): void {
				$lines[] = $line;
			}
		);
		$error                   = Message::new_message();
		$error[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_ERROR;
		$error[ Message::VALUE ] = [
			'name'    => 'heartbeat',
			'payload' => 'SSE slot lease not owned',
		];
		$node->fill( $error );

		$status = $this->status_of( $node );
		$this->assertNull( $status['last_heartbeat_response'] );
		$this->assertNull( $status['last_heartbeat_rtt'] );
		$this->assertSame(
			'Client heartbeat failed: SSE slot lease not owned',
			$status['last_error']
		);
		$this->assertStringContainsString( 'SSE slot lease not owned', \implode( '', $lines ) );
		$this->assertStringNotContainsString( '731942580617', \implode( '', $lines ) );
	}

	public function test_heartbeat_success_false_clears_prior_success_and_records_reason(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );
		self::set_slot( Core::node( 'remote-austin:sse-in' ), 7, 42424243 );
		Core::$now = 1748960000.0;
		$node->fire();

		$success                   = Message::new_message();
		$success[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$success[ Message::VALUE ] = [
			'name'    => 'heartbeat',
			'payload' => [ 'success' => true, 'slot' => 7 ],
		];
		$node->fill( $success );

		$rejected                   = Message::new_message();
		$rejected[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$rejected[ Message::VALUE ] = [
			'name'    => 'heartbeat',
			'payload' => [
				'success' => false,
				'error'   => 'slot lease ownership mismatch',
			],
		];
		$node->fill( $rejected );

		$status = $this->status_of( $node );
		$this->assertNull( $status['last_heartbeat_response'] );
		$this->assertNull( $status['last_heartbeat_rtt'] );
		$this->assertSame(
			'Client heartbeat failed: slot lease ownership mismatch',
			$status['last_error']
		);
	}

	public function test_publish_status_ages_out_stale_heartbeat_response(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );
		$sse = Core::node( 'remote-austin:sse-in' );
		self::set_slot( $sse, 5 );

		Core::$now = 1000.0;
		$node->fire(); // mints the heartbeat (records send-time)
		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$reply[ Message::TO ]    = 'remote-austin';
		$reply[ Message::VALUE ] = [
			'name'    => 'heartbeat',
			'payload' => [ 'success' => true, 'slot' => 5 ],
		];
		$node->fill( $reply ); // records last_heartbeat_response at t=1000

		// A tick right after the reply keeps the fresh response in the snapshot.
		$node->fire();
		$this->assertNotNull( $this->status_of( $node )['last_heartbeat_response'] );

		// No further reply; advance past the HEARTBEAT_INTERVAL*4 staleness window.
		// The Status badge must not latch 'success' on a stale timestamp, so the
		// snapshot ages the response out to null (mirrors the old clear-on-disconnect).
		Core::$now = 1000.0 + ( Remote_Source_Node::HEARTBEAT_INTERVAL * 4 ) + 5;
		$node->fire();
		$status = $this->status_of( $node );
		$this->assertNull( $status['last_heartbeat_response'] );
		$this->assertNull( $status['last_heartbeat_rtt'] );
	}

	public function test_publish_status_carries_the_schedule_a_stream_closed_at_eof_returns_on(): void {
		// The dashboard must tell "closed on purpose, back at T" from "failed",
		// and a null last_error also means "never attempted" — so the schedule
		// itself rides the snapshot as its own field.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		Core::$now = 1748970000.0;
		[ $node ] = $this->make_remote( 'remote-austin' );
		$this->drain_connect_queue();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		$handle = $sse->test_get_handle();
		$this->assertInstanceOf( \CurlHandle::class, $handle );

		$sse->process_sse_chunk( "retry: 9000\n\n" );
		self::set_slot( $sse, 5 );
		// The stub handle never transferred, so seed the status a live 200
		// stream would have observed while its bytes arrived.
		( new \ReflectionProperty( SSE_In_Node::class, 'last_http_code' ) )->setValue( $sse, 200 );
		$this->deliver_curl_rows( [ [ 'msg' => \CURLMSG_DONE, 'handle' => $handle, 'result' => \CURLE_OK ] ] );
		Core::$now = 1748970001.0;
		$node->fire();

		$status = $this->status_of( $node );
		$this->assertFalse( $status['connected'] );
		$this->assertNull( $status['last_error'], 'a scheduled close is not a failure' );
		$this->assertSame( 1748970009, $status['scheduled_reconnect_at'] );
	}

	public function test_publish_status_reports_an_opening_stream_as_connecting(): void {
		// A socket mid-open is neither up nor down; publishing it as connected
		// is what made a card read CONNECTED seconds before it timed out.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		Core::$now = 1748970000.0;
		[ $node ] = $this->make_remote( 'remote-austin' );
		$this->drain_connect_queue();
		// fire() housekeeps once per wall-second; the publish rides the next one.
		Core::$now = 1748970001.0;
		$node->fire();

		$status = $this->status_of( $node );
		$this->assertFalse( $status['connected'], 'no handshake yet' );
		$this->assertTrue( $status['connecting'] );
	}

	public function test_publish_status_reports_a_handshaken_stream_as_connected(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		Core::$now = 1748970000.0;
		[ $node ] = $this->make_remote( 'remote-austin' );
		$this->drain_connect_queue();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		self::set_slot( $sse, 5 );
		Core::$now = 1748970001.0;
		$node->fire();

		$status = $this->status_of( $node );
		$this->assertTrue( $status['connected'] );
		$this->assertFalse( $status['connecting'] );
	}

	public function test_published_status_carries_the_skipped_line_count(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );
		$sse = Core::node( 'remote-austin:sse-in' );
		$sse->process_sse_chunk( self::unparseable_frame( 'COUNT 4 CURSORS firehose.p0=5:95' ) );

		Core::$now = 1001.0;
		$node->fire();

		$this->assertSame( 4, $this->status_of( $node )['unparseable_lines'] );
	}

	public function test_a_released_slot_never_reaches_the_dashboard(): void {
		// An idle stream ends and releases its own slot; a heartbeat already in
		// flight lands on the tombstone. Latching that into last_error paints a
		// healthy link with a failure banner it will never clear on its own.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );

		$node->fill( $this->heartbeat_error( 'remote-austin', 'SSE slot lease not owned: slot_released' ) );

		$status = $this->status_of( $node );
		$this->assertNull( ( $status ?: [] )['last_error'] ?? null );
	}

	public function test_a_stolen_slot_still_reaches_the_dashboard(): void {
		// The counterpart guard: an eviction is a real fault and must surface.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );

		$node->fill( $this->heartbeat_error( 'remote-austin', 'SSE slot lease not owned: pointer_owner_mismatch' ) );

		$this->assertStringContainsString( 'pointer_owner_mismatch', (string) $this->status_of( $node )['last_error'] );
	}

	/**
	 * A `workers.heartbeat` error reply addressed back to the link that minted it.
	 *
	 * @return array<int,mixed> The 7-field positional message array.
	 */
	private function heartbeat_error( string $link, string $payload ): array {
		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_ERROR;
		$reply[ Message::TO ]    = $link;
		$reply[ Message::VALUE ] = [
			'name'    => 'heartbeat',
			'payload' => $payload,
		];
		return $reply;
	}

	public function test_tick_publishes_status_snapshot(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );

		$status = $this->status_of( $node );
		$this->assertIsArray( $status );
		$this->assertArrayHasKey( 'connected', $status );
		$this->assertArrayHasKey( 'current_backoff', $status );
		$this->assertArrayHasKey( 'last_connection_attempt', $status );
		$this->assertArrayHasKey( 'last_sse_heartbeat', $status );
	}

	public function test_status_is_keyed_by_broker_and_worker_partition(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		Core::$var['partition'] = '3';
		try {
			[ $node ] = $this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'firehose.p{partition}:downstream', 'sources/php:downstream' ) );
			Core::$now = 8000.0;
			$node->fire();
		} finally {
			Core::$var['partition'] = '0';
		}

		$status = Core::$memd->get( Remote_Source_Node::status_key_for( 'remote-austin', 3 ) );
		$this->assertArrayHasKey( 'connected', $status );
		$this->assertArrayNotHasKey( 'streams', $status, 'a reader states its position on the probe log alone' );
		$this->assertFalse( Core::$memd->get( Remote_Source_Node::status_key_for( 'remote-austin', 0 ) ) );
	}

	/** An unchanged snapshot is rewritten once a heartbeat interval, so an evicted key is back within one. */
	public function test_an_unchanged_status_is_written_again_once_a_heartbeat_interval(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node, $reader ] = $this->make_remote();
		$reader->pause();
		Core::$now = 8200.0;
		$node->fire();
		Core::$memd->delete( Remote_Source_Node::status_key_for( 'remote-austin', 0 ) );

		Core::$now = 8201.0;
		$node->fire();
		$this->assertFalse( $this->status_of( $node ), 'nothing changed, so nothing is written' );

		Core::$now = 8200.0 + Remote_Source_Node::HEARTBEAT_INTERVAL;
		$node->fire();
		$this->assertFalse( $this->status_of( $node )['connected'], 'an evicted snapshot is back within one heartbeat interval' );
	}

	/** A changed snapshot is written on the tick that changes it. */
	public function test_a_changed_status_is_written_at_once(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote();
		Core::$now = 8200.0;
		$node->fire();
		Core::$memd->delete( Remote_Source_Node::status_key_for( 'remote-austin', 0 ) );
		self::set_slot( Core::node( 'remote-austin:sse-in' ), 5 );

		Core::$now = 8201.0;
		$node->fire();

		$this->assertSame( 8201, $this->status_of( $node )['last_heartbeat_sent'] );
	}

	// ---------------------------------------------------------------------
	// The probe record: each reader's position on the one live-position log.
	// ---------------------------------------------------------------------

	/**
	 * A packed record off the spoke stream, its breadcrumb in ID.
	 *
	 * @return array{0:string,1:array<int,mixed>} The packed line and its message.
	 */
	private static function spoke_record( string $stamp, string $crumb ): array {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::FROM ]  = $stamp;
		$message[ Message::ID ]    = $crumb;
		$message[ Message::VALUE ] = [ 'crumb' => $crumb ];
		return [ Message::packed( $message ), $message ];
	}

	/** Sweep this process with a Topic_Probe and answer its records by READER. */
	private static function sweep_readers(): array {
		$capture = new Capture_Sink_Node();
		$probe   = new Topic_Probe_Node();
		$probe->name( 'topicprobe' );
		$probe->arguments( [] );
		$probe->sink( $capture );
		$probe->fire_cb();
		$records = \array_column( \array_column( $capture->captured, Message::VALUE ), null, Probe_Record::READER );
		unset( $records[''] );
		return $records;
	}

	public function test_a_topic_probe_sweep_records_each_reader_under_its_worker_scoped_id(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		Core::$var['topology']  = 'hub-4417';
		Core::$var['partition'] = '3';
		try {
			$this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'firehose.p{partition}:downstream', 'sources/php:downstream', 'jobstats.p{partition}:downstream' ) );
			$fire = Core::node( 'remote-austin:firehose.p3' );
			$jobs = Core::node( 'remote-austin:jobstats.p3' );
			foreach ( [ $fire, $jobs ] as $reader ) {
				$reader->poll();
			}
			$fire->next_offset( [ 'segment' => 12, 'offset' => 7311 ] );
			$received = 0;
			foreach ( [ '12:7311:200', '12:7511:157' ] as $crumb ) {
				[ $raw, $message ] = self::spoke_record( 'firehose.p3', $crumb );
				$fire->receive( $raw, $message );
				$received += \strlen( $raw ) + 1;
			}
			Core::$now = 517.25;
			$records   = self::sweep_readers();
		} finally {
			unset( Core::$var['topology'] );
			Core::$var['partition'] = '0';
		}

		$this->assertSame(
			[ 'hub-4417.remote-austin:firehose.p3.p3' => [ 'remote/austin:firehose.p3', 12, 7311, null, null, null, 0, $received, 17250 ] ],
			\array_map( self::probe_slots( ... ), $records ),
			'sources/php is read on p0 alone, and jobstats.p3 stands nowhere yet, so neither sends a record'
		);
	}

	public function test_a_file_readers_record_names_no_generation_until_the_spoke_does(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		Core::$var['topology'] = 'hub-4417';
		try {
			$this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'sources/php:downstream' ) );
			$php = Core::node( 'remote-austin:sources:php' );
			$php->poll();
			$php->next_offset( [ 'offset' => 40913 ] );
			Core::$now = 517.25;
			$records   = self::sweep_readers();
		} finally {
			unset( Core::$var['topology'] );
		}

		$this->assertSame(
			[ 'hub-4417.remote-austin:sources:php.p0' => [ 'remote/austin:sources:php', null, 40913, null, null, null, 0, 0, 17250 ] ],
			\array_map( self::probe_slots( ... ), $records )
		);
	}

	/**
	 * A probe record's position and throughput slots, in a fixed order.
	 *
	 * @param array<int,mixed> $record One record VALUE.
	 * @return list<mixed>
	 */
	private static function probe_slots( array $record ): array {
		$slots = [ Probe_Record::SOURCE, Probe_Record::CURSOR_SEGMENT, Probe_Record::CURSOR_OFF, Probe_Record::END_SEGMENT, Probe_Record::END_SIZE, Probe_Record::DISTANCE, Probe_Record::MSGS_DELTA, Probe_Record::BYTES_READ_DELTA, Probe_Record::ELAPSED_MS ];
		return \array_map( static fn ( int $slot ) => $record[ $slot ], $slots );
	}

	public function test_a_reader_id_composes_the_topology_the_reader_name_and_the_worker_partition(): void {
		$this->assertSame( 'hub-4417.firehose:spoke-9:sources:php.p3', Remote_Source_Node::reader_id( 'hub-4417', 'firehose:spoke-9', 'sources:php', 3 ) );
	}

	public function test_a_broker_bound_to_no_topology_names_no_reader(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ , $reader ] = $this->make_remote();
		$reader->poll();
		$reader->next_offset( [ 'segment' => 5, 'offset' => 2290 ] );

		$this->assertSame( '', $reader->probe_stats()[ Probe_Record::READER ], 'Topic_Probe drops a blank READER' );
	}

	public function test_a_broker_with_no_worker_partition_publishes_no_status(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		unset( Core::$var['partition'] );
		[ $node ] = $this->make_remote();
		Core::$now = 8300.0;
		$node->fire();

		for ( $p = 0; $p < 4; $p++ ) {
			$this->assertFalse( Core::$memd->get( Remote_Source_Node::status_key_for( 'remote-austin', $p ) ) );
		}
	}

	public function test_publish_status_noop_when_no_cache(): void {
		Core::$memd = null;
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );

		// Without a cache, the tick still runs cleanly — write_status short-circuits.
		$this->make_remote( 'remote-austin' );

		$this->assertInstanceOf( SSE_In_Node::class, Core::node( 'remote-austin:sse-in' ) );
	}

	public function test_connection_attempt_reflects_actual_connect_not_each_tick(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		Core::$now = 1000.0;
		[ $node ] = $this->make_remote( 'remote-austin' ); // queues the connect at t=1000
		$this->drain_connect_queue();

		// Later ticks keep firing without a reconnect (the handle persists), so
		// "Connected" must stay pinned to the real connect time — not creep with the tick clock.
		Core::$now = 1030.0;
		$node->fire();

		$this->assertSame( 1000, $this->status_of( $node )['last_connection_attempt'] );
	}

	public function test_published_status_carries_sse_heartbeat_receipt(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );

		$sse = Core::node( 'remote-austin:sse-in' );
		Core::$now = 1748960000;
		$sse->process_sse_chunk( "event: heartbeat\ndata: {}\n\n" );

		$node->fire();

		$this->assertSame( 1748960000, $this->status_of( $node )['last_sse_heartbeat'] );
	}

	// ---------------------------------------------------------------------
	// Helpers.
	// ---------------------------------------------------------------------

	/** @return array<array-key,mixed> The newest committed offsetlog frame VALUE. */
	private function newest_offsetlog_frame( Remote_Consumer_Node $node ): array {
		$offsetlog = $this->read_private( $node, 'offsetlog' );
		$this->assertInstanceOf( Partition_Node::class, $offsetlog );
		$segments = $offsetlog->get_segments( true );
		$last     = \end( $segments );
		$content  = $offsetlog->read_at( $last['id'], 0, $last['size'] );
		$lines    = \array_values( \array_filter( \explode( "\n", $content ), static fn ( $l ) => '' !== $l ) );
		return Message::unpacked( \end( $lines ) )[ Message::VALUE ];
	}

	private function count_offsetlog_records( Remote_Consumer_Node $node ): int {
		$offsetlog = $this->read_private( $node, 'offsetlog' );
		if ( ! $offsetlog instanceof Partition_Node ) {
			return 0;
		}
		$count = 0;
		foreach ( $offsetlog->get_segments( true ) as $s ) {
			foreach ( \explode( "\n", $offsetlog->read_at( $s['id'], 0, $s['size'] ) ) as $l ) {
				if ( '' !== $l ) {
					++$count;
				}
			}
		}
		return $count;
	}

	private function count_log_records( string $dir ): int {
		$count = 0;
		foreach ( (array) \glob( "{$dir}/*.log" ) as $path ) {
			foreach ( \explode( "\n", (string) \file_get_contents( (string) $path ) ) as $line ) {
				if ( '' !== $line ) {
					++$count;
				}
			}
		}
		return $count;
	}

	/** Install an SSE_In connect seam returning a real idle handle (never transferred). */
	private function stub_sse_connect(): void {
		\Newspack_Nodes\Event_Framework::$curl_dispatch = static function ( array $opts ): \CurlHandle {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
	}
}
