<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Remote_Source_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\SSE_In_Node;
use Newspack_Nodes\Vault;
use Newspack_Nodes\Worker_Should_Stop;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Downstream relay sink: records forwards, throws on a `boom`-keyed message (poison), and
 * raises Worker_Should_Stop on a `stop`-keyed one (a cooperative deadline mid-forward).
 */
class Relay_Sink_Spy extends Node {
	/** @var array<int,array<int,mixed>> */
	public array $captured = [];
	public int $fill_count = 0;

	public function fill( array $message ): void {
		++$this->fill_count;
		$key = Core::as_string( $message[ Message::KEY ] );
		if ( 'boom' === $key ) {
			throw new \RuntimeException( 'downstream boom' );
		}
		if ( 'stop' === $key ) {
			throw new Worker_Should_Stop( 'cooperative stop' );
		}
		$this->captured[] = $message;
	}
}

#[CoversClass( Remote_Source_Node::class )]
class RemoteSourceNodeTest extends TestCase {

	private string $base_dir = '';

	protected function setUp(): void {
		parent::setUp();
		$this->base_dir = $this->make_temp_dir();
		$this->use_base_dir( $this->base_dir );
		Core::$memd = new InMemoryMemcached();
		// Remote_Source arms a 1000ms TICK timer that router-hitchhikes (>=1000),
		// which needs _router present — as it always is in a live graph.
		( new Router_Node() )->name( '_router' );
	}

	protected function tearDown(): void {
		Core::$memd                = null;
		SSE_In_Node::$curl_dispatch = null;
		HTTP_Out_Node::$curl_dispatch = null;
		// The SSE_In patrons register CurlMultiHandles with the process-lifetime
		// Event_Framework singleton; reset it so handles don't leak into later suites.
		Event_Framework::reset();
		Vault::get_instance()->reset_cache();
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	private function seed_vault( string $id, array $entry ): void {
		\update_option( Vault::OPTION_KEY, [ $id => $entry ] );
		Vault::get_instance()->reset_cache();
	}

	/** Build a named Remote_Source wired to a capture sink + downstream target. */
	private function make_remote( string $name = 'remote-austin', string $args = 'austin firehose.p0' ): array {
		$node = new Remote_Source_Node();
		$node->name( $name );
		$sink = new Capture_Sink_Node();
		$sink->name( 'downstream' );
		$node->sink( $sink );
		$node->target( 'downstream' );
		$node->arguments( $args );
		return [ $node, $sink ];
	}

	// ---------------------------------------------------------------------
	// Task 4 — skeleton: args, patron creation, Vault resolution, schema.
	// ---------------------------------------------------------------------

	public function test_arguments_parses_positional_tokens(): void {
		[ $node ] = $this->make_remote();
		$this->assertSame( 'austin', $this->read_private( $node, 'vault_id' ) );
		$this->assertSame( 'firehose.p0', $this->read_private( $node, 'remote_partition' ) );
	}

	public function test_arguments_arms_recurring_timer(): void {
		[ $node ] = $this->make_remote();
		$this->assertGreaterThan( 0, $node->interval_ms );
		$this->assertFalse( $node->oneshot );
	}

	public function test_first_tick_creates_and_configures_sse_in_patron(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node, $sink ] = $this->make_remote( 'remote-austin' );

		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		$this->assertSame( 'https://austin.example', $this->read_private( $sse, 'url' ) );
		$this->assertSame( 'u', $this->read_private( $sse, 'auth_username' ) );
		$this->assertSame( 'firehose.p0', $this->read_private( $sse, 'subscribe' ) );
		// SSE_In relays the stream THROUGH the Remote_Source's own fill() (so a poison
		// message can be quarantined), keeping its downstream target.
		$this->assertSame( $node, $sse->sink() );
		$this->assertSame( 'downstream', $sse->target() );
	}

	// ---------------------------------------------------------------------
	// Poison / crash lifecycle ([42]) — Consumer-style fair-shot + crawl.
	// ---------------------------------------------------------------------

	public function test_downstream_throw_dead_letters_immediately_and_advances(): void {
		// Consumer's model (all the way down): a downstream throw dead-letters the message ON
		// SIGHT (won't-forward → never will) and the cursor advances PAST it — no head-block,
		// no fair-shot climb. A following healthy message forwards normally.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:128:44', 'boom' ); // downstream throws → dead-letter immediately.
		$this->deliver( $sse, '7:300:40', '' );     // NOT blocked: forwards. Advance-on-next → cursor pins its START.

		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 1, $this->count_log_records( $dlq ), 'poison dead-lettered on the first throw' );
		$this->assertCount( 1, $spy->captured, 'the following message is not head-blocked' );

		// A clean shutdown commits the last forwarded message's own START (advance-on-next — the
		// cursor no longer computes an exclusive end), safely PAST the earlier poison.
		$node->checkpoint_shutdown();
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 7, $frame['segment'] );
		$this->assertSame( 300, $frame['offset'] );
		$this->assertSame( 0, $frame['attempts'], 'no fair-shot climb — a clean handoff' );
	}

	public function test_caught_throw_last_message_marks_quarantine_and_reboot_drops(): void {
		// Advance-on-next + on-sight marker: a caught-throw poison pins its OWN start AND writes a
		// quarantine marker there. On an idle tail a clean recycle preserves the marker (sealed
		// position), so a respawn DROPS the re-delivered poison instead of re-quarantining it on
		// every ~10-min recycle (bounding invariant row 1's exposure to the marker-write window).
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:128:44', 'boom' ); // last message → dead-letter + marker at {7,128}, then idle.
		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 1, $this->count_log_records( $dlq ) );
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 128, $frame['offset'], 'cursor pins the poison start' );
		$this->assertTrue( $frame['quarantined'] ?? false, 'an on-sight throw writes a quarantine marker' );

		// Clean recycle preserves the marker at the sealed position (does not clobber it graceful).
		$node->checkpoint_shutdown();
		$this->assertTrue( $this->newest_offsetlog_frame( $node )['quarantined'] ?? false, 'the clean-recycle frame keeps the marker' );

		// Respawn: a fresh node restores the marker, arms DROP, and drops the re-delivered poison.
		$node->remove_node();
		$spy->remove_node();
		[ $node2, $spy2 ] = $this->make_remote_spy( 'remote-austin' );
		$node2->fire();
		$this->assertSame( 'drop', $this->read_private( $node2, 'skip_head_disposition' ), 'the marker arms DROP on reboot' );
		$sse2 = Core::node( 'remote-austin:sse-in' );
		$this->deliver( $sse2, '7:128:44', 'boom' ); // re-delivered poison → DROPPED, not re-quarantined.
		$this->assertSame( 1, $this->count_log_records( $dlq ), 'no second DLQ entry on the recycle' );
		$this->assertCount( 0, $spy2->captured, 'and not forwarded' );

		$this->deliver( $sse2, '7:200:40', '' ); // a fresh message forwards, cursor moves on.
		$this->assertCount( 1, $spy2->captured );
	}

	public function test_caught_throw_marker_preserves_a_live_crash_lineage(): void {
		// The on-sight throw marker must PRESERVE the live attempt accounting (never graceful/virgin),
		// so a caught throw during a climbing crash lineage doesn't reset the streak.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, 2, '' ); // climbing lineage: resume → attempts=3.
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$this->assertSame( 3, $this->read_private( $node, 'attempts' ) );
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:128:44', 'boom' ); // caught throw on the boot message.

		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertTrue( $frame['quarantined'] ?? false, 'the throw marker is written' );
		$this->assertSame( 3, $frame['attempts'], 'the climbing lineage is preserved, not reset to virgin' );
	}

	public function test_unparseable_tail_marks_quarantine_and_reboot_drops(): void {
		// Invariant row 2 symmetry: an unparseable frame is quarantined ON SIGHT with a marker at
		// the SSE position; a clean recycle preserves it, and a respawn DROPS the re-delivered raw
		// line at the boot 'drop' position (identified by the SSE position, not a parseable crumb).
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, 0, '' ); // boot = {7,128}; SSE_In is seeded there.
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$sse->process_sse_chunk( "event: msg\ndata: not-a-valid-message\n\n" ); // torn frame → on_poison.
		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 1, $this->count_log_records( $dlq ), 'the unparseable frame is quarantined once' );
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 128, $frame['offset'] );
		$this->assertTrue( $frame['quarantined'] ?? false, 'an unparseable frame writes a quarantine marker' );

		$node->checkpoint_shutdown();

		// Reboot: the re-delivered unparseable line is DROPPED, not re-quarantined.
		$node->remove_node();
		$spy->remove_node();
		[ $node2 ] = $this->make_remote_spy( 'remote-austin' );
		$node2->fire();
		$this->assertSame( 'drop', $this->read_private( $node2, 'skip_head_disposition' ) );
		$sse2 = Core::node( 'remote-austin:sse-in' );
		$sse2->process_sse_chunk( "event: msg\ndata: not-a-valid-message\n\n" );
		$this->assertSame( 1, $this->count_log_records( $dlq ), 'no second DLQ entry on the reboot' );
	}

	public function test_hard_crash_lineage_climbs_attempts_across_respawn(): void {
		// A hard-crash lineage (NO reason — an uncatchable death, not a caught throw) restores
		// and resumes at attempts+1: the climb that eventually reaches CRASH_MAX and crawls.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, 1, '' );

		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire(); // restore_position applies the frame → attempts+1.

		$this->assertSame( 2, $this->read_private( $node, 'attempts' ) );
	}

	public function test_transient_hard_crash_recovered_resets_streak_on_forward_progress(): void {
		// A hard-crash lineage that turns out transient (the next message forwards fine) must
		// clear its climbing streak the moment a message forwards successfully — else the next
		// unclean recycle would falsely keep climbing toward the crawl threshold.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, 1, '' ); // prior cycle's crash.

		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire(); // restore → attempts = 2 (lineage in flight).
		$this->assertSame( 2, $this->read_private( $node, 'attempts' ) );
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:128:44', '' ); // downstream healthy now → forwards successfully.

		$this->assertCount( 1, $spy->captured );
		$this->assertSame( 1, $this->read_private( $node, 'attempts' ), 'forward progress clears the streak' );
		$this->assertSame( 0, $this->newest_offsetlog_frame( $node )['attempts'], 'and commits a clean handoff frame' );
	}

	public function test_hard_crash_crawl_checkpoints_each_message_then_exits(): void {
		// A hard-crash lineage (NO reason, attempts ≥ CRASH_MAX) enters crawl: checkpoint
		// per relayed message (pins the culprit on a re-crash), attempts pinned — until a
		// full checkpoint interval of forward progress, then reset to the healthy baseline.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 0, Remote_Source_Node::CRASH_MAX_ATTEMPTS, '' );

		Core::$now = 1000.0;
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire(); // restore → crawl, attempts pinned at CRASH_MAX, crawl_started = 1000.
		$this->assertTrue( $this->read_private( $node, 'crawl' ) );
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:100:40', '' );
		$this->deliver( $sse, '7:200:40', '' );
		$this->assertSame( 2, $spy->fill_count, 'crawl still forwards each message' );
		$this->assertGreaterThanOrEqual( 2, $this->count_offsetlog_records( $node ), 'crawl checkpoints per message' );
		$this->assertSame( Remote_Source_Node::CRASH_MAX_ATTEMPTS, $this->newest_offsetlog_frame( $node )['attempts'], 'attempts pinned during crawl' );

		// A full interval elapses crash-free → the next message exits crawl to the baseline.
		Core::$now = 1000.0 + Remote_Source_Node::CHECKPOINT_INTERVAL_S + 1.0;
		$this->deliver( $sse, '7:300:40', '' );
		$this->assertFalse( $this->read_private( $node, 'crawl' ) );
		$this->assertSame( 1, $this->newest_offsetlog_frame( $node )['attempts'], 'crawl exits to the healthy baseline' );
	}

	public function test_crawl_entry_sacrifices_matching_head_to_dlq_then_forwards(): void {
		// Consumer-parity head-sacrifice: booting into a hard-crash lineage (crawl) pins the
		// boot cursor and arms a one-shot head-sacrifice. The first relayed message whose crumb
		// START matches the pin is the in-flight-at-crash suspect — dead-lettered with reason
		// 'crash' (NOT forwarded, even though it is otherwise healthy), the local cursor advances
		// PAST it (offset+length), the flag clears, and the next message forwards normally.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, Remote_Source_Node::CRASH_MAX_ATTEMPTS, '' );

		Core::$now = 1000.0;
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire(); // restore → crawl, boot pinned at {7,128}, head-sacrifice armed.
		$this->assertTrue( $this->read_private( $node, 'crawl' ) );
		$this->assertTrue( $this->read_private( $node, 'crawl_skip_head' ), 'crawl entry arms the head sacrifice' );
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:128:44', '' ); // matches the pin → sacrificed even though healthy.

		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 1, $this->count_log_records( $dlq ), 'suspect head dead-lettered' );
		$this->assertCount( 0, $spy->captured, 'suspect head is NOT forwarded downstream' );
		$this->assertFalse( $this->read_private( $node, 'crawl_skip_head' ), 'head sacrifice is one-shot' );
		// Advance-on-next: the cursor pins the sacrificed head's own START (no offset+length).
		$this->assertSame( 7, $this->read_private( $node, 'cursor_segment' ) );
		$this->assertSame( 128, $this->read_private( $node, 'cursor_offset' ), 'cursor pins the sacrificed head start' );
		// The sacrifice co-commits a quarantine marker at that start, closing the sacrifice→next-arrival
		// crash window (a re-boot in it DROPS instead of producing a second DLQ entry).
		$marker = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 128, $marker['offset'] );
		$this->assertTrue( $marker['quarantined'] ?? false, 'sacrifice writes a quarantine marker frame' );

		$this->deliver( $sse, '7:172:40', '' ); // past the pin, flag cleared → forwards normally, cursor pins 172.
		$this->assertCount( 1, $spy->captured, 'the next message forwards normally' );
		$this->assertSame( 172, $this->read_private( $node, 'cursor_offset' ), 'cursor advances to the next message start' );
		$this->assertSame( 1, $this->count_log_records( $dlq ), 'only the head was dead-lettered' );
	}

	public function test_crawl_entry_disarms_without_sacrifice_when_first_message_past_pin(): void {
		// Stale suspect: the remote GC'd the suspect's segment (or the stream resumed beyond it),
		// so the first relayed crumb START is PAST the boot pin. The suspect no longer exists —
		// disarm WITHOUT sacrificing and forward the message normally. Only an exact match sacrifices.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, Remote_Source_Node::CRASH_MAX_ATTEMPTS, '' );

		Core::$now = 1000.0;
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$this->assertTrue( $this->read_private( $node, 'crawl_skip_head' ) );
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:500:40', '' ); // start PAST the {7,128} pin → stale suspect.

		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 0, $this->count_log_records( $dlq ), 'a past-the-pin message is not sacrificed' );
		$this->assertCount( 1, $spy->captured, 'and it forwards normally' );
		$this->assertFalse( $this->read_private( $node, 'crawl_skip_head' ), 'a stale suspect disarms the head sacrifice' );
	}

	public function test_crawl_does_not_exit_while_head_sacrifice_armed(): void {
		// The crawl-exit guard mirrors Consumer: an elapsed interval must NOT exit crawl while the
		// head sacrifice is still armed, or an un-sacrificed poison re-arms the crash loop next boot.
		// Only after the suspect is sacrificed (flag cleared) may an elapsed interval exit crawl.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, Remote_Source_Node::CRASH_MAX_ATTEMPTS, '' );

		Core::$now = 1000.0;
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire(); // restore → crawl, crawl_started = 1000, head-sacrifice armed.
		$sse = Core::node( 'remote-austin:sse-in' );

		// Interval elapsed, but a message with no usable breadcrumb keeps the flag armed.
		Core::$now = 1000.0 + Remote_Source_Node::CHECKPOINT_INTERVAL_S + 1.0;
		$this->deliver( $sse, '', '' ); // null crumb → flag stays armed, cursor un-advanced.
		$this->assertTrue( $this->read_private( $node, 'crawl' ), 'does not exit crawl while the head sacrifice is armed' );

		// Now the suspect arrives and is sacrificed → flag clears → the elapsed interval exits crawl.
		$this->deliver( $sse, '7:128:44', '' );
		$this->assertFalse( $this->read_private( $node, 'crawl_skip_head' ) );
		$this->assertFalse( $this->read_private( $node, 'crawl' ), 'exits crawl after the sacrifice once the interval has elapsed' );
	}

	public function test_cooperative_stop_below_threshold_freezes_at_message_start(): void {
		// EXACTLY Consumer's fair-shot: a timeout on the BOOT message (the replay resumes at the
		// boot cursor, so the in-hand start == boot — cursor not advanced past boot) below COOP_MAX
		// records a strike at the message's OWN start with the climbing attempts/reason — no
		// quarantine — so the respawn re-pulls exactly it and climbs.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, 0, '' ); // boot = {7,128}; the stream replays the boot message there.
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire(); // restore → attempts=1, boot cursor = {7,128}.
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver_built( $sse, $this->stop_message( '7:128:44' ) ); // deadline mid-forward on the boot message.
		$node->cooperative_stop( 'timeout', false );

		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 0, $this->count_log_records( $dlq ), 'below threshold → not quarantined' );
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 7, $frame['segment'] );
		$this->assertSame( 128, $frame['offset'], 'frozen at the poison message start (offset, not offset+length)' );
		$this->assertSame( 1, $frame['attempts'] );
		$this->assertSame( 'timeout', $frame['reason'] );
		// New-hazard guard: a below-threshold strike frame must carry NO quarantine marker, or the
		// successor would silently drop a message that still had fair shots left (data loss).
		$this->assertArrayNotHasKey( 'quarantined', $frame, 'a below-threshold strike is NOT a quarantine marker' );
	}

	public function test_cooperative_stop_at_threshold_writes_quarantine_marker_at_message_start(): void {
		// At COOP_MAX the in-flight boot message is dead-lettered and the shutdown frame is a
		// quarantine MARKER at the message's own START (advance-on-next — no offset+length), at the
		// virgin baseline. The successor boots onto it, DROPS it (already in the DLQ), and advances.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, Remote_Source_Node::COOP_MAX_ATTEMPTS - 1, 'timeout' );
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire(); // restore → attempts = COOP_MAX, boot = {7,128}.
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver_built( $sse, $this->stop_message( '7:128:44' ) ); // boot message, stopped mid-forward.
		$node->cooperative_stop( 'timeout', false );

		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 1, $this->count_log_records( $dlq ), 'quarantined at COOP_MAX' );
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 7, $frame['segment'] );
		$this->assertSame( 128, $frame['offset'], 'marker at the poison message START (not offset+length)' );
		$this->assertSame( 0, $frame['attempts'], 'clean handoff at the virgin baseline' );
		$this->assertTrue( $frame['quarantined'] ?? false, 'the strike-out frame is a quarantine marker' );
	}

	public function test_cooperative_stop_clean_handoff_when_cursor_advanced(): void {
		// A stop AFTER the cursor advanced past boot is a normal recycle, not poison: clean
		// graceful handoff, no strike, no quarantine (EXACTLY Consumer).
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver_built( $sse, $this->healthy_message( '7:100:40' ) ); // forwards → cursor advances past boot.
		$this->deliver_built( $sse, $this->stop_message( '7:300:44' ) );    // a later stop.
		$node->cooperative_stop( 'timeout', false );

		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 0, $this->count_log_records( $dlq ), 'advanced cursor → no strike' );
		$this->assertCount( 1, $spy->captured );
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 300, $frame['offset'], 'graceful commit at the in-hand (stopped) message start' );
		$this->assertSame( 0, $frame['attempts'] );
		// Fair-shot absence: a routine cooperative stop is NEVER a quarantine — the successor
		// re-delivers the in-flight message (that re-delivery IS the fair shot).
		$this->assertArrayNotHasKey( 'quarantined', $frame, 'a routine cooperative stop writes no marker' );
	}

	public function test_cooperative_stop_memory_watermark_exemption_does_not_strike(): void {
		// A memory stop with the fresh baseline already near the watermark blames a leak /
		// undersized limit, NOT the in-flight message: clean handoff, no strike (EXACTLY Consumer).
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, 0, '' ); // clean prior frame → resume attempts=1, boot={7,128}.
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver_built( $sse, $this->stop_message( '7:128:44' ) ); // boot message, stopped mid-forward.
		$node->cooperative_stop( 'memory', true );

		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 0, $this->count_log_records( $dlq ), 'watermark exemption → not struck' );
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 128, $frame['offset'], 'graceful commit at the boot cursor' );
		$this->assertSame( 0, $frame['attempts'], 'clean handoff, no strike' );
	}

	public function test_advance_on_next_pins_the_in_hand_message_start(): void {
		// Advance-on-next: the cursor records the START of the message in hand (from its own crumb),
		// learned on arrival. It moves off N only when N+1 arrives and becomes the new in hand.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:100:40', '' );
		$this->assertSame( 100, $this->read_private( $node, 'cursor_offset' ), 'cursor pins message N start' );

		$this->deliver( $sse, '7:140:30', '' );
		$this->assertSame( 140, $this->read_private( $node, 'cursor_offset' ), 'cursor moves to N+1 start on its arrival' );
		$this->assertCount( 2, $spy->captured );
	}

	public function test_parse_breadcrumb_accepts_a_two_part_crumb(): void {
		// Wire-compat: after the crumb shrinks from seg:off:len to seg:off, the reader must still
		// pin the cursor from a two-part crumb (nothing reads the retired length anymore).
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:200', '' ); // two-part crumb, no length.

		$this->assertCount( 1, $spy->captured, 'a two-part crumb still forwards' );
		$this->assertSame( 7, $this->read_private( $node, 'cursor_segment' ) );
		$this->assertSame( 200, $this->read_private( $node, 'cursor_offset' ), 'cursor pins the two-part crumb start' );
	}

	public function test_boot_from_quarantine_marker_drops_head_without_second_dlq_entry(): void {
		// Booting onto a quarantine marker (graceful attempts=0 + quarantined): the head is already
		// in the DLQ, so the successor DROPS it silently (no forward, no second DLQ entry) and
		// advances off the next arrival.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, 0, '', 'remote-austin', true ); // quarantine marker at {7,128}.

		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$this->assertSame( 'drop', $this->read_private( $node, 'skip_head_disposition' ), 'a marker arms DROP' );
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:128:44', '' ); // the condemned head arrives → dropped silently.
		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 0, $this->count_log_records( $dlq ), 'the already-quarantined head is NOT re-dead-lettered' );
		$this->assertCount( 0, $spy->captured, 'and is NOT forwarded' );

		$this->deliver( $sse, '7:172:40', '' ); // the next message forwards normally.
		$this->assertCount( 1, $spy->captured );
	}

	public function test_crash_sacrifice_marker_survives_reboot_and_drops_head(): void {
		// The crash-crawl sacrifice writes a quarantine marker at the suspect's start. A reboot from
		// that marker DROPS the head instead of producing a second DLQ entry (closing the window).
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, Remote_Source_Node::CRASH_MAX_ATTEMPTS, '' );

		Core::$now = 1000.0;
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire(); // crawl, boot pinned at {7,128}, head sacrifice armed.
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->deliver( $sse, '7:128:44', '' ); // suspect sacrificed → DLQ + marker frame committed.
		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 1, $this->count_log_records( $dlq ) );

		// Reboot from the marker frame: the same suspect is DROPPED, not re-dead-lettered.
		$node->remove_node();
		$spy->remove_node();
		[ $node2, $spy2 ] = $this->make_remote_spy( 'remote-austin' );
		$node2->fire();
		$this->assertSame( 'drop', $this->read_private( $node2, 'skip_head_disposition' ), 'the marker re-arms DROP on reboot' );
		$sse2 = Core::node( 'remote-austin:sse-in' );
		$this->deliver( $sse2, '7:128:44', '' ); // re-pulled suspect → dropped.
		$this->assertSame( 1, $this->count_log_records( $dlq ), 'no duplicate DLQ entry on the reboot' );
		$this->assertCount( 0, $spy2->captured );
	}

	public function test_marker_write_order_dead_letter_precedes_the_marker_frame(): void {
		// Write order is normative: the DLQ write runs BEFORE the marker frame, so a marker never
		// falsely claims a message is quarantined that isn't yet on disk. Observed via a subclass
		// that records the state at the dead_letter call: the marker frame must NOT exist yet.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, Remote_Source_Node::CRASH_MAX_ATTEMPTS, '' );

		Core::$now = 1000.0;
		$node = new class() extends Remote_Source_Node {
			public bool $marker_present_at_dead_letter = true;
			protected function dead_letter( array $message, string $reason, ?\Throwable $error = null ): void {
				$frames = $this->offsetlog?->get_segments( true ) ?? [];
				$marker = false;
				foreach ( $frames as $s ) {
					foreach ( \explode( "\n", (string) $this->offsetlog?->read_at( $s['id'], 0, $s['size'] ) ) as $l ) {
						if ( '' !== $l && ( Message::unpacked( $l )[ Message::VALUE ]['quarantined'] ?? false ) ) {
							$marker = true;
						}
					}
				}
				$this->marker_present_at_dead_letter = $marker;
				parent::dead_letter( $message, $reason, $error );
			}
		};
		$node->name( 'remote-austin' );
		$spy = new Relay_Sink_Spy();
		$spy->name( 'downstream' );
		$node->sink( $spy );
		$node->target( 'downstream' );
		$node->arguments( 'austin firehose.p0' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:128:44', '' ); // sacrifice: dead_letter first, then the marker frame.

		$this->assertFalse( $node->marker_present_at_dead_letter, 'no marker frame exists yet when dead_letter runs' );
		$marker = $this->newest_offsetlog_frame( $node );
		$this->assertTrue( $marker['quarantined'] ?? false, 'the marker frame is written after the DLQ entry' );
	}

	public function test_relay_with_null_sink_fails_loud(): void {
		// Bug D: a null/unwired downstream must FAIL LOUD — never silently no-op while the
		// stream is consumed (which would advance the cursor past undelivered messages).
		$node = new Remote_Source_Node();
		$node->name( 'remote-austin' );
		$node->arguments( 'austin firehose.p0' ); // no sink wired.

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::ID ]    = '7:1:20';
		$m[ Message::VALUE ] = [ 'p' => 1 ];

		$this->expectException( \RuntimeException::class );
		$node->fill( $m );
	}

	public function test_stream_data_routed_by_type_not_from_prefix(): void {
		// Bug A(ii): the relay discriminator is structural (by TYPE), not a FROM-prefix
		// match. A TM_STRUCT whose FROM does NOT match the SSE_In name is still relayed
		// downstream — never misrouted to the outbound send()/HTTP_Out path.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$http = Core::node( 'remote-austin:http-out' );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::FROM ]  = 'some-unrelated-node';
		$m[ Message::ID ]    = '7:1:20';
		$m[ Message::VALUE ] = [ 'p' => 1 ];
		$node->fill( $m );

		$this->assertCount( 1, $spy->captured, 'stream data is relayed by TYPE regardless of FROM' );
		$this->assertCount( 0, $this->read_private( $http, 'batch' ), 'stream data must NOT be misrouted to HTTP_Out' );
	}

	public function test_checkpoint_shutdown_commits_healthy_cursor(): void {
		// Bug C: Remote_Source isn't a Consumer, so the worker's
		// checkpoint_durable_consumers() must commit its live cursor at shutdown — else
		// healthy progress is lost on every ~10-min recycle. The committed cursor is the
		// node-owned after-forward boundary (a forwarded message's END).
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->deliver( $sse, '9:512:40', '' ); // healthy forward → node cursor pins the message START.

		$node->checkpoint_shutdown();

		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 9, $frame['segment'] );
		$this->assertSame( 512, $frame['offset'] );
		$this->assertSame( 0, $frame['attempts'], 'a healthy shutdown is a clean handoff (attempts=0)' );
	}

	public function test_durable_cursor_is_node_owned_not_sse_in_position(): void {
		// Remote_Source owns cursor_segment/off, advanced AFTER a successful forward from the
		// message's OWN breadcrumb (offset+length) — never SSE_In's connection position, which
		// advances eagerly and can lead an in-flight message. Prove independence: forward one
		// healthy message, then shove SSE_In's position far ahead, then commit at shutdown —
		// the frame must record the forwarded boundary, not SSE_In's lead.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:300:40', '' ); // healthy forward → node cursor pins the message START.
		$sse->restore_position( 9, 99999 );      // desync SSE_In's connection cursor far ahead.

		$node->checkpoint_shutdown();

		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 7, $frame['segment'], 'committed the node-owned cursor, not SSE_In lead' );
		$this->assertSame( 300, $frame['offset'] );
	}

	/** Build a named Remote_Source wired to a Relay_Sink_Spy downstream + target. */
	private function make_remote_spy( string $name = 'remote-austin', string $args = 'austin firehose.p0' ): array {
		$node = new Remote_Source_Node();
		$node->name( $name );
		$spy = new Relay_Sink_Spy();
		$spy->name( 'downstream' );
		$node->sink( $spy );
		$node->target( 'downstream' );
		$node->arguments( $args );
		return [ $node, $spy ];
	}

	/** Push one TM_STRUCT stream message through the SSE_In parser (keyed `boom` to poison the relay). */
	private function deliver( SSE_In_Node $sse, string $id, string $key = '', array $value = [ 'p' => 1 ] ): void {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::ID ]    = $id;
		$m[ Message::KEY ]   = $key;
		$m[ Message::VALUE ] = $value;
		$sse->process_sse_chunk( "event: msg\ndata: " . Message::packed( $m ) . "\n\n" );
	}

	/** Deliver a pre-built message, swallowing the Worker_Should_Stop a `stop`-keyed one raises. */
	private function deliver_built( SSE_In_Node $sse, array $m ): void {
		try {
			$sse->process_sse_chunk( "event: msg\ndata: " . Message::packed( $m ) . "\n\n" );
		} catch ( Worker_Should_Stop $e ) {
			// Expected for a `stop`-keyed message: it propagates up like the real drain loop; the
			// worker then routes to cooperative_stop.
		}
	}

	/** A TM_STRUCT stream message keyed `stop` (downstream raises Worker_Should_Stop on it). */
	private function stop_message( string $id ): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::ID ]    = $id;
		$m[ Message::KEY ]   = 'stop';
		$m[ Message::VALUE ] = [ 'p' => 1 ];
		return $m;
	}

	/** A healthy TM_STRUCT stream message (forwards cleanly). */
	private function healthy_message( string $id ): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::ID ]    = $id;
		$m[ Message::KEY ]   = '';
		$m[ Message::VALUE ] = [ 'p' => 1 ];
		return $m;
	}

	/** Write a single committed offsetlog frame (with attempt accounting) for the default remote node. */
	private function seed_offsetlog_frame( int $segment, int $offset, int $attempts, string $reason, string $name = 'remote-austin', bool $quarantined = false ): void {
		$dir = \Newspack_Nodes\Config::get_offsets_directory() . "/{$name}.firehose.p0";
		if ( ! \is_dir( $dir ) ) {
			\mkdir( $dir, 0755, true );
		}
		$value = [ 'segment' => $segment, 'offset' => $offset, 'attempts' => $attempts, 'reason' => $reason, 'first_crash_ts' => null, '_ts' => 1 ];
		if ( $quarantined ) {
			$value['quarantined'] = true;
		}
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::VALUE ] = $value;
		\file_put_contents( "{$dir}/0.log", Message::packed( $m ) . "\n" );
	}

	/** @return array<array-key,mixed> The newest committed offsetlog frame VALUE. */
	private function newest_offsetlog_frame( Remote_Source_Node $node ): array {
		$offsetlog = $this->read_private( $node, 'offsetlog' );
		$this->assertInstanceOf( Partition_Node::class, $offsetlog );
		$segments = $offsetlog->get_segments( true );
		$last     = \end( $segments );
		$content  = $offsetlog->read_at( $last['id'], 0, $last['size'] );
		$lines    = \array_values( \array_filter( \explode( "\n", $content ), static fn ( $l ) => '' !== $l ) );
		return Message::unpacked( \end( $lines ) )[ Message::VALUE ];
	}

	private function count_offsetlog_records( Remote_Source_Node $node ): int {
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

	public function test_first_tick_creates_http_out_patron(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );

		$node->fire();

		$http = Core::node( 'remote-austin:http-out' );
		$this->assertInstanceOf( HTTP_Out_Node::class, $http );
		$this->assertSame( 'austin', $this->read_private( $http, 'vault_id' ) );
	}

	public function test_delegates_counter_bytes_read_largest_msg_to_its_sse_in(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$sse->process_sse_chunk( "event: heartbeat\ndata: {}\n\n" );
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::KEY ]   = 'k';
		$m[ Message::VALUE ] = [ 'a' => 1 ];
		$sse->process_sse_chunk( "event: msg\ndata: " . Message::packed( $m ) . "\n\n" );

		// The aggregator's Remote_Source reports the stream stats of its SSE_In
		// child, not its own (which never reads the wire).
		$this->assertGreaterThan( 0, $sse->bytes_read() );
		$this->assertSame( $sse->bytes_read(), $node->bytes_read() );
		$this->assertSame( $sse->counter(), $node->counter() );
		$this->assertSame( $sse->largest_msg_sent(), $node->largest_msg_sent() );
	}

	public function test_missing_vault_entry_stays_disconnected_no_patrons(): void {
		[ $node ] = $this->make_remote( 'remote-ghost', 'ghost firehose.p0' );

		$node->fire();

		$this->assertNull( Core::node( 'remote-ghost:sse-in' ) );
		$this->assertNull( Core::node( 'remote-ghost:http-out' ) );
	}

	public function test_remove_node_tears_down_patrons_and_offsetlog(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();
		$this->assertInstanceOf( SSE_In_Node::class, Core::node( 'remote-austin:sse-in' ) );
		$this->assertInstanceOf( HTTP_Out_Node::class, Core::node( 'remote-austin:http-out' ) );

		$node->remove_node();

		$this->assertNull( Core::node( 'remote-austin:sse-in' ) );
		$this->assertNull( Core::node( 'remote-austin:http-out' ) );
		$this->assertNull( Core::node( 'remote-austin:firehose.p0:offsetlog' ) );
	}

	public function test_node_schema_visible_io_with_args(): void {
		$schema = Remote_Source_Node::node_schema();
		$this->assertSame( 'I/O', $schema['category'] );
		$this->assertArrayNotHasKey( 'hidden', $schema );
		$names = \array_column( $schema['arguments'], 'name' );
		$this->assertSame( [ 'vault_id', 'remote_partition' ], $names );
	}

	// ---------------------------------------------------------------------
	// Task 5 — self-sufficiency: offsetlog, tick, heartbeat, status.
	// ---------------------------------------------------------------------

	public function test_committed_offsetlog_restored_into_sse_in_before_connect(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );

		// Pre-seed the per-node offsetlog with a committed {seg,off} line.
		$offsets_dir = \Newspack_Nodes\Config::get_offsets_directory();
		$dir         = "{$offsets_dir}/remote-austin.firehose.p0";
		\mkdir( $dir, 0755, true );
		$pre = new Partition_Node();
		$pre->name( 'preseed:offsetlog' );
		$pre->arguments( $dir );
		$entry                       = Message::new_message();
		$entry[ Message::TYPE ]      = Message::TM_STRUCT;
		$entry[ Message::VALUE ]     = [ 'segment' => 4, 'offset' => 256, '_ts' => 123 ];
		$pre->fill( $entry );
		$pre->flush();

		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		$this->assertSame( [ 'segment' => 4, 'offset' => 256 ], $sse->position() );
	}

	public function test_fire_commits_node_cursor(): void {
		// The throttled per-tick persist_cursor commits the node-owned after-forward cursor
		// (a forwarded message's END), not SSE_In's connection position.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->deliver( $sse, '7:99:40', '' ); // healthy forward → node cursor pins the message START.

		// Advance clock past the commit interval and tick again.
		Core::$now = \microtime( true ) + 100;
		$node->fire();

		$value = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 7, $value['segment'] );
		$this->assertSame( 99, $value['offset'] );
	}

	public function test_persist_cursor_does_not_recommit_an_unchanged_position(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->deliver( $sse, '5:5:40', '' ); // healthy forward advances the node cursor.
		Core::$now = \microtime( true ) + 100;
		$node->fire(); // commits the moved cursor
		$baseline = $this->count_offsetlog_records( $node );
		$this->assertGreaterThanOrEqual( 1, $baseline, 'a moved cursor is committed' );

		// Idle stream: no new message, the node cursor is unchanged, another interval elapses.
		Core::$now = \microtime( true ) + 200;
		$node->fire();
		$this->assertSame( $baseline, $this->count_offsetlog_records( $node ), 'an unchanged node cursor must not spam a duplicate keyframe (advance-guard, matching Consumer)' );
	}

	public function test_heartbeat_skipped_when_slot_unknown(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();

		$http = Core::node( 'remote-austin:http-out' );
		$this->assertCount( 0, $this->read_private( $http, 'batch' ) );
	}

	public function test_heartbeat_command_filled_into_http_out_when_slot_known(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();

		// Give the SSE_In a slot via the connected handshake.
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->set_slot( $sse, 5 );

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
		// args: <slot> <ttl> — ttl must outlive the heartbeat interval.
		[ $slot, $ttl ] = \explode( ' ', $value['arguments'] );
		$this->assertSame( '5', $slot );
		$this->assertGreaterThan( Remote_Source_Node::HEARTBEAT_INTERVAL, (int) $ttl );
	}

	public function test_heartbeat_reply_into_fill_records_rtt_and_response(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->set_slot( $sse, 5 );
		Core::$now = \microtime( true ) + 16;
		$node->fire(); // sends heartbeat, records send-time

		// Simulate the spoke's heartbeat reply routed back into fill(). The spoke's
		// interpreter wraps a command response as TM_COMMAND|TM_RESPONSE; fill()
		// records the RTT for that type and relays anything else to HTTP_Out.
		$reply                  = Message::new_message();
		$reply[ Message::TYPE ] = Message::TM_COMMAND | Message::TM_RESPONSE;
		$reply[ Message::TO ]   = 'remote-austin';
		$reply[ Message::VALUE ] = [ 'success' => true ];
		$node->fill( $reply );

		$status = Core::$memd->get( 'np:remote:remote-austin:firehose.p0' );
		$this->assertIsArray( $status );
		$this->assertArrayHasKey( 'last_heartbeat_response', $status );
		$this->assertArrayHasKey( 'last_heartbeat_rtt', $status );
		$this->assertNotNull( $status['last_heartbeat_response'] );
	}

	public function test_publish_status_ages_out_stale_heartbeat_response(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->set_slot( $sse, 5 );

		Core::$now = 1000.0;
		$node->fire(); // mints the heartbeat (records send-time)
		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$reply[ Message::TO ]    = 'remote-austin';
		$reply[ Message::VALUE ] = [ 'success' => true ];
		$node->fill( $reply ); // records last_heartbeat_response at t=1000

		// A tick right after the reply keeps the fresh response in the snapshot.
		$node->fire();
		$this->assertNotNull(
			Core::$memd->get( 'np:remote:remote-austin:firehose.p0' )['last_heartbeat_response']
		);

		// No further reply; advance past the HEARTBEAT_INTERVAL*4 staleness window.
		// The Status badge must not latch 'success' on a stale timestamp, so the
		// snapshot ages the response out to null (mirrors the old clear-on-disconnect).
		Core::$now = 1000.0 + ( Remote_Source_Node::HEARTBEAT_INTERVAL * 4 ) + 5;
		$node->fire();
		$status = Core::$memd->get( 'np:remote:remote-austin:firehose.p0' );
		$this->assertNull( $status['last_heartbeat_response'] );
		$this->assertNull( $status['last_heartbeat_rtt'] );
	}

	public function test_tick_publishes_status_snapshot(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );

		$node->fire();

		$status = Core::$memd->get( 'np:remote:remote-austin:firehose.p0' );
		$this->assertIsArray( $status );
		$this->assertArrayHasKey( 'connected', $status );
		$this->assertArrayHasKey( 'current_backoff', $status );
		$this->assertArrayHasKey( 'last_connection_attempt', $status );
		$this->assertArrayHasKey( 'last_sse_heartbeat', $status );
	}

	public function test_publish_status_noop_when_no_cache(): void {
		Core::$memd = null;
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );

		// Without a cache, the tick still runs cleanly — write_status short-circuits.
		$node->fire();

		$this->assertInstanceOf( SSE_In_Node::class, Core::node( 'remote-austin:sse-in' ) );
	}

	public function test_connection_attempt_reflects_actual_connect_not_each_tick(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );

		Core::$now = 1000.0;
		$node->fire(); // opens the connection at t=1000

		// Later ticks keep firing without a reconnect (the handle persists), so
		// "Connected" must stay pinned to the real connect time — not creep with the tick clock.
		Core::$now = 1030.0;
		$node->fire();

		$status = Core::$memd->get( 'np:remote:remote-austin:firehose.p0' );
		$this->assertSame( 1000, $status['last_connection_attempt'] );
	}

	public function test_published_status_carries_sse_heartbeat_receipt(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		Core::$now = 1748960000;
		$sse->process_sse_chunk( "event: heartbeat\ndata: {}\n\n" );

		$node->fire();

		$status = Core::$memd->get( 'np:remote:remote-austin:firehose.p0' );
		$this->assertSame( 1748960000, $status['last_sse_heartbeat'] );
	}

	public function test_restore_position_ignores_unparseable_offsetlog_entry(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->seed_offsetlog_file( "this is not a packed message\n" );

		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();

		// A junk line can't be unpacked → restore yields nothing → default cursor.
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertSame( [ 'segment' => 0, 'offset' => 0 ], $sse->position() );
	}

	public function test_restore_position_ignores_non_array_value(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = 'scalar-not-a-cursor';
		$this->seed_offsetlog_file( Message::packed( $message ) . "\n" );

		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertSame( [ 'segment' => 0, 'offset' => 0 ], $sse->position() );
	}

	public function test_restore_position_falls_back_to_prior_segment_when_last_empty(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = [ 'segment' => 4, 'offset' => 256, '_ts' => 1 ];
		// Last segment is empty (a rotated-but-unwritten tail); the committed cursor
		// lives in the prior segment and restore must fall back to it.
		$this->seed_offsetlog_file( Message::packed( $message ) . "\n", 0 );
		$this->seed_offsetlog_file( '', 1 );

		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertSame( [ 'segment' => 4, 'offset' => 256 ], $sse->position() );
	}

	public function test_restore_position_returns_empty_when_all_segments_empty(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		// Both the tail and the prior segment are empty — nothing to restore.
		$this->seed_offsetlog_file( '', 0 );
		$this->seed_offsetlog_file( '', 1 );

		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertSame( [ 'segment' => 0, 'offset' => 0 ], $sse->position() );
	}

	/** Write a raw offsetlog segment file (`<seg>.log`) for the default remote node. */
	private function seed_offsetlog_file( string $contents, int $segment_id = 0 ): void {
		$dir = \Newspack_Nodes\Config::get_offsets_directory() . '/remote-austin.firehose.p0';
		if ( ! \is_dir( $dir ) ) {
			\mkdir( $dir, 0755, true );
		}
		\file_put_contents( "{$dir}/{$segment_id}.log", $contents );
	}

	/** Install an SSE_In connect seam returning a real idle handle (never transferred). */
	private function stub_sse_connect(): void {
		SSE_In_Node::$curl_dispatch = static function ( \CurlMultiHandle $multi, array $opts ): \CurlHandle {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
	}

	/** Push a slot into an SSE_In via its `connected` handshake parser. */
	private function set_slot( SSE_In_Node $sse, int $slot ): void {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::ID ]    = '';
		$m[ Message::KEY ]   = 'connected';
		$m[ Message::VALUE ] = "PID 1 SLOT {$slot}";
		$sse->process_sse_chunk( "event: msg\ndata: " . Message::packed( $m ) . "\n\n" );
	}
}
