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

	public function fill( array &$message ): void {
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
		$this->deliver( $sse, '7:300:40', '' );     // NOT blocked: forwards.

		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 1, $this->count_log_records( $dlq ), 'poison dead-lettered on the first throw' );
		$this->assertCount( 1, $spy->captured, 'the following message is not head-blocked' );

		// A clean shutdown commits past-the-poison at the healthy message's next boundary (offset+length).
		$node->checkpoint_shutdown();
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 7, $frame['segment'] );
		$this->assertSame( 300 + 40, $frame['offset'] );
		$this->assertSame( 0, $frame['attempts'], 'no fair-shot climb — a clean handoff' );
	}

	public function test_quarantined_poison_committed_past_on_clean_recycle_not_requarantined(): void {
		// Consumer's model: a throw dead-letters + advances the cursor in memory; the commit
		// is throttled/at-shutdown (not immediate). A CLEAN recycle (checkpoint_shutdown)
		// commits past-the-poison, so a respawn resumes AFTER it — no re-pull, no duplicate
		// DLQ, even when the poison is the last message and the stream then goes idle.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:128:44', 'boom' ); // last message → dead-letter, advance in memory, then idle.
		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 1, $this->count_log_records( $dlq ) );

		// Clean recycle commits the advanced (past-the-poison) cursor: the poison's exclusive
		// next-read = offset + length.
		$node->checkpoint_shutdown();
		$past = 128 + 44;
		$this->assertSame( $past, $this->newest_offsetlog_frame( $node )['offset'], 'clean recycle commits past the poison' );

		// Respawn: a fresh node restores from the committed (past-the-poison) frame; the idle
		// stream would only replay from there, so the poison is never re-pulled/re-quarantined.
		$node->remove_node();
		$spy->remove_node();
		[ $node2, $spy2 ] = $this->make_remote_spy( 'remote-austin' );
		$node2->fire();
		$sse2 = Core::node( 'remote-austin:sse-in' );
		$this->assertSame( [ 'segment' => 7, 'offset' => $past ], $sse2->position(), 'respawn resumes PAST the quarantined poison' );
		$this->assertSame( 1, $this->count_log_records( $dlq ), 'poison not re-quarantined on respawn' );
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

	public function test_cooperative_stop_below_threshold_freezes_at_message_start(): void {
		// EXACTLY Consumer's fair-shot: a timeout on the BOOT message (cursor never advanced this
		// lifetime) below COOP_MAX records a strike at the message's OWN start with the climbing
		// attempts/reason — no quarantine — so the respawn re-pulls exactly it and climbs.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire(); // fresh → attempts=1, boot cursor established.
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
	}

	public function test_cooperative_stop_at_threshold_quarantines_and_advances(): void {
		// At COOP_MAX the in-flight boot message is dead-lettered and the committed cursor
		// advances PAST it (its exclusive next-read), handing off at the virgin baseline.
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
		$this->assertSame( 128 + 44, $frame['offset'], 'advanced PAST the poison (offset + length)' );
		$this->assertSame( 0, $frame['attempts'], 'clean handoff at the virgin baseline' );
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
		$this->assertSame( 100 + 40, $frame['offset'], 'graceful commit at the last forwarded boundary' );
		$this->assertSame( 0, $frame['attempts'] );
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
		$this->deliver( $sse, '9:512:40', '' ); // healthy forward → node cursor = 512 + 40.

		$node->checkpoint_shutdown();

		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 9, $frame['segment'] );
		$this->assertSame( 512 + 40, $frame['offset'] );
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

		$this->deliver( $sse, '7:300:40', '' ); // healthy forward → node cursor = 300 + 40.
		$sse->restore_position( 9, 99999 );      // desync SSE_In's connection cursor far ahead.

		$node->checkpoint_shutdown();

		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 7, $frame['segment'], 'committed the forwarded boundary, not SSE_In lead' );
		$this->assertSame( 300 + 40, $frame['offset'] );
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
	private function seed_offsetlog_frame( int $segment, int $offset, int $attempts, string $reason, string $name = 'remote-austin' ): void {
		$dir = \Newspack_Nodes\Config::get_offsets_directory() . "/{$name}.firehose.p0";
		if ( ! \is_dir( $dir ) ) {
			\mkdir( $dir, 0755, true );
		}
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::VALUE ] = [ 'segment' => $segment, 'offset' => $offset, 'attempts' => $attempts, 'reason' => $reason, 'first_crash_ts' => null, '_ts' => 1 ];
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
		$this->deliver( $sse, '7:99:40', '' ); // healthy forward → node cursor = 99 + 40.

		// Advance clock past the commit interval and tick again.
		Core::$now = \microtime( true ) + 100;
		$node->fire();

		$value = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 7, $value['segment'] );
		$this->assertSame( 99 + 40, $value['offset'] );
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
