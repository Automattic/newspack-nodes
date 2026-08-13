<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Connect_Queue_Timer_Node;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Null_Node;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Remote_Link_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\SSE_In_Node;
use Newspack_Nodes\Vault;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Remote_Link_Node::class )]
class RemoteLinkNodeTest extends TestCase {

	/** The mounted fleet's own lock dir — where its reload watermark lands. */
	private string $fleet_lock_dir = '';

	/**
	 * Monotonic test clock. A fleet tick enqueues the housekeeping sweep, which
	 * re-reads the wall clock and so un-freezes `Core::$now` mid-call; anything
	 * that compounded off `Core::$now` would march backwards and stall both the
	 * config window and the link's per-second housekeeping latch.
	 */
	private float $clock = 0.0;

	protected function setUp(): void {
		parent::setUp();
		$this->use_base_dir( $this->make_temp_dir() );
		Core::$memd = new InMemoryMemcached();
		// arguments() arms a 1000ms TICK timer that router-hitchhikes (>=1000),
		// which needs _router present — as it always is in a live graph.
		( new Router_Node() )->name( '_router' );
		$this->clock = Core::right_now();
	}

	protected function tearDown(): void {
		Command_Auth::forget_session( 'austin' );
		Core::$memd                   = null;
		SSE_In_Node::$curl_dispatch   = null;
		HTTP_Out_Node::$curl_dispatch = null;
		// The SSE_In patrons register easy cURL handles on the process-lifetime
		// Event_Framework singleton; reset it so handles don't leak into later suites.
		Event_Framework::reset();
		Vault::get_instance()->reset_cache();
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	private function seed_vault( string $id = 'austin' ): void {
		// A spoke that can be sent to has authed; the heartbeat signs for it.
		Command_Auth::remember_session( $id, \str_repeat( 'b', 32 ), 'spoke-session-key' );
		\update_option( Vault::OPTION_KEY, [ $id => [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p', 'token' => 't' ] ] );
		Vault::get_instance()->reset_cache();
	}

	/** Install an SSE_In connect seam returning a real idle handle (never transferred). */
	private function stub_sse_connect(): void {
		SSE_In_Node::$curl_dispatch = static function ( array $opts ): \CurlHandle {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
	}

	/** Push an exact slot lease into an SSE_In via its `connected` handshake parser. */
	private function set_slot( SSE_In_Node $sse, int $slot, int $owner = 42424243 ): void {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::KEY ]   = 'connected';
		$m[ Message::VALUE ] = "PID 9007 SLOT {$slot} OWNER {$owner}";
		$sse->process_sse_chunk( "event: connected\ndata: " . Message::packed( $m ) . "\n\n" );
	}

	/** Push a terminal `disconnect` frame into an SSE_In. */
	private function disconnect_sse( SSE_In_Node $sse, string $key, string $value ): void {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_ERROR;
		$m[ Message::KEY ]   = $key;
		$m[ Message::VALUE ] = $value;
		$sse->process_sse_chunk( "event: disconnect\ndata: " . Message::packed( $m ) . "\n\n" );
	}

	/**
	 * Build a named base Remote_Link wired to a capture sink + downstream target.
	 *
	 * @param list<string> $args Positional ctor tokens.
	 */
	private function make_link( string $name = 'link-austin', array $args = [ 'austin', 'firehose.p0' ] ): array {
		$node = new Remote_Link_Node();
		$node->name( $name );
		$sink = new Capture_Sink_Node();
		$sink->name( 'downstream' );
		$node->sink( $sink );
		$node->target( 'downstream' );
		$node->arguments( $args );
		return [ $node, $sink ];
	}

	// ---------------------------------------------------------------------
	// arguments() + schema.
	// ---------------------------------------------------------------------

	public function test_arguments_parses_positional_tokens_and_arms_timer(): void {
		[ $node ] = $this->make_link();
		$this->assertSame( 'austin', $this->read_private( $node, 'vault_id' ) );
		$this->assertSame( 'firehose.p0', $this->read_private( $node, 'remote_partition' ) );
		$this->assertGreaterThan( 0, $node->interval_ms );
		$this->assertFalse( $node->oneshot );
	}

	public function test_arguments_null_returns_canonical_form(): void {
		[ $node ] = $this->make_link();
		$this->assertSame( [ 'austin', 'firehose.p0' ], $node->arguments( null ) );
	}

	public function test_node_schema_is_visible_io_not_fillable(): void {
		$schema = Remote_Link_Node::node_schema();
		$this->assertSame( 'Hidden', $schema['category'] );
		$this->assertArrayNotHasKey( 'hidden', $schema );
		$this->assertFalse( $schema['accepts_fill'] );
		$names = \array_column( $schema['arguments'], 'name' );
		$this->assertSame( [ 'vault_id', 'remote_partition' ], $names );
	}

	public function test_vault_id_arg_uses_vault_id_type(): void {
		$schema = Remote_Link_Node::node_schema();
		$this->assertSame( 'vault_id', $schema['arguments'][0]['name'] );
		$this->assertSame( 'vault_id', $schema['arguments'][0]['type'] );
	}

	// ---------------------------------------------------------------------
	// Timer cadence + patron lifecycle — ensure_patrons.
	// ---------------------------------------------------------------------

	public function test_a_cursorless_channel_asks_for_the_tail_by_name(): void {
		// The base link keeps no durable cursor — restore_position() seeds none —
		// so it must SAY it wants the tail rather than imply it by omission, which
		// is what made a real 0:0 position unaskable.
		$this->seed_vault();
		[ $node ] = $this->make_link();

		$captured = [];
		SSE_In_Node::$curl_dispatch = function ( array $opts ) use ( &$captured ): \CurlHandle {
			$captured[] = $opts;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
		$node->fire();
		$sse = Core::node( 'link-austin:sse-in' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		$this->assertTrue( $sse->maybe_connect() );

		\parse_str( (string) \parse_url( $captured[0][ \CURLOPT_URL ], PHP_URL_QUERY ), $query );
		$this->assertSame(
			Consumer_Node::SEEK_END,
			\json_decode( $query['positions'], true )['firehose.p0']
		);
	}

	public function test_tick_is_100ms_but_housekeeping_latches_to_once_per_second(): void {
		$this->seed_vault();
		$this->assertSame( 100, ( new \ReflectionClassConstant( Remote_Link_Node::class, 'TICK_INTERVAL_MS' ) )->getValue() );

		$node = new class() extends Remote_Link_Node {
			public int $housekeeping_runs = 0;
			protected function publish_status(): void {
				++$this->housekeeping_runs;
			}
		};
		$node->name( 'link-austin' );
		$sink = new Capture_Sink_Node();
		$sink->name( 'downstream' );
		$node->sink( $sink );
		$node->target( 'downstream' );
		$node->arguments( [ 'austin', 'firehose.p0' ] );

		Core::$now = 1000.0;
		$node->fire();
		$node->fire();
		$node->fire();
		$this->assertSame( 1, $node->housekeeping_runs, 'same wall-second: housekeeping once' );

		Core::$now = 1001.2;
		$node->fire();
		$this->assertSame( 2, $node->housekeeping_runs, 'next wall-second: housekeeping again' );
	}

	public function test_first_fire_creates_and_configures_patrons(): void {
		$this->seed_vault();
		[ $node, $sink ] = $this->make_link( 'link-austin' );

		$node->fire();

		$sse = Core::node( 'link-austin:sse-in' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		$this->assertSame( 'https://austin.example', $this->read_private( $sse, 'url' ) );
		$this->assertSame( 'u', $this->read_private( $sse, 'auth_username' ) );
		$this->assertSame( 'firehose.p0', $this->read_private( $sse, 'subscribe' ) );
		// SSE_In reads neither: delivery is its `on_message` seam, and THIS
		// node unpacks, stamps and fills its own sink.
		$this->assertNull( $sse->sink() );
		$this->assertSame( $sink, $node->sink() );
		$this->assertSame( 'downstream', $this->read_private( $node, 'target' ) );

		$http = Core::node( 'link-austin:http-out' );
		$this->assertInstanceOf( HTTP_Out_Node::class, $http );
		$this->assertSame( 'austin', $this->read_private( $http, 'vault_id' ) );
	}

	public function test_ensure_patrons_idempotent_returns_same_sse(): void {
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();
		$first = Core::node( 'link-austin:sse-in' );

		$node->fire();
		$this->assertSame( $first, Core::node( 'link-austin:sse-in' ) );
	}

	// ---------------------------------------------------------------------
	// RELOAD: credentials captured in the patrons are re-read, not recycled.
	// ---------------------------------------------------------------------

	/** Mount a `_fleet` this link can subscribe to, as a live worker graph has. */
	private function mount_fleet(): \Newspack_Nodes\Fleet_Node {
		$base                 = $this->make_temp_dir( 'link-fleet-' );
		$this->fleet_lock_dir = "{$base}/locks/link-lab.p0.lock.d";
		\mkdir( $this->fleet_lock_dir, 0755, true );
		$fleet = new \Newspack_Nodes\Fleet_Node();
		$fleet->name( \Newspack_Nodes\Node_Names::FLEET );
		$fleet->sink( Core::node( \Newspack_Nodes\Node_Names::ROUTER ) );
		$fleet->arguments( [ $base, $this->fleet_lock_dir ] );
		return $fleet;
	}

	/**
	 * Signal a reload the way a Vault save does — a watermark in the worker's
	 * own lock dir, consumed on the fleet's next config window. Never
	 * `notify( 'RELOAD' )` by hand: the purge and the config reset that precede
	 * the notification are the half of this path that carries the credentials.
	 */
	private function signal_reload( \Newspack_Nodes\Fleet_Node $fleet ): void {
		\Newspack_Nodes\Lock_Node::request_reload_at( $this->fleet_lock_dir );
		$this->advance( ( \Newspack_Nodes\Fleet_Node::SCAN_INTERVAL_MS / 1000 ) + 1 );
		$fleet->fire_cb();
	}

	/** Move the monotonic test clock forward and publish it as `Core::$now`. */
	private function advance( float $seconds ): void {
		$this->clock += $seconds;
		Core::$now    = $this->clock;
	}

	/** Re-credential the seeded spoke to a host distinct from the seed. */
	private function recredential( string $url ): void {
		\update_option( Vault::OPTION_KEY, [ 'austin' => [ 'url' => $url, 'auth_username' => 'u2', 'auth_password' => 'p2', 'token' => 't2' ] ] );
	}

	/** The RELOAD subscriber keys registered on the fleet, closures included. */
	private function reload_subscribers( \Newspack_Nodes\Fleet_Node $fleet ): array {
		return \array_keys( $this->read_private( $fleet, 'registrations' )['RELOAD'] ?? [] );
	}

	/** Step past the once-per-second housekeeping latch, then tick. */
	private function tick_next_second( Remote_Link_Node $node ): void {
		$this->advance( 1 );
		$node->fire();
	}

	public function test_a_reload_makes_the_link_re_read_its_vault_credentials(): void {
		$fleet = $this->mount_fleet();
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();
		$this->assertSame( 'https://austin.example', $this->read_private( Core::node( 'link-austin:sse-in' ), 'url' ) );

		$this->recredential( 'https://austin-7714.example' );
		$this->signal_reload( $fleet );
		$this->tick_next_second( $node );

		$this->assertSame( 'https://austin-7714.example', $this->read_private( Core::node( 'link-austin:sse-in' ), 'url' ) );
	}

	public function test_a_second_reload_is_still_delivered(): void {
		// The registration must survive its own delivery: notify() drops a
		// listener whose handler returns exactly false, so only a deliberate
		// "stop listening" ends the subscription — never a void handler.
		$fleet = $this->mount_fleet();
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();

		$this->recredential( 'https://austin-7714.example' );
		$this->signal_reload( $fleet );
		$this->tick_next_second( $node );
		$this->assertSame( 'https://austin-7714.example', $this->read_private( Core::node( 'link-austin:sse-in' ), 'url' ) );

		$this->recredential( 'https://austin-8135.example' );
		$this->signal_reload( $fleet );
		$this->tick_next_second( $node );

		$this->assertSame( 'https://austin-8135.example', $this->read_private( Core::node( 'link-austin:sse-in' ), 'url' ) );
	}

	public function test_a_node_that_never_subscribed_is_not_on_the_reload_list(): void {
		$fleet = $this->mount_fleet();
		$this->seed_vault();
		$this->make_link( 'link-austin' );
		$bystander = new Null_Node();
		$bystander->name( 'quiet-bystander-6612' );

		$this->assertSame( [ 'link-austin' ], $this->reload_subscribers( $fleet ), 'only vault-consuming nodes subscribe' );
	}

	public function test_remove_node_unregisters_from_reload(): void {
		// Registrations are keyed by name, so a removed node that left one
		// behind keeps a closure alive holding the dead node.
		$fleet = $this->mount_fleet();
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-shortlived-5528', [ 'austin', 'firehose.p0' ] );
		$this->assertSame( [ 'link-shortlived-5528' ], $this->reload_subscribers( $fleet ) );

		$node->remove_node();

		$this->assertSame( [], $this->reload_subscribers( $fleet ) );
	}

	public function test_normal_traffic_is_unchanged_by_subscribing(): void {
		// Control never touches fill(), so a data message wearing the event name
		// is relayed verbatim — no discrimination, nothing to get wrong.
		$fleet = $this->mount_fleet();
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );
		$this->assertSame( [ 'link-austin' ], $this->reload_subscribers( $fleet ) );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::KEY ]   = 'RELOAD';
		$m[ Message::VALUE ] = 'ledger-line-4471';
		$node->fill( $m );

		$batch = $this->read_private( Core::node( 'link-austin:http-out' ), 'batch' );
		$this->assertCount( 1, $batch );
		$this->assertSame( 'ledger-line-4471', $batch[0][ Message::VALUE ] );
		$this->assertSame( 'RELOAD', $batch[0][ Message::KEY ] );
	}

	public function test_missing_vault_entry_stays_disconnected_no_patrons(): void {
		[ $node ] = $this->make_link( 'link-ghost', [ 'ghost', 'firehose.p0' ] );

		$node->fire();

		$this->assertNull( Core::node( 'link-ghost:sse-in' ) );
		$this->assertNull( Core::node( 'link-ghost:http-out' ) );
	}

	public function test_vault_entry_without_url_stays_disconnected(): void {
		\update_option( Vault::OPTION_KEY, [ 'austin' => [ 'url' => '', 'auth_username' => 'u' ] ] );
		Vault::get_instance()->reset_cache();
		[ $node ] = $this->make_link( 'link-austin' );

		$node->fire();

		$this->assertNull( Core::node( 'link-austin:sse-in' ) );
	}

	// ---------------------------------------------------------------------
	// fill() — reply bookkeeping vs send relay.
	// ---------------------------------------------------------------------

	public function test_fill_relays_non_command_message_through_http_out(): void {
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = 'payload';
		$node->fill( $m );

		$http  = Core::node( 'link-austin:http-out' );
		$batch = $this->read_private( $http, 'batch' );
		$this->assertCount( 1, $batch );
		$this->assertSame( 'payload', $batch[0][ Message::VALUE ] );
	}

	public function test_fill_command_response_is_reply_not_relayed(): void {
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );

		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$reply[ Message::TO ]    = 'link-austin';
		$reply[ Message::VALUE ] = [
			'name'    => 'heartbeat',
			'payload' => [ 'success' => true, 'slot' => 7 ],
		];
		$node->fill( $reply );

		// A reply is RTT bookkeeping — it neither relays nor creates patrons.
		$this->assertNull( Core::node( 'link-austin:http-out' ) );
	}

	public function test_fill_command_error_is_reply_not_relayed(): void {
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );

		$reply                  = Message::new_message();
		$reply[ Message::TYPE ] = Message::TM_COMMAND | Message::TM_ERROR;
		$reply[ Message::TO ]   = 'link-austin';
		$reply[ Message::VALUE ] = [
			'name'    => 'heartbeat',
			'payload' => 'SSE slot lease not owned',
		];
		$node->fill( $reply );

		$this->assertNull( Core::node( 'link-austin:http-out' ) );
	}

	public function test_a_released_slot_is_not_logged_as_an_error(): void {
		// An idle stream ends and releases its slot; a heartbeat already in
		// flight lands on the tombstone. That race is the design working, and
		// with a 5s idle timeout against a 15s heartbeat it recurs forever.
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );
		$log = '';
		Core::set_stderr_handler(
			static function ( string $m ) use ( &$log ): void {
				$log .= $m;
			}
		);

		$node->fill( $this->heartbeat_error( 'link-austin', 'SSE slot lease not owned: slot_released' ) );

		$this->assertSame( '', $log );
	}

	public function test_a_stolen_slot_is_still_logged_as_an_error(): void {
		// The counterpart guard: silencing the benign race must not silence a
		// real eviction, which means the lease TTL expired under us.
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );
		$log = '';
		Core::set_stderr_handler(
			static function ( string $m ) use ( &$log ): void {
				$log .= $m;
			}
		);

		$node->fill( $this->heartbeat_error( 'link-austin', 'SSE slot lease not owned: pointer_owner_mismatch' ) );

		$this->assertStringContainsString( 'pointer_owner_mismatch', $log );
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

	// ---------------------------------------------------------------------
	// Heartbeat — minted as a workers.heartbeat command through HTTP_Out.
	// ---------------------------------------------------------------------

	/**
	 * Silence is not a refusal. The session is dropped when the spoke actually
	 * refuses — HTTP_Out forgets it on a 401 — never on an inference drawn from
	 * missing replies. Guessing here suspended the keepalive (it is gated on
	 * having a session), which cost the slot and then the stream.
	 */
	public function test_missing_heartbeat_replies_do_not_drop_the_session(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();
		$sse = Core::node( 'link-austin:sse-in' );
		$this->set_slot( $sse, 5 );

		// First beat goes out; no reply ever arrives.
		Core::$now = \microtime( true ) + Remote_Link_Node::HEARTBEAT_INTERVAL + 1;
		$node->fire();
		$this->assertTrue( \Newspack_Nodes\Command_Auth::has_session( 'austin' ) );

		// Past three cadences of silence, still inside the stale window (45s) so
		// the tick reaches the heartbeat instead of reconnecting.
		Core::$now += ( Remote_Link_Node::HEARTBEAT_INTERVAL * 3 ) + 1;
		$node->fire();

		$this->assertTrue(
			\Newspack_Nodes\Command_Auth::has_session( 'austin' ),
			'silence must not forget a session the spoke never refused'
		);
	}

	public function test_heartbeat_skipped_when_slot_unknown(): void {
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();

		$http = Core::node( 'link-austin:http-out' );
		$this->assertCount( 0, $this->read_private( $http, 'batch' ) );
	}

	public function test_heartbeat_skipped_when_owner_unknown_even_if_slot_is_present(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();

		$sse = Core::node( 'link-austin:sse-in' );
		$this->set_slot( $sse, 7 );
		$owner = new \ReflectionProperty( SSE_In_Node::class, 'owner' );
		$owner->setValue( $sse, null );

		Core::$now = \microtime( true ) + Remote_Link_Node::HEARTBEAT_INTERVAL + 1;
		$node->fire();

		$this->assertCount(
			0,
			$this->read_private( Core::node( 'link-austin:http-out' ), 'batch' )
		);
	}

	public function test_heartbeat_minted_with_exact_slot_and_owner(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();

		$sse = Core::node( 'link-austin:sse-in' );
		$this->set_slot( $sse, 7, 42424243 );

		// Past the heartbeat interval, under the stale timeout.
		Core::$now = \microtime( true ) + Remote_Link_Node::HEARTBEAT_INTERVAL + 1;
		$node->fire();

		$batch = $this->read_private( Core::node( 'link-austin:http-out' ), 'batch' );
		$this->assertCount( 1, $batch );
		$envelope = $batch[0];
		$this->assertSame( Message::TM_COMMAND, $envelope[ Message::TYPE ] );
		$this->assertSame( 'link-austin', $envelope[ Message::FROM ] );
		$this->assertSame( 'workers', $envelope[ Message::TO ] );
		$value = $envelope[ Message::VALUE ];
		$this->assertSame( 'heartbeat', $value['name'] );
		$this->assertSame( [ '7', '42424243' ], $value['arguments'] );
	}

	public function test_first_session_request_waits_half_the_heartbeat_interval(): void {
		// Every Remote_Source in an aggregator boots in the same tick, so the
		// session POST used to pile onto the same instant as its own SSE GET.
		// Offsetting it by half the cadence splits the boot burst in two.
		\update_option( Vault::OPTION_KEY, [ 'austin' => [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p', 'token' => 't' ] ] );
		Vault::get_instance()->reset_cache();
		$this->stub_sse_connect();
		HTTP_Out_Node::$curl_dispatch = static function ( array $opts ): \CurlHandle {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
		[ $node ] = $this->make_link( 'link-austin' );
		$start    = \microtime( true );
		Core::$now = $start;
		$node->fire();

		$sse = Core::node( 'link-austin:sse-in' );
		$this->set_slot( $sse, 7, 42424243 );
		// Both clocks start on the first tick that sees the lease.
		Core::$now = $start + 1;
		$node->fire();
		$epoch = $start + 1;

		$http_out = Core::node( 'link-austin:http-out' );
		// 6s in: distinct from 0 and from the 15s cadence — a bare `>= 0` gate
		// and an unchanged full-cadence gate both fail here.
		Core::$now = $epoch + 6;
		$node->fire();
		$this->assertFalse(
			$this->read_private( $http_out, 'auth_in_flight' ),
			'no session request before half the heartbeat interval'
		);

		// Past the floor it asks on its OWN second of the cadence (the phase that
		// stops a mass re-auth stampeding), so allow one full cadence.
		$asked = false;
		for ( $t = 7; $t <= 7 + Remote_Link_Node::HEARTBEAT_INTERVAL; $t++ ) {
			Core::$now = $epoch + $t;
			$node->fire();
			if ( true === $this->read_private( $http_out, 'auth_in_flight' ) ) {
				$asked = true;
				break;
			}
		}
		$this->assertTrue( $asked, 'the session request fires within a cadence of 7.5s' );
	}

	public function test_asking_for_a_session_does_not_move_the_heartbeat_clock(): void {
		// Spending the heartbeat cadence to ask for a session pushed the first
		// heartbeat a whole extra cadence out (22.5s, not 15s). The session
		// request rides its own clock and must not touch the heartbeat one.
		$this->stub_sse_connect();
		HTTP_Out_Node::$curl_dispatch = static function ( array $opts ): \CurlHandle {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
		\update_option( Vault::OPTION_KEY, [ 'austin' => [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p', 'token' => 't' ] ] );
		Vault::get_instance()->reset_cache();
		[ $node ] = $this->make_link( 'link-austin' );
		$start     = \microtime( true );
		Core::$now = $start;
		$node->fire();
		$this->set_slot( Core::node( 'link-austin:sse-in' ), 7, 42424243 );
		Core::$now = $start + 1;
		$node->fire();
		$epoch = $start + 1;

		// The session request goes out at the half-cadence boundary.
		Core::$now = $epoch + 7;
		$node->fire();
		// It lands, as the real /auth reply would.
		Command_Auth::remember_session( 'austin', \str_repeat( 'b', 32 ), 'spoke-session-key' );

		// 9s: well short of the 22.5s a cadence-spending ask would have forced.
		Core::$now = $epoch + 9;
		$node->fire();
		$batch = $this->read_private( Core::node( 'link-austin:http-out' ), 'batch' );
		$this->assertCount( 1, $batch, 'the heartbeat clock was never spent on asking' );
		$this->assertSame( 'heartbeat', $batch[0][ Message::VALUE ]['name'] );
	}

	public function test_two_links_connect_one_per_queue_tick_not_all_at_once(): void {
		// An aggregator brings every Remote_Source up in one tick; N simultaneous
		// SSE connects are exactly what the spoke answers with HTTP 429. Ported
		// from Tachikoma's JobSpawnTimer: one connect per timer fire.
		$connects = [];
		SSE_In_Node::$curl_dispatch = static function ( array $opts ) use ( &$connects ): \CurlHandle {
			$connects[] = $opts[ \CURLOPT_URL ];
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
		\update_option(
			Vault::OPTION_KEY,
			[
				'austin'  => [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p', 'token' => 't' ],
				'brisbane' => [ 'url' => 'https://brisbane.example', 'auth_username' => 'u', 'auth_password' => 'p', 'token' => 't' ],
			]
		);
		Vault::get_instance()->reset_cache();

		// The timer sinks into the interpreter, as every node does in a live
		// graph; without one Timer_Node::fire_cb() never reaches fire().
		( new \Newspack_Nodes\Command_Interpreter_Node() )->name( '_command_interpreter' );
		[ $one, $sink ] = $this->make_link( 'link-austin', [ 'austin', 'firehose.p0' ] );
		$two = new Remote_Link_Node();
		$two->name( 'link-brisbane' );
		$two->sink( $sink );
		$two->target( 'downstream' );
		$two->arguments( [ 'brisbane', 'firehose.p0' ] );
		$one->fire();
		$two->fire();

		$this->assertSame( [], $connects, 'both links only QUEUED their connect' );

		$timer = Core::node( Connect_Queue_Timer_Node::NODE_NAME );
		$this->assertInstanceOf( Connect_Queue_Timer_Node::class, $timer );

		// Drive fire_cb(), the real dispatch path: Timer_Node::fire_cb() returns
		// early on a null sink, BEFORE fire(), so a sinkless timer never drains
		// the queue and nothing ever connects. Calling fire() directly hides it.
		$timer->fire_cb();
		$this->assertCount( 1, $connects, 'one connect per queue tick' );
		$timer->fire_cb();
		$this->assertCount( 2, $connects, 'the second lands on the next tick' );

		// Dry queue retires the timer, exactly as JobSpawnTimer does.
		$timer->fire_cb();
		$this->assertNull( Core::node( Connect_Queue_Timer_Node::NODE_NAME ) );
	}

	public function test_a_simultaneous_session_loss_does_not_stampede_auth(): void {
		// The connect stagger only spreads FIRST boot. A spoke restart or key
		// rotation drops every session in the same instant, and every link is then
		// long past its retry gate — so all N POST /v1/auth on one tick, which is
		// the burst the whole change exists to prevent.
		$this->stub_sse_connect();
		HTTP_Out_Node::$curl_dispatch = static function ( array $opts ): \CurlHandle {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
		\update_option( Vault::OPTION_KEY, [ 'austin' => [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p', 'token' => 't' ] ] );
		Vault::get_instance()->reset_cache();
		( new \Newspack_Nodes\Command_Interpreter_Node() )->name( '_command_interpreter' );

		$links = [];
		foreach ( [ 'link-alfa', 'link-bravo', 'link-charlie', 'link-delta' ] as $name ) {
			$node = new Remote_Link_Node();
			$node->name( $name );
			$node->arguments( [ 'austin', 'firehose.p0' ] );
			$links[ $name ] = $node;
		}

		// Long-established links, every session lost at the same instant.
		$start = 100000.0;
		foreach ( $links as $node ) {
			Core::$now = $start;
			$node->fire();
			$this->drain_connect_queue();
		}
		foreach ( $links as $name => $node ) {
			Core::$now = $start + 1;
			$node->fire();
			$this->set_slot( Core::node( "{$name}:sse-in" ), 3, 42424243 );
		}

		// Walk a full cadence and record which second each link asks on.
		$asked = [];
		$floor = \intdiv( Remote_Link_Node::HEARTBEAT_INTERVAL, 2 );
		for ( $t = 2; $t <= 2 + $floor + Remote_Link_Node::HEARTBEAT_INTERVAL; $t++ ) {
			foreach ( $links as $name => $node ) {
				if ( isset( $asked[ $name ] ) ) {
					continue;
				}
				Core::$now = $start + $t;
				$node->fire();
				if ( true === $this->read_private( Core::node( "{$name}:http-out" ), 'auth_in_flight' ) ) {
					$asked[ $name ] = $t;
				}
			}
		}

		$this->assertCount( 4, $asked, 'every link still asks within one cadence' );
		$this->assertGreaterThan(
			1,
			\count( \array_unique( \array_values( $asked ) ) ),
			'the asks must not all land on one second'
		);
	}

	public function test_terminal_disconnect_retires_lease_before_blocked_reconnect_heartbeat(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		Core::$now = 1000.0;
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();

		$sse = Core::node( 'link-austin:sse-in' );
		$this->set_slot( $sse, 7, 42424243 );
		$this->disconnect_sse( $sse, 'slot_lease_lost', 'SSE slot lease lost' );

		Core::$now = 1000.0 + Remote_Link_Node::HEARTBEAT_INTERVAL + 1;
		$node->fire();

		$this->assertCount(
			0,
			$this->read_private( Core::node( 'link-austin:http-out' ), 'batch' ),
			'a terminal stream cannot heartbeat its retired lease while reconnect is blocked'
		);
		$this->assertNull( $sse->slot(), 'a terminal stream must not expose a stale slot' );
		$this->assertNull( $sse->owner(), 'a terminal stream must not expose a stale owner' );
	}

	public function test_clean_detach_retires_lease_before_failed_reconnect_heartbeat(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		Core::$now = 2000.0;
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();

		$sse = Core::node( 'link-austin:sse-in' );
		$this->set_slot( $sse, 8, 51515153 );
		$sse->disconnect();
		SSE_In_Node::$curl_dispatch = static fn ( array $opts ): bool => false;

		Core::$now = 2000.0 + Remote_Link_Node::HEARTBEAT_INTERVAL + 1;
		$node->fire();

		$this->assertCount(
			0,
			$this->read_private( Core::node( 'link-austin:http-out' ), 'batch' ),
			'a failed reconnect cannot heartbeat the detached stream lease'
		);
		$this->assertNull( $sse->slot(), 'a detached stream must not expose a stale slot' );
		$this->assertNull( $sse->owner(), 'a detached stream must not expose a stale owner' );
	}

	/**
	 * HTTP_Out's wire-inbound clause is armed only once a target is set, and the
	 * arm worth having is the refusal of a non-response the spoke addressed at
	 * our graph. The target is a Null sibling, not the link: the link's fill()
	 * relays whatever it is handed, so stamping traffic back onto it would send
	 * the spoke's own output straight back to the spoke.
	 */
	public function test_the_egress_targets_a_null_sibling(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();

		$this->assertSame(
			'link-austin:null',
			Core::node( 'link-austin:http-out' )->target()
		);
		$this->assertInstanceOf( Null_Node::class, Core::node( 'link-austin:null' ) );
	}

	public function test_the_null_sibling_is_torn_down_with_the_link(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();

		$node->remove_node();

		$this->assertNull( Core::node( 'link-austin:null' ) );
	}

	/**
	 * The heartbeat is a COMMAND the spoke's interpreter must authorize. It rode
	 * in unsigned and was authorized by the far side's HTTP_In signing on
	 * arrival — the ingress oracle. With that removed the spoke refuses it as
	 * "verification failed: bad envelope", so it must be signed at the mint,
	 * under the session established with that spoke.
	 */
	public function test_heartbeat_is_signed_for_its_spoke(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();
		$this->set_slot( Core::node( 'link-austin:sse-in' ), 5 );
		Command_Auth::remember_session( 'austin', \str_repeat( 'b', 32 ), 'heartbeat-session-key' );

		Core::$now = \microtime( true ) + Remote_Link_Node::HEARTBEAT_INTERVAL + 1;
		$node->fire();

		$batch = $this->read_private( Core::node( 'link-austin:http-out' ), 'batch' );
		$this->assertCount( 1, $batch );
		$auth = $batch[0][ Message::VALUE ]['auth'] ?? null;
		$this->assertIsArray( $auth, 'the heartbeat must carry a signature' );
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{64}$/', $auth['sig'] );
	}

	/** No session yet: hold the beat rather than send one the spoke will refuse. */
	public function test_heartbeat_is_held_until_the_spoke_session_exists(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();
		$this->set_slot( Core::node( 'link-austin:sse-in' ), 5 );
		Command_Auth::forget_session( 'austin' );

		Core::$now = \microtime( true ) + Remote_Link_Node::HEARTBEAT_INTERVAL + 1;
		$node->fire();

		$this->assertCount(
			0,
			$this->read_private( Core::node( 'link-austin:http-out' ), 'batch' )
		);
	}

	/**
	 * The skip path must spend the cadence, or the handshake loses its only
	 * backoff: `ensure_session()` would run on every housekeeping tick — one
	 * /auth per second, per link, for as long as the spoke keeps refusing.
	 * The slot ttl is three cadences, so a beat deferred by one is free.
	 */
	/** The reply leg is what keeps the session: an answered beat never expires it. */
	public function test_an_answered_heartbeat_keeps_the_session(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();
		$this->set_slot( Core::node( 'link-austin:sse-in' ), 5 );

		Core::$now = 1000 + Remote_Link_Node::HEARTBEAT_INTERVAL;
		$node->fire();

		Core::$now = Core::$now + ( Remote_Link_Node::HEARTBEAT_INTERVAL * 3 ) + 1;
		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$reply[ Message::VALUE ] = [
			'name'    => 'heartbeat',
			'payload' => [ 'success' => true, 'slot' => 5 ],
		];
		$node->fill( $reply );
		$node->fire();

		$this->assertTrue( Command_Auth::has_session( 'austin' ) );
	}

	// The dashboard status snapshot (publish_status / record_heartbeat_* / write_status)
	// is Remote_Source-only now — the base publishes nothing, so those cases live in
	// RemoteSourceNodeTest. The base still SENDS the slot-keepalive heartbeat (above).

	// ---------------------------------------------------------------------
	// connect / close.
	// ---------------------------------------------------------------------

	public function test_connect_opens_the_inbound_stream(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node ] = $this->make_link( 'link-austin' );

		$node->connect();

		$this->assertTrue( Core::node( 'link-austin:sse-in' )->connection()['connected'] );
	}

	public function test_close_disconnects_the_stream(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->connect();
		$this->assertTrue( Core::node( 'link-austin:sse-in' )->connection()['connected'] );

		$node->close();

		$this->assertFalse( Core::node( 'link-austin:sse-in' )->connection()['connected'] );
	}

	public function test_close_before_patrons_is_safe(): void {
		[ $node ] = $this->make_link( 'link-austin' );
		$node->close();
		$this->assertNull( Core::node( 'link-austin:sse-in' ) );
	}

	// ---------------------------------------------------------------------
	// connect_node — target propagation.
	// ---------------------------------------------------------------------

	public function test_connect_node_retargets_this_node_not_its_sse_child(): void {
		// The child never read a target; re-pointing it on every rewire only
		// looked like the sink/target path was live.
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();

		$node->connect_node( 'new-downstream' );

		$this->assertSame( 'new-downstream', $this->read_private( $node, 'target' ) );
		$this->assertSame( '', Core::node( 'link-austin:sse-in' )->target() );
	}

	public function test_connect_node_before_patrons_only_sets_target(): void {
		[ $node ] = $this->make_link( 'link-austin' );
		$node->connect_node( 'new-downstream' );
		$this->assertSame( 'new-downstream', $this->read_private( $node, 'target' ) );
	}

	// ---------------------------------------------------------------------
	// Composite-node stat delegation to the patrons.
	// ---------------------------------------------------------------------

	public function test_stats_default_to_zero_before_patrons(): void {
		[ $node ] = $this->make_link( 'link-austin' );
		$this->assertSame( 0, $node->bytes_read() );
		$this->assertSame( 0, $node->bytes_written() );
		$this->assertSame( 0, $node->largest_msg_sent() );
	}

	public function test_stats_delegate_to_patrons_once_built(): void {
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();
		$sse = Core::node( 'link-austin:sse-in' );

		$sse->process_sse_chunk( "event: heartbeat\ndata: {}\n\n" );
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::KEY ]   = 'k';
		$m[ Message::VALUE ] = [ 'a' => 1 ];
		$sse->process_sse_chunk( "event: msg\ndata: " . Message::packed( $m ) . "\n\n" );

		$this->assertGreaterThan( 0, $sse->bytes_read() );
		$this->assertSame( $sse->bytes_read(), $node->bytes_read() );
		$this->assertSame( $sse->counter(), $node->counter() );
		$this->assertSame( $sse->largest_msg_sent(), $node->largest_msg_sent() );
	}

	// ---------------------------------------------------------------------
	// remove_node — patron teardown.
	// ---------------------------------------------------------------------

	public function test_remove_node_tears_down_both_patrons(): void {
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();
		$this->assertInstanceOf( SSE_In_Node::class, Core::node( 'link-austin:sse-in' ) );
		$this->assertInstanceOf( HTTP_Out_Node::class, Core::node( 'link-austin:http-out' ) );

		$node->remove_node();

		$this->assertNull( Core::node( 'link-austin:sse-in' ) );
		$this->assertNull( Core::node( 'link-austin:http-out' ) );
	}

	// ---------------------------------------------------------------------
	// deliver_downstream — SSE_In's raw `msg` payload is unpacked + forwarded
	// straight downstream (the channel path; Remote_Source overrides to buffer).
	// This is the moved SSE_In forward() logic.
	// ---------------------------------------------------------------------

	public function test_delivery_seam_unpacks_and_forwards_to_target(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node, $sink ] = $this->make_link( 'link-austin' );
		$node->fire();
		$sse = Core::node( 'link-austin:sse-in' );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::ID ]    = '1:0';
		$m[ Message::KEY ]   = 'req';
		$m[ Message::VALUE ] = [ 'rid' => 'abc' ];
		$sse->process_sse_chunk( "event: msg\ndata: " . Message::packed( $m ) . "\n\n" );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( 'downstream', $sink->captured[0][ Message::TO ], 'a set target forces TO' );
		$this->assertSame( 'abc', $sink->captured[0][ Message::VALUE ]['rid'] );
	}

	public function test_delivery_seam_stamps_from_with_sse_in_patron_name(): void {
		// Parity with the retired SSE_In::forward: the breadcrumb FROM on a relayed message is the
		// SSE_In patron's name (`<link>:sse-in`), NOT the link's own name — so the spoke's TO=FROM
		// reply breadcrumb routes back through the same sibling, unchanged.
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node, $sink ] = $this->make_link( 'link-austin' );
		$node->fire();
		$sse = Core::node( 'link-austin:sse-in' );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::FROM ]  = '_output/5';
		$m[ Message::VALUE ] = [ 'x' => 1 ];
		$sse->process_sse_chunk( "event: msg\ndata: " . Message::packed( $m ) . "\n\n" );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( 'link-austin:sse-in/_output/5', $sink->captured[0][ Message::FROM ], 'FROM is prepended with the SSE_In sibling name' );
	}

	public function test_delivery_seam_preserves_message_to_when_no_target(): void {
		// An attached worker reply carries its own TO (the TO=FROM breadcrumb); with no link target
		// deliver_downstream must route by that, not overwrite it.
		$this->seed_vault();
		$this->stub_sse_connect();
		$node = new Remote_Link_Node();
		$node->name( 'link-austin' );
		$sink = new Capture_Sink_Node();
		$sink->name( 'downstream' );
		$node->sink( $sink );
		$node->arguments( [ 'austin', 'firehose.p0' ] ); // no target.
		$node->fire();
		$sse = Core::node( 'link-austin:sse-in' );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::TO ]    = '_metadata';
		$m[ Message::VALUE ] = [ 'x' => 1 ];
		$sse->process_sse_chunk( "event: msg\ndata: " . Message::packed( $m ) . "\n\n" );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( '_metadata', $sink->captured[0][ Message::TO ] );
	}

	public function test_delivery_seam_drops_over_max_from_message(): void {
		// A message whose FROM is already at MAX_FROM_SIZE overflows when stamped — deliver_downstream
		// must DROP it rather than forward an unstamped message the downstream would misroute.
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node, $sink ] = $this->make_link( 'link-austin' );
		$node->fire();
		$sse = Core::node( 'link-austin:sse-in' );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::FROM ]  = \str_repeat( 'a', \Newspack_Nodes\Node::MAX_FROM_SIZE );
		$m[ Message::VALUE ] = [ 'x' => 1 ];
		$sse->process_sse_chunk( "event: msg\ndata: " . Message::packed( $m ) . "\n\n" );

		$this->assertCount( 0, $sink->captured, 'an over-MAX_FROM_SIZE message is dropped, not forwarded' );
	}

	public function test_delivery_seam_drops_unparseable_frame(): void {
		// A torn frame handed to a channel link (which never buffers) is dropped — nothing forwarded.
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node, $sink ] = $this->make_link( 'link-austin' );
		$node->fire();
		$sse = Core::node( 'link-austin:sse-in' );

		$sse->process_sse_chunk( "event: msg\ndata: {not a message}\n\n" );

		$this->assertCount( 0, $sink->captured );
	}
}
