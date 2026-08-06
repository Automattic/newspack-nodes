<?php
/**
 * Integration coverage for the M5-cutover SSE controller's drain loop.
 *
 * Task 18 — the route registration, CSV splitter, and subscription
 * resolver are covered by the Task-17 unit suite. This file exercises
 * the drain-loop body itself: `connected` envelope, then per-line
 * forwarding from log-partition Consumers wired into the SSE-process
 * substrate graph (Router + HTTP_Filter + Callback sink).
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Integration;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\Medium;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Config;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Rest\SSE_Out_Node;
use Newspack_Nodes\SSE_Slot_Pool;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( SSE_Out_Node::class )]
#[Medium]
class SSEOutTest extends TestCase {

	/** Restore the declared pool geometry; the reopen test narrows it to one slot. */
	protected function tearDown(): void {
		$declared                 = ( new \ReflectionClass( SSE_Slot_Pool::class ) )->getDefaultProperties();
		SSE_Slot_Pool::$max_slots = $declared['max_slots'];
		SSE_Slot_Pool::$ttl       = $declared['ttl'];
		Core::$memd               = null;
		parent::tearDown();
	}

	public function test_fill_emits_msg_event_and_increments_counter(): void {
		// SSE_Out is double-duty: as a Node, fill() emits the Message as a
		// single `msg` SSE event and bumps the counter (the egress writer
		// HTTP_Filter sinks into).
		$ctrl                  = new SSE_Out_Node();
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::TO ]    = '_output';
		$message[ Message::VALUE ] = 'hello';

		\ob_start();
		$ctrl->fill( $message );
		$out = \ob_get_clean();

		$this->assertSame( 1, $ctrl->counter() );
		$events = $this->split_sse_events( $out );
		$this->assertCount( 1, $events );
		$this->assertSame( 'msg', $events[0]['event'] );
		$decoded = \json_decode( $events[0]['data'], true );
		$this->assertSame( 'hello', $decoded[ Message::VALUE ] );
		$this->assertSame( '_output', $decoded[ Message::TO ] );
	}

	public function test_stream_emits_connected_then_msg_for_each_log_line(): void {
		$base = $this->make_temp_dir( 'msg-stream-int-' );
		\mkdir( "{$base}/logs/firehose.p0", 0755, true );

		// Pre-populate the firehose log with two TM_BYTESTREAM lines so the
		// Consumer has something to drain. Use Partition::fill directly with
		// a constructed Message (matches how Partition writes data on disk).
		// Flat layout: the bare-name `firehose` subscription fans out to the
		// concrete `firehose.p0` dir.
		$p = new Partition_Node();
		$p->arguments( [ "{$base}/logs/firehose.p0" ] );
		$line1 = Message::new_message();
		$line1[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$line1[ Message::VALUE ] = "line-one\n";
		$p->fill( $line1 );
		$line2 = Message::new_message();
		$line2[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$line2[ Message::VALUE ] = "line-two\n";
		$p->fill( $line2 );
		$p->flush();

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $base );
		SSE_Out_Node::$check_slot = $this->boundedTicks( 20 );

		\ob_start();
		// Positions are a flat map keyed by the OPAQUE concrete-partition dir
		// name (`open_subscription` seeds `$positions[$dir]`). 'start' is a magic
		// value `Consumer::next_offset` accepts (cursor → seg 0 / off 0). Without
		// this, the Consumer tail-seeks via 'end' and the two pre-populated lines
		// never reach the SSE output — the test passes without exercising line
		// forwarding.
		$ctrl->run_stream_loop( [ 'firehose.*' ], [ 'firehose.p0' => 'start' ], 500 );
		$out = \ob_get_clean();

		$events = $this->split_sse_events( $out );
		// connected + line-one + line-two = at least 3 events.
		$this->assertGreaterThanOrEqual( 3, \count( $events ) );

		// First event should be the `connected` handshake — now its own event type.
		$this->assertSame( 'connected', $events[0]['event'] );
		$first = \json_decode( $events[0]['data'], true );
		$this->assertSame( 'connected', $first[ Message::KEY ] );
		// The connected envelope is a flat `KEY VALUE` string (TM_INFO values are
		// strings), not an array — it carries the PID token.
		$this->assertStringContainsString( 'PID ', $first[ Message::VALUE ] );

		// Subsequent events carry the line-one / line-two VALUEs. Each
		// TM_BYTESTREAM message the Consumer emits gets JSON-encoded into
		// a single SSE `msg` event.
		$values = [];
		foreach ( \array_slice( $events, 1 ) as $ev ) {
			$decoded = \json_decode( $ev['data'], true );
			if ( \is_array( $decoded ) && isset( $decoded[ Message::VALUE ] ) ) {
				$values[] = $decoded[ Message::VALUE ];
			}
		}
		$this->assertContains( "line-one\n", $values );
		$this->assertContains( "line-two\n", $values );

		$this->rmdir_recursive( $base );
	}

	public function test_multi_partition_subscription_does_not_collide_on_consumer_name(): void {
		// A multi-partition log subscription resolves to ONE Consumer per
		// partition; they must get DISTINCT node names. Naming them all `$sub`
		// hits Node::name()'s duplicate-name throw and fatals the whole stream
		// (`node name collision: gyroscope already registered`). The partition the
		// dashboard reads rides the stamp/FROM, not the node name.
		$base = $this->make_temp_dir( 'msg-stream-multi-' );
		\mkdir( "{$base}/logs/gyroscope.p0", 0755, true );
		\mkdir( "{$base}/logs/gyroscope.p1", 0755, true );

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $base );
		SSE_Out_Node::$check_slot = $this->boundedTicks( 2 );

		\ob_start();
		// Two partitions → two Consumers. With the bug this throws before the
		// drain; fixed, it streams to completion and emits the connected envelope.
		$ctrl->run_stream_loop( [ 'gyroscope.*' ], null, 500 );
		$out = \ob_get_clean();

		$events = $this->split_sse_events( $out );
		$this->assertNotEmpty( $events );
		$first = \json_decode( $events[0]['data'], true );
		$this->assertSame( 'connected', $first[ Message::KEY ] );

		$this->rmdir_recursive( $base );
	}

	/**
	 * The stream MUST emit flush padding (a FLUSH_SIZE-byte SSE comment) so
	 * payloads are pushed through fastcgi/nginx buffers rather than sitting
	 * buffered — without it, opening the stream URL shows nothing until ~4KB
	 * of real data accumulates. flush_if_needed() must run in the drain loop.
	 */
	public function test_stream_flushes_buffers_with_padding(): void {
		$base = $this->make_temp_dir( 'msg-stream-flush-' );
		\mkdir( "{$base}/logs/firehose.p0", 0755, true );

		$p = new Partition_Node();

		$p->arguments( [ "{$base}/logs/firehose.p0" ] );
		$line = Message::new_message();
		$line[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$line[ Message::VALUE ] = "payload\n";
		$p->fill( $line );
		$p->flush();

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $base );
		SSE_Out_Node::$check_slot = $this->boundedTicks( 20 );

		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose.*' ], [ 'firehose.p0' => 'start' ], 500 );
		$out = \ob_get_clean();

		$this->assertStringContainsString(
			':' . \str_repeat( '.', 200 ),
			$out,
			'expected a flush-padding SSE comment to push buffered payloads through'
		);

		$this->rmdir_recursive( $base );
	}

	/**
	 * A subscription that throws (e.g. path-traversal `../etc/passwd`) MUST
	 * NOT leave `_router`, `_http`, `_command_interpreter`, or `_default_route`
	 * registered in the substrate. If it does, the next SSE request hits `node
	 * name collision: _router already registered` on `Router->name('_router')`
	 * and every subsequent stream blows up until the process recycles.
	 */
	public function test_stream_command_to_ci_is_interpreted_and_reply_routed(): void {
		// The payoff path: a command arriving over the stream (TO=_command_interpreter,
		// i.e. what a worker's `cmd _repl/_command_interpreter …` becomes after the
		// worker peels `_repl`) is interpreted IN the SSE process and its reply routed.
		// `reply_to _sse uptime` runs `uptime` here and routes the reply to `_sse` →
		// the client. Signed, since LOCAL is stripped at the wire and the SSE interpreter uses
		// the HMAC verifier. (Driven through a log subscription because that Consumer
		// honors `positions=start`; worker-IPC Consumers tail-seek to 'end'. Both sink
		// into `_default_route` → interpreter, so the interpret+route path under test is shared.)
		$base = $this->make_temp_dir( 'msg-stream-cmd-' );
		\mkdir( "{$base}/logs/firehose.p0", 0755, true );
		$p = new Partition_Node();
		$p->arguments( [ "{$base}/logs/firehose.p0" ] );
		$cmd = Message::new_message();
		$cmd[ Message::TYPE ]  = Message::TM_COMMAND;
		$cmd[ Message::TO ]    = Node_Names::COMMAND_INTERPRETER;
		$cmd[ Message::VALUE ] = [ 'name' => 'reply_to', 'arguments' => [ '_sse', 'uptime' ], 'payload' => '' ];
		Command_Auth::sign( $cmd );
		$p->fill( $cmd );
		$p->flush();

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $base );
		SSE_Out_Node::$check_slot = $this->boundedTicks( 20 );
		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose.*' ], [ 'firehose.p0' => 'start' ], 500 );
		$out = \ob_get_clean();

		// reply_to routed the uptime reply to _sse → the client sees it; auth passed.
		// Assert both the verb name (reply routed) AND ` up ` from uptime's actual
		// payload ("{clock}  up {elapsed}") so a name-echo on error wouldn't pass.
		$this->assertStringContainsString( 'uptime', $out );
		$this->assertStringContainsString( ' up ', $out );
		$this->assertStringNotContainsString( 'unauthorized', $out );
	}

	public function test_invalid_subscription_does_not_leak_substrate_nodes(): void {
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->make_temp_dir( 'msg-stream-leak-' ) );
		SSE_Out_Node::$check_slot = $this->boundedTicks( 5 );

		try {
			\ob_start();
			$ctrl->run_stream_loop( [ '../etc/passwd' ], null, 500 );
			$this->fail( 'expected InvalidArgumentException' );
		} catch ( \InvalidArgumentException $e ) {
			// expected
		} finally {
			\ob_get_clean();
		}

		$this->assertNull( Core::node( '_router' ) );
		$this->assertNull( Core::node( '_http' ) );
		$this->assertNull( Core::node( '_command_interpreter' ) );
		$this->assertNull( Core::node( '_default_route' ) );
	}

	public function test_stream_emits_heartbeat_events_during_idle(): void {
		// Empty firehose dir so no data lines compete with heartbeats — any
		// `heartbeat` event in the captured output came from the drain loop
		// itself, not from a forwarded message.
		$base = $this->make_temp_dir( 'msg-stream-heartbeat-' );
		\mkdir( "{$base}/logs/firehose.p0", 0755, true );

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $base );
		SSE_Out_Node::$check_slot = $this->boundedTicks( 50 );

		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose.*' ], [ 'firehose.p0' => 'start' ], 1 );
		$out = \ob_get_clean();

		$events    = $this->split_sse_events( $out );
		$heartbeat = \array_filter( $events, static fn ( $e ) => 'heartbeat' === $e['event'] );
		$this->assertNotEmpty(
			$heartbeat,
			'drain loop should emit at least one `heartbeat` SSE event so dashboards can detect a live but idle stream'
		);

		$this->rmdir_recursive( $base );
	}

	// ── close-at-EOF: `retry:` + the idle timeout ────────────────────────────

	public function test_stream_advertises_the_configured_reconnect_delay_before_the_connected_envelope(): void {
		$this->set_sse_config( 900, 4500 );
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->make_temp_dir( 'sse-retry-hint-' ) );
		SSE_Out_Node::$check_slot = $this->boundedTicks( 1 );

		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose.*' ], null, 500 );
		$out = (string) \ob_get_clean();

		$retry_at = \strpos( $out, "retry: 4500\n" );
		$this->assertNotFalse( $retry_at, 'the stream must advertise its reopen schedule' );
		$connected_at = \strpos( $out, 'event: connected' );
		$this->assertNotFalse( $connected_at );
		$this->assertLessThan( $connected_at, $retry_at, 'the client learns when to come back before anything else' );
	}

	public function test_stream_closes_itself_after_the_configured_idle_timeout_at_eof(): void {
		$this->set_sse_config( 1, 4500 );
		$base = $this->make_temp_dir( 'sse-idle-close-' );
		\mkdir( "{$base}/logs/firehose.p0", 0755, true );
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $base );
		$capped                   = false;
		SSE_Out_Node::$check_slot = $this->safety_cap( $capped );

		$started = \microtime( true );
		\ob_start();
		// Heartbeat cadence far beyond the idle window: nothing but the idle
		// timeout itself can end this drain.
		$ctrl->run_stream_loop( [ 'firehose.*' ], null, 60000 );
		$out     = (string) \ob_get_clean();
		$elapsed = \microtime( true ) - $started;

		$this->assertFalse( $capped, 'the idle timeout, not the safety cap, must end the stream' );
		$this->assertGreaterThanOrEqual( 1.0, $elapsed, 'the stream must survive the whole idle window' );
		$this->assertStringNotContainsString( 'event: disconnect', $out, 'an idle close is a clean EOF, not a failure' );

		$this->rmdir_recursive( $base );
	}

	public function test_heartbeats_alone_do_not_keep_an_idle_stream_open(): void {
		$this->set_sse_config( 1, 4500 );
		$base = $this->make_temp_dir( 'sse-idle-heartbeat-' );
		\mkdir( "{$base}/logs/firehose.p0", 0755, true );
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $base );
		$capped                   = false;
		SSE_Out_Node::$check_slot = $this->safety_cap( $capped );

		\ob_start();
		// Heartbeats every 200ms — five of them inside one idle window.
		$ctrl->run_stream_loop( [ 'firehose.*' ], null, 200 );
		$out = (string) \ob_get_clean();

		$events    = $this->split_sse_events( $out );
		$heartbeat = \array_filter( $events, static fn ( $e ) => 'heartbeat' === $e['event'] );
		$this->assertNotEmpty( $heartbeat, 'the stream must have been heartbeating throughout' );
		$this->assertFalse( $capped, 'heartbeats are liveness, not activity — they must not defer the close' );

		$this->rmdir_recursive( $base );
	}

	public function test_a_stream_that_keeps_receiving_data_never_closes(): void {
		$this->set_sse_config( 1, 4500 );
		$base = $this->make_temp_dir( 'sse-idle-busy-' );
		\mkdir( "{$base}/logs/firehose.p0", 0755, true );
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $base );

		$ended_by_check = false;
		$deadline       = \microtime( true ) + 2.0;
		// Every tick delivers a record through the egress the Consumer feeds,
		// so the stream is never at EOF for a whole idle window.
		SSE_Out_Node::$check_slot = static function () use ( $ctrl, $deadline, &$ended_by_check ): bool {
			$record                   = Message::new_message();
			$record[ Message::TYPE ]  = Message::TM_BYTESTREAM;
			$record[ Message::VALUE ] = "busy\n";
			$ctrl->fill( $record );
			if ( \microtime( true ) < $deadline ) {
				return true;
			}
			$ended_by_check = true;
			return false;
		};

		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose.*' ], null, 60000 );
		\ob_get_clean();

		$this->assertTrue( $ended_by_check, 'a stream carrying data must outlive twice its idle window' );

		$this->rmdir_recursive( $base );
	}

	public function test_a_non_positive_idle_timeout_leaves_the_stream_open(): void {
		$this->set_sse_config( -5, 4500 );
		$base = $this->make_temp_dir( 'sse-idle-disabled-' );
		\mkdir( "{$base}/logs/firehose.p0", 0755, true );
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $base );
		$ticks = 0;
		SSE_Out_Node::$check_slot = static function () use ( &$ticks ): bool {
			return ++$ticks < 4;
		};

		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose.*' ], null, 60000 );
		\ob_get_clean();

		$this->assertSame( 4, $ticks, 'a disabled idle timeout must neither close instantly nor spin' );

		$this->rmdir_recursive( $base );
	}

	public function test_an_idle_close_releases_its_slot_so_the_reopen_inside_the_ttl_is_granted(): void {
		// One slot, and a TTL that outlives the reopen: the reopening client
		// meets its OWN lease, and must reclaim it rather than read a full pool.
		SSE_Slot_Pool::$max_slots = 1;
		SSE_Slot_Pool::$ttl       = 41;
		Core::$memd               = new InMemoryMemcached();
		SSE_Slot_Pool::wire();
		$this->set_sse_config( 1, 4500 );

		$base = $this->make_temp_dir( 'sse-idle-slot-' );
		\mkdir( "{$base}/logs/firehose.p0", 0755, true );
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $base );

		$acquire = SSE_Out_Node::$acquire_slot;
		$lease   = $acquire( -1 );
		$this->assertIsArray( $lease );
		$this->assertFalse( $acquire( -1 ), 'a second client must be refused, never handed a live slot' );

		$capped                   = false;
		$check                    = SSE_Out_Node::$check_slot;
		$cap                      = $this->safety_cap( $capped );
		SSE_Out_Node::$check_slot = static function ( array $held, int $partition ) use ( $cap, $check ): bool {
			return $cap( $held, $partition ) && $check( $held, $partition );
		};

		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose.*' ], null, 60000, $lease, -1 );
		\ob_get_clean();

		$this->assertFalse( $capped, 'the idle timeout must have ended the stream' );
		$reopened = $acquire( -1 );
		$this->assertIsArray( $reopened, 'the reopen must find its own slot free' );
		$this->assertSame( $lease['slot'], $reopened['slot'] );
		$this->assertNotSame( $lease['owner'], $reopened['owner'] );

		$this->rmdir_recursive( $base );
	}

	// ── resume: `id:` + Last-Event-ID ────────────────────────────────────────

	public function test_every_subscription_resumes_across_the_disconnected_window(): void {
		// THE headline case, not an edge one. Idleness is what closed the
		// stream, so the first traffic after it lands while the client is
		// waiting out `retry:` — with nothing connected. A tail-seeking reopen
		// would systematically drop that first burst, invisibly, on every
		// subscription, and look healthy again from the next burst onward.
		$this->set_sse_config( 1, 4500 );
		$base = $this->make_temp_dir( 'sse-resume-multi-' );
		$this->write_records( $base, 'firehose.p0', [ 'f1', 'f2' ] );
		$this->write_records( $base, 'errors.p0', [ 'e1', 'e2' ] );

		$subs  = [ 'firehose.p0', 'errors.p0' ];
		$first = $this->drain_once(
			$base,
			$subs,
			[ 'firehose.p0' => 'start', 'errors.p0' => 'start' ]
		);
		$this->assertSame(
			[ 'errors.p0' => [ 'e1', 'e2' ], 'firehose.p0' => [ 'f1', 'f2' ] ],
			$first['by_sub']
		);
		$this->assertNotSame( '', $first['id'], 'every message must carry a resume token' );

		// The disconnected window is where the next burst lands.
		$this->write_records( $base, 'firehose.p0', [ 'f3', 'f4' ] );
		$this->write_records( $base, 'errors.p0', [ 'e3' ] );

		$second = $this->drain_once( $base, $subs, null, $first['id'] );

		// Per subscription, not a union: a regression in ONE must not hide
		// behind its sibling's records.
		$this->assertSame(
			[ 'errors.p0' => [ 'e3' ], 'firehose.p0' => [ 'f3', 'f4' ] ],
			$second['by_sub'],
			'each subscription delivers exactly its gap — nothing repeated, nothing skipped'
		);

		$this->rmdir_recursive( $base );
	}

	public function test_resume_lands_on_the_next_record_not_inside_or_past_it(): void {
		// Two adjacent records: resuming from the first's token must deliver the
		// second exactly once. Off by -1 re-delivers the first; off by +1 seeks
		// into the second's payload and drops it.
		$this->set_sse_config( 1, 4500 );
		$base = $this->make_temp_dir( 'sse-resume-framing-' );
		$this->write_records( $base, 'firehose.p0', [ 'first-record', 'second-record' ] );

		$first = $this->drain_once( $base, [ 'firehose.p0' ], [ 'firehose.p0' => 'start' ] );
		$this->assertSame( [ 'first-record', 'second-record' ], $first['values'] );
		// The token stamped on the FIRST record — its own resume boundary.
		$this->assertNotSame( '', $first['ids'][0] );

		$second = $this->drain_once( $base, [ 'firehose.p0' ], null, $first['ids'][0] );

		$this->assertSame( [ 'second-record' ], $second['values'] );

		$this->rmdir_recursive( $base );
	}

	public function test_last_event_id_overrides_a_stale_positions_parameter(): void {
		// A native EventSource reopens on the URL it was constructed with, so
		// its `positions` is the ORIGINAL one and stale by definition.
		$this->set_sse_config( 1, 4500 );
		$base = $this->make_temp_dir( 'sse-resume-precedence-' );
		$this->write_records( $base, 'firehose.p0', [ 'r1', 'r2' ] );

		$first = $this->drain_once( $base, [ 'firehose.p0' ], [ 'firehose.p0' => 'start' ] );
		$this->assertSame( [ 'r1', 'r2' ], $first['values'] );
		$this->write_records( $base, 'firehose.p0', [ 'r3' ] );

		$second = $this->drain_once(
			$base,
			[ 'firehose.p0' ],
			[ 'firehose.p0' => 'start' ],
			$first['id']
		);

		$this->assertSame( [ 'r3' ], $second['values'], 'the stale query parameter must not replay' );

		$this->rmdir_recursive( $base );
	}

	/**
	 * Run one whole stream to its idle close, returning what the client saw:
	 * the `msg` VALUEs in order (flat and grouped by subscription), each
	 * message's resume token, and the last one.
	 *
	 * @param array<int,string>            $subs
	 * @param array<array-key,mixed>|null  $positions
	 * @return array{values:array<int,string>,by_sub:array<string,array<int,string>>,ids:array<int,string>,id:string}
	 */
	private function drain_once( string $base, array $subs, ?array $positions, string $last_event_id = '' ): array {
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $base );
		$capped                   = false;
		SSE_Out_Node::$check_slot = $this->safety_cap( $capped );

		\ob_start();
		$ctrl->run_stream_loop(
			$subs,
			$ctrl->resume_positions( $positions, $last_event_id ),
			60000
		);
		$out = (string) \ob_get_clean();
		$this->assertFalse( $capped, 'the stream must close on its idle timeout' );

		$values = [];
		$by_sub = [];
		$ids    = [];
		foreach ( $this->split_sse_events( $out ) as $event ) {
			if ( 'msg' !== $event['event'] ) {
				continue;
			}
			$decoded = \json_decode( $event['data'], true );
			if ( \is_array( $decoded ) && \is_string( $decoded[ Message::VALUE ] ?? null ) ) {
				$value                                          = \rtrim( $decoded[ Message::VALUE ], "\n" );
				$values[]                                       = $value;
				$by_sub[ (string) $decoded[ Message::FROM ] ][] = $value;
				$ids[]                                          = $event['id'];
			}
		}
		\ksort( $by_sub );
		return [
			'values' => $values,
			'by_sub' => $by_sub,
			'ids'    => $ids,
			'id'     => [] === $ids ? '' : (string) \end( $ids ),
		];
	}

	/** Append TM_BYTESTREAM records to one concrete partition dir. */
	private function write_records( string $base, string $dir, array $values ): void {
		$partition = new Partition_Node();
		$partition->arguments( [ "{$base}/logs/{$dir}" ] );
		foreach ( $values as $value ) {
			$record                       = Message::new_message();
			$record[ Message::TYPE ]      = Message::TM_BYTESTREAM;
			$record[ Message::VALUE ]     = "{$value}\n";
			$partition->fill( $record );
		}
		$partition->flush();
		$partition->remove_node();
	}

	/**
	 * A drain predicate that gives up after four seconds and says so, so a
	 * stream that never closes fails on its assertion instead of on the clock.
	 *
	 * @param bool $capped Set true when the cap, not the code under test, ended the drain.
	 */
	private function safety_cap( bool &$capped ): callable {
		$deadline = \microtime( true ) + 4.0;
		return static function () use ( $deadline, &$capped ): bool {
			if ( \microtime( true ) < $deadline ) {
				return true;
			}
			$capped = true;
			return false;
		};
	}

	/** Seed both SSE close-at-EOF knobs, distinct from every shipped default. */
	private function set_sse_config( int $idle_seconds, int $retry_ms ): void {
		$GLOBALS['_wp_options']['newspack_nodes_sse_idle_timeout'] = $idle_seconds;
		$GLOBALS['_wp_options']['newspack_nodes_sse_retry_ms']     = $retry_ms;
		Config::reset();
	}

	public function test_failed_lease_check_emits_one_terminal_disconnect_and_one_redacted_apcu_diagnostic(): void {
		$lease       = [ 'slot' => 7, 'owner' => 42424243 ];
		$checks      = 0;
		$inspections = 0;
		$logged      = [];
		$this->capture_diagnostics( $logged );
		SSE_Out_Node::$check_slot = static function ( array $actual_lease, int $partition ) use ( &$checks, $lease ): bool {
			++$checks;
			return $lease !== $actual_lease || 3 !== $partition;
		};
		SSE_Out_Node::$inspect_slot = static function ( array $actual_lease, int $partition ) use ( &$inspections, $lease ): array {
			++$inspections;
			return [
				'backend'                    => 'apcu',
				'lease_state'                 => 'liveness_missing',
				'apcu_expunges'               => 17,
				'apcu_available_memory_bytes' => 7654321,
				'owner'                      => $actual_lease['owner'],
				'cache_key'                  => "secret-cache-key-{$partition}",
			];
		};

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->make_temp_dir( 'sse-lease-lost-' ) );
		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose.*', 'errors.p3' ], null, 500, $lease, 3 );
		$out = (string) \ob_get_clean();

		$events      = $this->split_sse_events( $out );
		$disconnects = \array_values( \array_filter( $events, static fn ( array $event ): bool => 'disconnect' === $event['event'] ) );
		$this->assertSame( 1, $checks );
		$this->assertSame( 1, $inspections );
		$this->assertCount( 1, $disconnects );
		$this->assertSame( $disconnects[0], $events[ \count( $events ) - 1 ], 'disconnect must be the terminal event' );
		$message = \json_decode( $disconnects[0]['data'], true );
		$this->assertSame( 'slot_lease_lost', $message[ Message::KEY ] );
		$this->assertSame( 'SSE slot lease lost', $message[ Message::VALUE ] );
		$disconnect_offset = \strpos( $out, 'event: disconnect' );
		$this->assertNotFalse( $disconnect_offset );
		$this->assertStringContainsString(
			':' . \str_repeat( '.', 200 ),
			\substr( $out, $disconnect_offset ),
			'terminal disconnect must be padded and flushed immediately'
		);

		$this->assertSame(
			[
				[
					'reason'                      => 'slot_lease_lost',
					'pid'                         => \getmypid(),
					'slot'                        => 7,
					'partition'                   => 3,
					'subscriptions'               => [ 'firehose.*', 'errors.p3' ],
					'backend'                     => 'apcu',
					'lease_state'                  => 'liveness_missing',
					'apcu_expunges'                => 17,
					'apcu_available_memory_bytes'  => 7654321,
				],
			],
			$logged
		);
		$this->assertStringNotContainsString( '42424243', \wp_json_encode( $logged ) );
		$this->assertStringNotContainsString( 'secret-cache-key', \wp_json_encode( $logged ) );
	}

	public function test_failed_lease_check_logs_memcached_read_error_details(): void {
		$lease  = [ 'slot' => 7, 'owner' => 42424243 ];
		$logged = [];
		$this->capture_diagnostics( $logged );
		SSE_Out_Node::$check_slot = static fn ( array $actual_lease, int $partition ): bool => false;
		SSE_Out_Node::$inspect_slot = static fn ( array $actual_lease, int $partition ): array => [
			'backend'                   => 'memcached',
			'lease_state'                => 'backend_read_error',
			'memcached_result_code'      => \Memcached::RES_TIMEOUT,
			'memcached_result_message'   => 'READ TIMED OUT 731',
		];

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->make_temp_dir( 'sse-backend-error-' ) );
		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose.*' ], null, 500, $lease, 3 );
		\ob_get_clean();

		$this->assertCount( 1, $logged );
		$this->assertSame( 'memcached', $logged[0]['backend'] );
		$this->assertSame( 'backend_read_error', $logged[0]['lease_state'] );
		$this->assertSame( \Memcached::RES_TIMEOUT, $logged[0]['memcached_result_code'] );
		$this->assertSame( 'READ TIMED OUT 731', $logged[0]['memcached_result_message'] );
	}

	public function test_healthy_check_does_not_collect_backend_diagnostics(): void {
		$checks      = 0;
		$inspections = 0;
		$logged      = [];
		$this->capture_diagnostics( $logged );
		SSE_Out_Node::$check_slot = static function () use ( &$checks ): bool {
			return 1 === ++$checks;
		};
		SSE_Out_Node::$inspect_slot = static function () use ( &$inspections ): array {
			++$inspections;
			return [
				'backend'    => 'memcached',
				'lease_state' => 'pointer_missing',
			];
		};

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->make_temp_dir( 'sse-failure-only-inspect-' ) );
		\ob_start();
		$ctrl->run_stream_loop(
			[ 'firehose.*' ],
			null,
			500,
			[ 'slot' => 7, 'owner' => 42424243 ],
			3
		);
		\ob_get_clean();

		$this->assertSame( 2, $checks );
		$this->assertSame( 1, $inspections, 'only the rejected check may inspect the backend' );
		$this->assertCount( 1, $logged );
	}

	public function test_unexpected_exception_logs_once_cleans_up_releases_and_rethrows_the_original(): void {
		$lease    = [ 'slot' => 7, 'owner' => 42424243 ];
		$failure  = new \RuntimeException( 'distinct drain failure 90210' );
		$logged   = [];
		$released = [];
		$this->capture_diagnostics( $logged );
		SSE_Out_Node::$check_slot = static function () use ( $failure ): bool {
			throw $failure;
		};
		SSE_Out_Node::$inspect_slot = static function (): array {
			throw new \LogicException( 'exception path must not inspect the cache' );
		};
		SSE_Out_Node::$release_slot = static function ( array $actual_lease, int $partition ) use ( &$released ): void {
			$released[] = [ $actual_lease, $partition ];
		};

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->make_temp_dir( 'sse-exception-' ) );
		$caught = null;
		try {
			\ob_start();
			$ctrl->run_stream_loop( [ 'firehose.*' ], null, 500, $lease, 3 );
		} catch ( \Throwable $e ) {
			$caught = $e;
		} finally {
			\ob_get_clean();
		}

		$this->assertSame( $failure, $caught, 'the original exception must escape unchanged' );
		$this->assertSame( [ [ $lease, 3 ] ], $released );
		$this->assertCount( 1, $logged );
		$this->assertSame(
			[
				'reason'            => 'unexpected_exception',
				'pid'               => \getmypid(),
				'slot'              => 7,
				'partition'         => 3,
				'subscriptions'     => [ 'firehose.*' ],
				'exception_class'   => \RuntimeException::class,
				'exception_message' => 'distinct drain failure 90210',
			],
			$logged[0]
		);
		$this->assertNull( Core::node( Node_Names::ROUTER ) );
		$this->assertNull( Core::node( Node_Names::COMMAND_INTERPRETER ) );
		$this->assertNull( Core::node( Node_Names::OUTPUT ) );
		$this->assertNull( Core::node( Node_Names::SSE ) );
	}

	public function test_inspection_exception_is_logged_once_and_rethrown_after_release(): void {
		$lease    = [ 'slot' => 7, 'owner' => 42424243 ];
		$failure  = new \LogicException( 'distinct inspection failure 731' );
		$logged   = [];
		$released = [];
		$this->capture_diagnostics( $logged );
		SSE_Out_Node::$check_slot   = static fn (): bool => false;
		SSE_Out_Node::$inspect_slot = static function () use ( $failure ): array {
			throw $failure;
		};
		SSE_Out_Node::$release_slot = static function ( array $actual_lease, int $partition ) use ( &$released ): void {
			$released[] = [ $actual_lease, $partition ];
		};

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->make_temp_dir( 'sse-inspection-exception-' ) );
		$caught = null;
		try {
			\ob_start();
			$ctrl->run_stream_loop( [ 'errors.p3' ], null, 500, $lease, 3 );
		} catch ( \Throwable $e ) {
			$caught = $e;
		} finally {
			\ob_get_clean();
		}

		$this->assertSame( $failure, $caught );
		$this->assertSame( [ [ $lease, 3 ] ], $released );
		$this->assertCount( 1, $logged );
		$this->assertSame( 'unexpected_exception', $logged[0]['reason'] );
		$this->assertSame( \LogicException::class, $logged[0]['exception_class'] );
		$this->assertSame( 'distinct inspection failure 731', $logged[0]['exception_message'] );
	}

	/**
	 * Parse `id: Z\nevent: X\ndata: Y\n\n` SSE chunks from a captured stdout
	 * buffer. Skips empty chunks and comment-only flush filler lines.
	 *
	 * @return array<int, array{event: string, data: string, id: string}>
	 */
	private function split_sse_events( string $raw ): array {
		$out = [];
		foreach ( \explode( "\n\n", \trim( $raw ) ) as $chunk ) {
			$chunk = \trim( $chunk );
			if ( '' === $chunk || \str_starts_with( $chunk, ':' ) ) {
				continue;
			}
			$ev   = null;
			$data = null;
			$id   = '';
			foreach ( \explode( "\n", $chunk ) as $line ) {
				if ( \str_starts_with( $line, 'event: ' ) ) {
					$ev = \substr( $line, 7 );
				}
				if ( \str_starts_with( $line, 'data: ' ) ) {
					$data = \substr( $line, 6 );
				}
				if ( \str_starts_with( $line, 'id: ' ) ) {
					$id = \substr( $line, 4 );
				}
			}
			if ( null !== $ev && null !== $data ) {
				$out[] = [
					'event' => $ev,
					'data'  => $data,
					'id'    => $id,
				];
			}
		}
		return $out;
	}

	/** @param array<int,array<string,mixed>> $logged */
	private function capture_diagnostics( array &$logged ): void {
		$this->assertTrue( \property_exists( SSE_Out_Node::class, 'diagnostic_log' ), 'diagnostic log seam is missing' );
		SSE_Out_Node::$diagnostic_log = static function ( array $context ) use ( &$logged ): void {
			$logged[] = $context;
		};
	}

	public function test_stream_self_heals_when_a_partition_dir_appears_and_vanishes(): void {
		// A live glob stream picks up a partition dir created mid-drain, then drops
		// the Consumer when the dir is removed (partitions increasing AND decreasing).
		// The reconcile runs on the heartbeat, so check_slot polls across ticks.
		$base = $this->make_temp_dir( 'sse-selfheal-' );
		\mkdir( "{$base}/logs/firehose.p0", 0755, true );
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $base );

		$ticks = 0;
		$phase = 'add';
		SSE_Out_Node::$check_slot = function () use ( &$ticks, &$phase, $base ): bool {
			if ( ++$ticks > 2000 ) {
				return false; // safety cap so a wiring regression can't hang the suite
			}
			if ( 'add' === $phase ) {
				if ( ! \is_dir( "{$base}/logs/firehose.p1" ) ) {
					\mkdir( "{$base}/logs/firehose.p1", 0755, true );
				} elseif ( Core::node( 'firehose.p1' ) instanceof Consumer_Node ) {
					$this->rmdir_recursive( "{$base}/logs/firehose.p1" );
					$phase = 'remove';
				}
				return true;
			}
			// remove phase: stop once the vanished dir's Consumer is reconciled out.
			return Core::node( 'firehose.p1' ) instanceof Consumer_Node;
		};

		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose.*' ], null, 1, [ 'slot' => 7, 'owner' => 42424243 ], 3 );
		\ob_get_clean();

		$this->assertLessThan( 2000, $ticks, 'self-heal added then removed the partition before the cap' );
		$this->rmdir_recursive( $base );
	}
}
