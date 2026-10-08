<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Log_Sources;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Probe_Record;
use Newspack_Nodes\Remote_Consumer_Node;
use Newspack_Nodes\Remote_Source_Node;
use Newspack_Nodes\Rest\SSE_Out_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\SSE_In_Node;
use Newspack_Nodes\Vault;
use Newspack_Nodes\Worker_Should_Stop;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

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
		if ( 'stop-flush-failed' === $key ) {
			throw new Worker_Should_Stop( 'cooperative stop', 0, new \RuntimeException( 'segment write refused: ENOSPC' ) );
		}
		if ( 'clean-bare' === $key ) {
			throw new \Newspack_Nodes\Worker_Should_Stop_Clean( 'clean stop 5146' );
		}
		if ( 'clean-flush-failed' === $key ) {
			throw new \Newspack_Nodes\Worker_Should_Stop_Clean( 'clean stop', 0, new \RuntimeException( 'segment write refused: EIO-63' ) );
		}
		$this->captured[] = $message;
	}
}

/**
 * The reader: one stream of a broker's connection, read like a Consumer —
 * cursor, offsetlog, dead-letter lifecycle, crawl, cooperative stops and the
 * connect position the broker asks it for. Broker behaviour lives in
 * RemoteSourceNodeTest.
 */
#[CoversClass( Remote_Consumer_Node::class )]
class RemoteConsumerNodeTest extends TestCase {

	private string $base_dir = '';

	protected function setUp(): void {
		parent::setUp();
		$this->base_dir = $this->make_temp_dir();
		$this->use_base_dir( $this->base_dir );
		Core::$memd = new InMemoryMemcached();
		// A live graph always has _router: the readers route through it.
		( new Router_Node() )->name( '_router' );
		// The broker housekeeps once per wall-second; start on a known one.
		Core::$now = 500.0;
	}

	protected function tearDown(): void {
		Command_Auth::forget_session( 'austin' );
		Log_Sources::$builtin_sources = null;
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

	/**
	 * A named broker sinking into _router, its first tick run so the exact
	 * pair's reader exists; `downstream` is whatever the caller registered.
	 *
	 * @return array{0:Remote_Source_Node,1:Remote_Consumer_Node}
	 */
	private function make_broker( string $name = 'remote-austin', ?array $args = null ): array {
		$broker = new Remote_Source_Node();
		$broker->name( $name );
		$broker->sink( Core::node( '_router' ) );
		$broker->arguments( $args ?? $this->remote_args( $name ) );
		$broker->fire();
		return [ $broker, Core::node( "{$name}:firehose.p0" ) ];
	}

	/**
	 * A broker over one `firehose.p0:downstream` pair and its reader, with a
	 * capture sink named `downstream`.
	 *
	 * @return array{0:Remote_Source_Node,1:Remote_Consumer_Node,2:Capture_Sink_Node}
	 */
	private function make_remote( string $name = 'remote-austin', ?array $args = null ): array {
		$sink = new Capture_Sink_Node();
		$sink->name( 'downstream' );
		return [ ...$this->make_broker( $name, $args ), $sink ];
	}

	/**
	 * `make_remote()` with a Relay_Sink_Spy named `downstream`.
	 *
	 * @return array{0:Remote_Source_Node,1:Remote_Consumer_Node,2:Relay_Sink_Spy}
	 */
	private function make_remote_spy( string $name = 'remote-austin', ?array $args = null ): array {
		$spy = new Relay_Sink_Spy();
		$spy->name( 'downstream' );
		return [ ...$this->make_broker( $name, $args ), $spy ];
	}

	/** A `msg` frame from the default pair's stream, unless the fields name another FROM. */
	private static function stream_frame( array $fields ): string {
		return self::sse_frame( 'msg', $fields + [ Message::FROM => 'firehose.p0' ] );
	}

	/** `msg_frame()`, stamped with the default pair's stream. */
	private static function stream_msg( string $id, string $key, mixed $value ): string {
		return self::stream_frame( [ Message::TYPE => Message::TM_STRUCT, Message::ID => $id, Message::KEY => $key, Message::VALUE => $value ] );
	}

	// ---------------------------------------------------------------------
	// Inbound addressing — the spoke does not pick a node in the hub's graph.
	// ---------------------------------------------------------------------

	/** A TM_STRUCT stream message the spoke addressed to a node in OUR graph. */
	private function addressed_message( string $id, string $to ): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::FROM ]  = 'firehose.p0';
		$m[ Message::ID ]    = $id;
		$m[ Message::TO ]    = $to;
		$m[ Message::VALUE ] = [ 'p' => 1 ];
		return $m;
	}

	public function test_a_relay_refuses_a_line_addressed_to_its_broker(): void {
		// The broker's patron declares the broker's own name for the heartbeat
		// reply, and that declaration must not let a spoke address it.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ , $node, $sink ] = $this->make_remote();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver_built( $sse, $this->addressed_message( '7:100:60', 'remote-austin' ) );

		$this->assertCount( 0, $sink->captured, 'a line addressed to the link itself reaches no node' );
	}

	public function test_a_refused_line_is_consumed_like_a_forwarded_one(): void {
		// Refusal is not poison: the line is read, so the cursor moves past it by
		// its own crumb length. Left pinned, the relay re-reads it every resume.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ , $node, $sink ] = $this->make_remote();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver_built( $sse, $this->addressed_message( '7:100:60', '_fleet' ) );
		$this->assertSame(
			[ 7, 160 ],
			[ $this->read_private( $node, 'cursor_segment' ), $this->read_private( $node, 'cursor_offset' ) ],
			'the cursor sits PAST the refused record (100 + 60)'
		);

		// The next, unaddressed line still relays: one bad record wedges nothing.
		$this->deliver( $sse, '7:160:40' );
		$this->assertCount( 1, $sink->captured, 'an unaddressed line still reaches the sink' );
		$this->assertSame( '', $sink->captured[0][ Message::TO ], 'the Router peeled the target it took' );
	}

	public function test_a_set_target_refuses_a_line_the_spoke_addressed(): void {
		// The owner rule: a message addressed past a set target is the remote's
		// attempt to route inside this graph, dropped rather than silently
		// re-homed, so an operator sees it in the throttled audit line.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ , $node, $sink ] = $this->make_remote();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver_built( $sse, $this->addressed_message( '7:100:60', '_fleet' ) );

		$this->assertCount( 0, $sink->captured, 'an addressed line is dropped even with a target set' );
	}

	public function test_the_committed_cursor_names_the_next_unread_record(): void {
		// The cursor must mean what Consumer's means: the next UNREAD position.
		// Pinned at the last-forwarded record's start instead, every resume
		// re-delivers that one record — the hub writes it twice, adjacent, with
		// the same crumb, while the spoke's own log holds it once.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ , $node, $sink ] = $this->make_remote();
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );

		// Two records, the crumbs chaining exactly as a partition lays them out.
		$this->deliver( $sse, '7:100:60' );
		$this->deliver( $sse, '7:160:40' );

		$this->assertCount( 2, $sink->captured, 'both forwarded' );
		$this->assertSame(
			[ 7, 200 ],
			[ $this->read_private( $node, 'cursor_segment' ), $this->read_private( $node, 'cursor_offset' ) ],
			'the cursor sits PAST the last record (160 + 40), not on its start'
		);
	}

	// ---------------------------------------------------------------------
	// Seek sentinels — a reader has no segments, so it forwards the seek to
	// the spoke, which does.
	// ---------------------------------------------------------------------

	public function test_a_bare_seek_is_forwarded_to_the_spoke(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ , $node ] = $this->make_remote();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		$node->next_offset( [ 'segment' => 3, 'offset' => 900 ] ); // a pair the seek must override

		$node->next_offset( Consumer_Node::SEEK_RECENT );
		// A seek waits for the spoke to resolve it, and the reconnect is throttled to the
		// wall second — so the seek must survive the ticks in between.
		$node->fire_cb();
		$node->fire_cb();

		$captured = [];
		\Newspack_Nodes\Event_Framework::$curl_dispatch = function ( array $opts ) use ( &$captured ): \CurlHandle {
			$captured[] = $opts;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
		$this->assertTrue( $sse->maybe_connect() );
		\parse_str( (string) \parse_url( $captured[0][ \CURLOPT_URL ], PHP_URL_QUERY ), $query );
		$positions = \json_decode( $query['positions'], true );
		$this->assertSame( Consumer_Node::SEEK_RECENT, $positions['firehose.p0'] );
		$this->assertSame( Consumer_Node::SEEK_RECENT, $node->connect_position() );
	}

	public function test_a_seek_word_forwards_the_same_sentinel(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ , $node ] = $this->make_remote();
		$sse = Core::node( 'remote-austin:sse-in' );
		$node->receive( "stale, and about to be seeked away from", null );

		$node->next_offset( 'end' );

		$captured = [];
		\Newspack_Nodes\Event_Framework::$curl_dispatch = function ( array $opts ) use ( &$captured ): \CurlHandle {
			$captured[] = $opts;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
		$this->assertTrue( $sse->maybe_connect() );
		\parse_str( (string) \parse_url( $captured[0][ \CURLOPT_URL ], PHP_URL_QUERY ), $query );
		$this->assertSame( Consumer_Node::SEEK_END, \json_decode( $query['positions'], true )['firehose.p0'] );
		$this->assertSame( '', $this->read_private( $node, 'buffer' ), 'a seek abandons what was in flight' );
		$this->assertSame( Consumer_Node::SEEK_END, $node->connect_position() );
	}

	public function test_a_paused_seek_moves_the_cursor_and_leaves_the_stream_alone(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$disconnects = 0;
		[ $broker, $node ] = $this->make_remote();
		$sse = new class() extends SSE_In_Node {
			public int $disconnects = 0;
			public function disconnect(): void {
				++$this->disconnects; }
		};
		( new \ReflectionProperty( \Newspack_Nodes\Remote_Link_Node::class, 'sse_in' ) )->setValue( $broker, $sse );
		$node->pause();
		$disconnects = $sse->disconnects;

		$node->next_offset( [ 'segment' => 61, 'offset' => 7 ] );

		$this->assertSame( $disconnects, $sse->disconnects, 'a paused reader is not in the stream' );
		$this->assertSame( [ 'segment' => 61, 'offset' => 7 ], $node->connect_position() );
	}

	/** A spoke's `connected` handshake naming where the stream begins. */
	private function handshake( SSE_In_Node $sse, string $cursors ): void {
		$sse->process_sse_chunk( self::connected_frame( "SLOT 7 OWNER 42424243 CURSORS {$cursors}" ) );
	}

	public function test_the_handshake_cursor_resolves_a_pending_seek(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ , $node ] = $this->make_remote();
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );
		$node->next_offset( Consumer_Node::SEEK_END );

		$this->handshake( $sse, 'firehose.p0=9:4096' );

		$this->assertNull( $this->read_private( $node, 'pending_seek' ), 'the spoke answered the seek' );
		$this->assertSame( [ 'segment' => 9, 'offset' => 4096 ], $node->connect_position() );
		$this->assertSame( [ 'segment' => 9, 'offset' => 4096 ], $node->dump_metadata()['cursor'] );
	}

	public function test_a_handshake_with_no_pending_seek_leaves_the_cursor_alone(): void {
		// The handshake names the position the connect asked for, and ticks keep
		// draining until it lands, so adopting it would rewind past forwarded records.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ , $node ] = $this->make_remote();
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );
		$node->next_offset( [ 'segment' => 7, 'offset' => 41 ] );

		$this->handshake( $sse, 'firehose.p0=7:1' );

		$this->assertSame( [ 'segment' => 7, 'offset' => 41 ], $node->dump_metadata()['cursor'] );
		$this->assertSame( [ 'segment' => 7, 'offset' => 41 ], $node->connect_position() );
	}

	public function test_a_reader_reports_no_probe_record_until_it_stands_somewhere(): void {
		$reader = new Remote_Consumer_Node();
		$reader->name( 'remote-austin:firehose.p0' );
		$reader->arguments( [ 'firehose.p0', "{$this->base_dir}/o", "{$this->base_dir}/d" ] );

		$this->assertNull( $reader->probe_stats() );

		$reader->next_offset( [ 'segment' => 47, 'offset' => 3318 ] );
		$record = $reader->probe_stats();

		$this->assertSame( [ 47, 3318 ], [ $record[ Probe_Record::CURSOR_SEGMENT ], $record[ Probe_Record::CURSOR_OFF ] ] );
		$this->assertSame( '47:3318', $reader->cursor_position() );
	}

	public function test_a_reader_standing_at_zero_reports_it(): void {
		$reader = new Remote_Consumer_Node();
		$reader->name( 'remote-austin:firehose.p0' );
		$reader->arguments( [ 'firehose.p0', "{$this->base_dir}/o", "{$this->base_dir}/d" ] );
		$reader->skip_to( [ 'segment' => 0, 'offset' => 0 ] );
		( new \ReflectionMethod( $reader, 'pass_skipped_lines' ) )->invoke( $reader );
		$record = $reader->probe_stats();

		$this->assertSame( [ 0, 0 ], [ $record[ Probe_Record::CURSOR_SEGMENT ], $record[ Probe_Record::CURSOR_OFF ] ] );
	}

	/** A seek asked for before the durable cursor is first restored outlives the restore. */
	public function test_a_seek_asked_for_before_the_first_restore_survives_it(): void {
		$this->seed_offsetlog_frame( 812, 4410, 0, '', 'remote-kea' );
		$reader = new Remote_Consumer_Node();
		$reader->name( 'remote-kea:firehose.p0' );
		$reader->arguments( [ 'firehose.p0', \Newspack_Nodes\Config::get_offsets_directory() . '/remote-kea/firehose.p0', "{$this->base_dir}/d" ] );

		$reader->next_offset( Consumer_Node::SEEK_RECENT );

		$this->assertSame( Consumer_Node::SEEK_RECENT, $reader->connect_position(), 'the restore does not answer a seek it did not see' );
		$this->assertNull( $reader->probe_stats(), 'still seeking, it stands nowhere' );
	}

	/**
	 * A seek word asked for before the first restore outlives a crash-lineage
	 * frame, so the frame's head describes no record the spoke sends: the first
	 * record `recent` lands on is forwarded, never sacrificed as the suspect.
	 */
	public function test_a_pending_seek_word_arms_no_head_skip_from_the_frame(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 812, 4410, Remote_Consumer_Node::CRASH_MAX_ATTEMPTS, '' );
		Core::$now = 1000.0;
		[ , $node, $spy ] = $this->make_remote_spy();
		$sse = Core::node( 'remote-austin:sse-in' );

		$node->next_offset( Consumer_Node::SEEK_RECENT );
		$this->assertSame( Consumer_Node::SEEK_RECENT, $node->connect_position(), 'the first restore leaves the seek word standing' );
		$this->handshake( $sse, 'firehose.p0=61:7319' );
		$this->deliver( $sse, '61:7319:44', '' );

		$this->assertSame( 0, $this->count_log_records( $this->dlq() ), 'no record is sacrificed as the head' );
		$this->assertCount( 1, $spy->captured, 'the record recent lands on is forwarded' );
		$this->assertFalse( $this->read_private( $node, 'crawl_skip_head' ), 'no head skip stays armed' );
		$this->assertSame( [ 'segment' => 61, 'offset' => 7363 ], $node->connect_position(), 'the cursor stands past that record, where recent put it' );
	}

	/** With no seek asked for, the restored cursor answers the fresh reader's end seek. */
	public function test_a_restore_answers_a_fresh_readers_end_seek(): void {
		$this->seed_offsetlog_frame( 812, 4410, 0, '', 'remote-kea' );
		$reader = new Remote_Consumer_Node();
		$reader->name( 'remote-kea:firehose.p0' );
		$reader->arguments( [ 'firehose.p0', \Newspack_Nodes\Config::get_offsets_directory() . '/remote-kea/firehose.p0', "{$this->base_dir}/d" ] );

		$this->assertSame( [ 'segment' => 812, 'offset' => 4410 ], $reader->connect_position() );
	}

	/** A connect that asks past a held record places nothing: the cursor has not reached it. */
	public function test_a_reader_reports_no_probe_record_until_it_reaches_what_it_holds(): void {
		$reader = new Remote_Consumer_Node();
		$reader->name( 'remote-austin:firehose.p0' );
		$reader->arguments( [ 'firehose.p0', "{$this->base_dir}/o", "{$this->base_dir}/d" ] );
		$held = $this->healthy_message( '61:7319:44' );
		$reader->receive( Message::packed( $held ), $held );

		$this->assertSame( [ 'segment' => 61, 'offset' => 7363 ], $reader->connect_position() );
		$this->assertNull( $reader->probe_stats(), 'standing nowhere yet, it reports nothing' );
	}

	/** A handshake answering a connect past held records leaves the cursor behind them. */
	public function test_a_handshake_never_moves_the_cursor_past_what_it_holds(): void {
		$reader = new Remote_Consumer_Node();
		$reader->name( 'remote-austin:firehose.p0' );
		$reader->arguments( [ 'firehose.p0', "{$this->base_dir}/o", "{$this->base_dir}/d" ] );
		$held = $this->healthy_message( '61:7319:44' );
		$reader->receive( Message::packed( $held ), $held );
		$reader->connect_position();

		$reader->adopt_stream_start( [ 'segment' => 61, 'offset' => 7363 ] );

		$this->assertSame( [ 'segment' => 0, 'offset' => 0 ], $reader->dump_metadata()['cursor'], 'the cursor stays short of the held record, so a checkpoint cannot skip it' );
	}

	public function test_a_reader_far_behind_its_spoke_reports_no_end_and_no_backlog(): void {
		$reader = new Remote_Consumer_Node();
		$reader->name( 'remote-austin:firehose.p0' );
		$reader->arguments( [ 'firehose.p0', "{$this->base_dir}/o", "{$this->base_dir}/d" ] );
		$reader->next_offset( [ 'segment' => 8, 'offset' => 913 ] );
		$reader->skip_to( [ 'segment' => 900, 'offset' => 99_000_000 ] );

		$record = $reader->probe_stats();

		$this->assertSame(
			[ 8, 913, null, null, null ],
			[ $record[ Probe_Record::CURSOR_SEGMENT ], $record[ Probe_Record::CURSOR_OFF ], $record[ Probe_Record::END_SEGMENT ], $record[ Probe_Record::END_SIZE ], $record[ Probe_Record::DISTANCE ] ],
			"the spoke's end is out of sight, so its end and the distance to it are unknown"
		);
	}

	public function test_a_paused_reader_reports_no_backlog(): void {
		$reader = new Remote_Consumer_Node();
		$reader->name( 'remote-austin:firehose.p0' );
		$reader->arguments( [ 'firehose.p0', "{$this->base_dir}/o", "{$this->base_dir}/d" ] );
		$reader->next_offset( [ 'segment' => 31, 'offset' => 6602 ] );
		$reader->pause();

		$this->assertNull( $reader->probe_stats()[ Probe_Record::DISTANCE ] );
	}

	public function test_a_handshake_naming_no_segment_invents_none(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ , $node ] = $this->make_remote();
		$node->fire_cb();
		$node->next_offset( [ 'segment' => 812, 'offset' => 5 ] );
		$node->next_offset( Consumer_Node::SEEK_END );

		$this->handshake( Core::node( 'remote-austin:sse-in' ), 'firehose.p0=:6331' );

		$this->assertSame( [ 'offset' => 6331 ], $node->connect_position(), 'an unknown generation is never segment 0' );
		$this->assertNotSame( 0, $this->read_private( $node, 'cursor_segment' ) );
	}

	public function test_a_file_source_resumes_from_a_segmentless_cursor_without_replay(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$path = "{$this->base_dir}/php-error-6230.log";
		\file_put_contents( $path, "line-one\nline-two\n" );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];
		$this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'sources/php:downstream' ) );
		$reader = Core::node( 'remote-austin:sources:php' );

		// The spoke's handshake named no generation: `:<offset>`.
		$reader->next_offset( Consumer_Node::SEEK_END );
		$this->handshake( Core::node( 'remote-austin:sse-in' ), 'sources/php=:18' );
		$asked = $reader->connect_position();
		$this->assertSame( [ 'offset' => 18 ], $asked, 'no segment invented for an unknown generation' );

		// The reopen the spoke would open from that position replays nothing.
		$tail = ( new SSE_Out_Node() )->open_subscription( 'sources/php', [ 'sources/php' => $asked ] )[0];
		$cap  = new Capture_Sink_Node();
		$tail->sink( $cap );
		for ( $i = 0; $i < 5; $i++ ) {
			$tail->poll();
		}
		$this->assertSame( [], $cap->captured, 'the reopen must not replay the file' );
	}

	public function test_an_unknown_generation_writes_no_checkpoint(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'sources/php:downstream' ) );
		$reader = Core::node( 'remote-austin:sources:php' );
		$reader->next_offset( Consumer_Node::SEEK_END );
		$this->handshake( Core::node( 'remote-austin:sse-in' ), 'sources/php=:42' );

		$reader->checkpoint( true );

		$this->assertSame( 0, $this->count_offsetlog_records( $reader ), 'segment 0 would name a foreign inode on restore' );
	}

	public function test_the_first_record_names_the_generation(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'sources/php:downstream' ) );
		$reader = Core::node( 'remote-austin:sources:php' );
		$sse    = Core::node( 'remote-austin:sse-in' );
		$reader->next_offset( Consumer_Node::SEEK_END );
		$this->handshake( $sse, 'sources/php=:42' );
		$sse->process_sse_chunk( self::sse_frame( 'msg', [ Message::TYPE => Message::TM_BYTESTREAM, Message::FROM => 'sources/php', Message::ID => '558213:42:30', Message::VALUE => "PHP Warning: 7741\n" ] ) );

		$reader->fire_cb();

		$this->assertSame( [ 'segment' => 558213, 'offset' => 72 ], $reader->connect_position() );
	}

	public function test_a_reconnect_the_spoke_forced_asks_past_what_is_buffered(): void {
		// The spoke closed the stream with records still buffered here. The new
		// request asks for the end of the buffer, so the buffered copies drain once.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$captured = [];
		\Newspack_Nodes\Event_Framework::$curl_dispatch = static function ( array $opts ) use ( &$captured ): \CurlHandle {
			$captured[] = $opts;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
		[ $broker, $node, $sink ] = $this->make_remote();
		Core::$now = 1000.0;
		$this->drain_connect_queue();
		$sse = Core::node( 'remote-austin:sse-in' );
		$node->set_line_mode( true );
		foreach ( [ '5:0:30' => 'r1-121', '5:30:30' => 'r2-232', '5:60:30' => 'r3-343' ] as $crumb => $value ) {
			$sse->process_sse_chunk( self::stream_frame( [
				Message::TYPE  => Message::TM_BYTESTREAM,
				Message::ID    => $crumb,
				Message::VALUE => $value,
			] ) );
		}
		$node->poll(); // r1 forwarded; r2 and r3 still buffered
		$sse->disconnect(); // the spoke's idle close

		Core::$now = 1010.0;
		$node->fire_cb(); // r2 forwarded
		$broker->fire(); // the reconnect queued
		$this->drain_connect_queue();
		\parse_str( (string) \parse_url( \end( $captured )[ \CURLOPT_URL ], PHP_URL_QUERY ), $query );
		$asked = \json_decode( $query['positions'], true )['firehose.p0'];
		$sse->process_sse_chunk( self::stream_frame( [
			Message::TYPE  => Message::TM_BYTESTREAM,
			Message::ID    => '5:90:30',
			Message::VALUE => 'r4-454',
		] ) );
		for ( $i = 0; $i < 4; $i++ ) {
			$node->poll();
		}

		$this->assertSame( [ 'segment' => 5, 'offset' => 90 ], $asked, 'the request asks for the record after the buffer' );
		$this->assertSame( [ 'r1-121', 'r2-232', 'r3-343', 'r4-454' ], \array_column( $sink->captured, Message::VALUE ) );
	}

	public function test_a_reconnect_asks_past_the_last_buffered_record_with_a_crumb(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$captured = [];
		\Newspack_Nodes\Event_Framework::$curl_dispatch = static function ( array $opts ) use ( &$captured ): \CurlHandle {
			$captured[] = $opts;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
		[ , $node ] = $this->make_remote();
		Core::$now = 1000.0;
		$this->drain_connect_queue();
		$sse                 = Core::node( 'remote-austin:sse-in' );
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::ID ]    = '8:640:64';
		$m[ Message::VALUE ] = 'crumbed-929';
		$node->receive( Message::packed( $m ), $m );
		$bare                = Message::new_message();
		$bare[ Message::VALUE ] = 'no crumb here';
		$node->receive( Message::packed( $bare ), $bare );
		$sse->disconnect();

		Core::$now = 1010.0;
		$sse->maybe_connect(); // before any tick can drain the buffer

		\parse_str( (string) \parse_url( \end( $captured )[ \CURLOPT_URL ], PHP_URL_QUERY ), $query );
		$this->assertSame( [ 'segment' => 8, 'offset' => 704 ], \json_decode( $query['positions'], true )['firehose.p0'] );
	}

	/** A connect seam recording each request's asked position for firehose.p0. */
	private function capture_asked_positions( array &$asked ): void {
		\Newspack_Nodes\Event_Framework::$curl_dispatch = static function ( array $opts ) use ( &$asked ): \CurlHandle {
			\parse_str( (string) \parse_url( Core::as_string( $opts[ \CURLOPT_URL ] ), PHP_URL_QUERY ), $query );
			$asked[] = \json_decode( Core::as_string( $query['positions'] ?? '' ), true )['firehose.p0'] ?? null;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
	}

	/** One crumbed record off the wire, unpolled. */
	private function wire_record( SSE_In_Node $sse, string $crumb, string $value ): void {
		$sse->process_sse_chunk( self::stream_frame( [
			Message::TYPE  => Message::TM_BYTESTREAM,
			Message::ID    => $crumb,
			Message::VALUE => $value,
		] ) );
	}

	public function test_a_reconnect_after_skipped_lines_asks_past_them(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$asked = [];
		$this->capture_asked_positions( $asked );
		[ $broker, $node, $sink ] = $this->make_remote();
		Core::$now = 1000.0;
		$this->drain_connect_queue();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->wire_record( $sse, '5:0:30', 'r1-161' );
		$sse->process_sse_chunk( self::unparseable_frame( 'COUNT 2 CURSORS firehose.p0=5:95' ) );

		Core::$now = 1001.0;
		$node->fire_cb();
		$sse->disconnect();
		Core::$now = 1010.0;
		$broker->fire();
		$this->drain_connect_queue();

		$this->assertSame( [ 'r1-161' ], \array_column( $sink->captured, Message::VALUE ) );
		$this->assertSame( [ 'segment' => 5, 'offset' => 95 ], $node->dump_metadata()['cursor'] );
		$this->assertSame( [ 'segment' => 5, 'offset' => 95 ], \end( $asked ), 'the torn lines are not read, or counted, again' );
	}

	public function test_a_reconnect_past_a_skip_supersedes_a_pending_seek(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ , $node ] = $this->make_remote();
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertSame( Consumer_Node::SEEK_END, $node->connect_position(), 'a fresh reader asks for the end' );

		( $sse->on_skipped )( [ 'firehose.p0' => [ 'segment' => 13, 'offset' => 7261 ] ] );
		$this->assertSame( [ 'segment' => 13, 'offset' => 7261 ], $node->connect_position() );
		( new \ReflectionMethod( $node, 'pass_skipped_lines' ) )->invoke( $node );

		$this->assertSame(
			[ 'segment' => 13, 'offset' => 7261 ],
			$node->connect_position(),
			'the skip was a real place, so the end is no longer asked for'
		);
	}

	public function test_a_segmentless_skip_moves_only_the_offset(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ , $node ] = $this->make_remote();
		$node->next_offset( [ 'segment' => 4417, 'offset' => 12 ] );

		( Core::node( 'remote-austin:sse-in' )->on_skipped )( [ 'firehose.p0' => [ 'offset' => 930 ] ] );
		$this->assertSame( [ 'offset' => 930 ], $node->connect_position(), 'the skip frame is kept, segment-less' );
		( new \ReflectionMethod( $node, 'pass_skipped_lines' ) )->invoke( $node );

		$this->assertSame( [ 'offset' => 930 ], $node->connect_position() );
		$this->assertSame( 4417, $this->read_private( $node, 'cursor_segment' ), 'never written as 0' );
	}

	public function test_skipped_lines_wait_for_the_records_buffered_ahead_of_them(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$asked = [];
		$this->capture_asked_positions( $asked );
		[ , $node, $sink ] = $this->make_remote();
		Core::$now = 1000.0;
		$this->drain_connect_queue();
		$sse = Core::node( 'remote-austin:sse-in' );
		$node->set_line_mode( true );
		$this->wire_record( $sse, '5:0:30', 'r1-171' );
		$this->wire_record( $sse, '5:30:30', 'r2-282' );
		$sse->process_sse_chunk( self::unparseable_frame( 'COUNT 1 CURSORS firehose.p0=5:95' ) );

		$node->fire_cb();
		$this->assertSame( [ 'segment' => 5, 'offset' => 30 ], $node->dump_metadata()['cursor'], 'r2 is still ahead of the skip' );

		$sse->disconnect();
		Core::$now = 1010.0;
		$sse->maybe_connect();
		$this->assertSame( [ 'segment' => 5, 'offset' => 95 ], \end( $asked ), 'the reopen asks past the buffer AND the skip' );

		$node->fire_cb(); // r2, one line under line mode
		$node->fire_cb(); // the dry refill passes the skip
		$this->assertSame( [ 'r1-171', 'r2-282' ], \array_column( $sink->captured, Message::VALUE ) );
		$this->assertSame( [ 'segment' => 5, 'offset' => 95 ], $node->dump_metadata()['cursor'] );
	}

	public function test_a_record_after_the_skip_supersedes_it(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ , $node, $sink ] = $this->make_remote();
		$sse = Core::node( 'remote-austin:sse-in' );
		$sse->process_sse_chunk( self::unparseable_frame( 'COUNT 1 CURSORS firehose.p0=5:95' ) );
		$this->wire_record( $sse, '5:95:40', 'r3-393' );

		$node->poll();
		Core::$now = 1001.0;
		$node->fire_cb();

		$this->assertSame( [ 'r3-393' ], \array_column( $sink->captured, Message::VALUE ) );
		$this->assertSame( [ 'segment' => 5, 'offset' => 135 ], $node->dump_metadata()['cursor'], 'never rewound to the skip' );
	}

	public function test_a_seek_abandons_a_pending_skip(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ , $node ] = $this->make_remote();
		$sse = Core::node( 'remote-austin:sse-in' );
		$sse->process_sse_chunk( self::unparseable_frame( 'COUNT 1 CURSORS firehose.p0=5:95' ) );

		$node->pause();
		$node->next_offset( [ 'segment' => 7, 'offset' => 41 ] );
		$node->play();
		Core::$now = 1001.0;
		$node->fire_cb();

		$this->assertSame( [ 'segment' => 7, 'offset' => 41 ], $node->dump_metadata()['cursor'] );
	}

	public function test_a_bare_seek_resolves_on_the_first_record_even_without_cursors(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ , $node ] = $this->make_remote();
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );
		$node->next_offset( Consumer_Node::SEEK_END );

		$sse->process_sse_chunk( self::stream_frame( [
			Message::TYPE  => Message::TM_BYTESTREAM,
			Message::ID    => '9:4096:40',
			Message::VALUE => 'first-after-seek-525',
		] ) );
		$node->poll();

		$this->assertNull( $this->read_private( $node, 'pending_seek' ), 'the record says where the stream began' );
	}

	// ---------------------------------------------------------------------
	// Cadence — the reader owns the busy drain; the broker owns the channel.
	// ---------------------------------------------------------------------

	public function test_an_arriving_line_takes_the_busy_cadence_immediately(): void {
		// A pushed line arrives during the curl drain — between fires. Waiting
		// out the EOF cadence to notice would put up to POLL_INTERVAL_EOF_MS on
		// the front of every arrival burst.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ , $node ] = $this->make_remote();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertSame( Remote_Consumer_Node::POLL_INTERVAL_EOF_MS, $node->interval_ms, 'idle at the EOF cadence' );

		( $sse->on_message )( Message::packed( $this->healthy_message( '3:0:20' ) ) );

		$this->assertSame( Remote_Consumer_Node::POLL_INTERVAL_BUSY_MS, $node->interval_ms, 'the arrival itself schedules the drain' );
	}

	public function test_a_buffered_backlog_re_arms_for_the_next_event_cycle(): void {
		// line_mode is GRANULARITY — one line per event cycle — not a rate limit.
		[ , $node, $sink ] = $this->make_remote();
		$node->set_line_mode( true );
		$this->receive_lines( $node, 5 );

		$node->fire_cb();

		$this->assertCount( 1, $sink->captured, 'still one line per cycle' );
		$this->assertSame( Remote_Consumer_Node::POLL_INTERVAL_BUSY_MS, $node->interval_ms, 'and the next cycle is immediate' );
		$this->assertFalse( $node->oneshot, 'recurring, so a skipped re-arm cannot strand it' );
	}

	public function test_an_empty_buffer_rests_at_the_eof_cadence(): void {
		// Nothing to drain: rest at the recurring EOF cadence rather than
		// spinning the loop at 0ms.
		[ , $node ] = $this->make_remote();
		$this->receive_lines( $node, 1 );
		$node->fire_cb();

		$node->fire_cb();

		$this->assertSame( Remote_Consumer_Node::POLL_INTERVAL_EOF_MS, $node->interval_ms );
		$this->assertFalse( $node->oneshot );
	}

	/** Hand $count crumbed TM_STRUCT lines to the reader as the broker would. */
	private function receive_lines( Remote_Consumer_Node $node, int $count ): void {
		for ( $i = 0; $i < $count; $i++ ) {
			$m = $this->healthy_message( '0:' . ( $i * 100 ) . ':100' );
			$node->receive( Message::packed( $m ), $m );
		}
	}

	// ---------------------------------------------------------------------
	// Sidecars — rename, replay, teardown.
	// ---------------------------------------------------------------------

	/**
	 * Renaming the broker carries every reader and the reader's sidecars with
	 * it: each lands on `{new}:{kind}:offsetlog` / `:deadletter`, and nothing is
	 * left squatting the old slot.
	 */
	public function test_renaming_the_broker_moves_each_readers_sidecars(): void {
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		$broker  = new Remote_Source_Node();
		$broker->name( 'lighthouse-keeper' );
		$broker->sink( Core::node( '_router' ) );
		$broker->arguments( [ 'galveston', "{$offsets}/lighthouse-keeper", "{$base}/deadletter/lighthouse-keeper", 'beacon.p7:downstream' ] );
		$broker->fire();
		$node = Core::node( 'lighthouse-keeper:beacon.p7' );

		$broker->name( 'harbourwatch' );

		$offsetlog  = $this->read_private( $node, 'offsetlog' );
		$deadletter = $this->read_private( $node, 'deadletter' );
		$this->assertSame( $node, Core::node( 'harbourwatch:beacon.p7' ) );
		$this->assertSame( 'harbourwatch:beacon.p7:offsetlog', $offsetlog->name() );
		$this->assertSame( $offsetlog, Core::node( 'harbourwatch:beacon.p7:offsetlog' ) );
		$this->assertSame( 'harbourwatch:beacon.p7:deadletter', $deadletter->name() );
		$this->assertSame( $deadletter, Core::node( 'harbourwatch:beacon.p7:deadletter' ) );
		$this->assertNull( Core::node( 'lighthouse-keeper:beacon.p7:offsetlog' ) );
		$this->assertNull( Core::node( 'lighthouse-keeper:beacon.p7:deadletter' ) );
	}

	/** A reader standing alone, its dirs the arguments' last two tokens. */
	private function reader( string $name, string $stamp, string $offsetlog_dir, string $deadletter_dir ): Remote_Consumer_Node {
		$node = new Remote_Consumer_Node();
		$node->name( $name );
		$node->arguments( [ $stamp, $offsetlog_dir, $deadletter_dir ] );
		return $node;
	}

	/**
	 * `arguments()` is a replay setter, and a replay may name new dirs. The
	 * next commit has to land in the dir the args just gave it, never in the
	 * superseded one.
	 */
	public function test_replayed_arguments_commits_the_cursor_into_the_new_offsetlog_dir(): void {
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		$stale   = "{$offsets}/quarterdeck-stale/binnacle.p5";
		$fresh   = "{$offsets}/quarterdeck-fresh/gimbal.p9";
		$node    = $this->reader( 'quarterdeck-pull', 'binnacle.p5', $stale, "{$base}/deadletter/quarterdeck-stale" );
		$this->seed_position( $node );

		$node->arguments( [ 'gimbal.p9', $fresh, "{$base}/deadletter/quarterdeck-fresh" ] );
		$this->seed_position( $node );
		$node->next_offset( [ 'segment' => 0, 'offset' => 0 ] );
		$node->checkpoint();

		$this->assertNotNull( $this->last_frame_in( $fresh ), 'the cursor commits into the replayed dir' );
		$this->assertNull( $this->last_frame_in( $stale ), 'nothing reaches the superseded dir' );
		$this->assertSame(
			$this->read_private( $node, 'offsetlog' ),
			Core::node( 'quarterdeck-pull:offsetlog' ),
			'the rebuilt cursor is published in the one offsetlog slot'
		);
	}

	/**
	 * The quarantine is superseded the same way: a replay naming a different
	 * deadletter_dir has to quarantine poison into the dir it was just given.
	 */
	public function test_replayed_arguments_quarantines_into_the_new_deadletter_dir(): void {
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		$stale   = "{$base}/deadletter/mizzen-stale.p2";
		$fresh   = "{$base}/deadletter/mizzen-fresh.p2";
		$node    = $this->reader( 'mizzen-pull', 'mizzen.p2', "{$offsets}/mizzen-pull/mizzen.p2", $stale );

		$node->arguments( [ 'mizzen.p2', "{$offsets}/mizzen-pull/mizzen.p2", $fresh ] );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'brackish-water';
		( new \ReflectionMethod( $node, 'dead_letter' ) )->invoke( $node, $message, 'throw', null );

		$this->assertSame( [ 'brackish-water' ], $this->values_in( $fresh ), 'poison lands in the replayed dir' );
		$this->assertSame( [], $this->values_in( $stale ), 'nothing reaches the superseded dir' );
	}

	/**
	 * Committing into the replayed dir is half the invariant; RESUMING from it
	 * is the other half. The restore latch therefore has to name the offsetlog
	 * it read, not a bare `true` — a bool outlives the sidecar a replay
	 * supersedes and pins the cursor to the dir the args just dropped.
	 */
	public function test_replayed_arguments_resumes_the_cursor_from_the_new_offsetlog_dir(): void {
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		$stale   = "{$offsets}/binnacle-stale.p5";
		$fresh   = "{$offsets}/binnacle-fresh.p9";
		$this->commit_frame_at( $fresh, 7, 4242 );

		$node = $this->reader( 'binnacle-pull', 'binnacle.p5', $stale, "{$base}/deadletter/binnacle-stale.p5" );
		$this->seed_position( $node );

		$node->arguments( [ 'binnacle.p9', $fresh, "{$base}/deadletter/binnacle-fresh.p9" ] );
		$this->seed_position( $node );

		$this->assertSame( 7, $this->read_private( $node, 'cursor_segment' ), 'the replayed dir seats the segment' );
		$this->assertSame( 4242, $this->read_private( $node, 'cursor_offset' ), 'and the offset' );
	}

	/** Leave one durable frame at {segment,offset} in $dir, written by a real reader. */
	private function commit_frame_at( string $dir, int $segment, int $offset ): void {
		$base   = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		$scribe = $this->reader( 'binnacle-scribe', 'binnacle.p9', $dir, "{$base}/deadletter/binnacle-scribe.p9" );
		$scribe->next_offset( [ 'segment' => $segment, 'offset' => $offset ] );
		$scribe->checkpoint();
		$scribe->remove_node();
	}

	/** Seed the durable read position the way both production callers do. */
	private function seed_position( Remote_Consumer_Node $node ): void {
		( new \ReflectionMethod( $node, 'restore_position' ) )->invoke( $node );
	}

	/** @return array<array-key,mixed>|null */
	private function last_frame_in( string $dir ): ?array {
		$partition = new Partition_Node();
		$partition->arguments( [ $dir ] );
		return Remote_Consumer_Node::last_frame_of( $partition );
	}

	/** @return array<int,mixed> Every record VALUE written into $dir. */
	private function values_in( string $dir ): array {
		$partition = new Partition_Node();
		$partition->arguments( [ $dir ] );
		return $this->read_partition_values( $partition );
	}

	/**
	 * Teardown cascades into the sidecars, so the slots must be cleared with
	 * them. A slot still pointing at a torn-down node hands `ensure_offsetlog()`
	 * a node whose name, sink and patron are gone: its writes reach disk and
	 * nothing can address it.
	 */
	public function test_teardown_clears_the_sidecar_slots(): void {
		$offsets   = \Newspack_Nodes\Config::get_offsets_directory();
		$base      = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		$node      = $this->reader( 'capstan-watch', 'beacon.p7', "{$offsets}/capstan-watch/beacon.p7", "{$base}/deadletter/capstan-watch/beacon.p7" );
		$offsetlog = $this->read_private( $node, 'offsetlog' );

		$node->remove_node();

		$this->assertNull( $this->read_private( $node, 'offsetlog' ), 'the torn-down offsetlog is dropped' );
		$this->assertNull( $this->read_private( $node, 'deadletter' ), 'the torn-down quarantine is dropped' );
		$this->assertNotSame( $offsetlog, ( new \ReflectionMethod( $node, 'ensure_offsetlog' ) )->invoke( $node ) );
	}

	public function test_a_reader_requires_its_stamp_and_dirs(): void {
		$this->expectException( \InvalidArgumentException::class );
		( new Remote_Consumer_Node() )->arguments( [ 'firehose.p0' ] );
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
		[ , $node, $spy ] = $this->make_remote_spy();
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:128:44', 'boom' ); // downstream throws → dead-letter immediately.
		$this->deliver( $sse, '7:300:40', '' );     // NOT blocked: forwards.

		$this->assertSame( 1, $this->count_log_records( $this->dlq() ), 'poison dead-lettered on the first throw' );
		$this->assertCount( 1, $spy->captured, 'the following message is not head-blocked' );

		// A clean shutdown commits PAST the last forwarded message — its crumb start plus the
		// crumb's own length, which is the next unread position and never a record already read.
		$node->checkpoint_shutdown();
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 7, $frame['segment'] );
		$this->assertSame( 340, $frame['offset'] );
		$this->assertSame( 0, $frame['attempts'], 'no fair-shot climb — a clean handoff' );
	}

	public function test_resume_position_uses_the_crumb_length_not_the_local_line(): void {
		// The resume offset is in REMOTE coordinates, so only the crumb's on-disk
		// length is authoritative. The delivered line is re-stamped in transit and
		// runs longer, which pushed the resume INTO the next record: production saw
		// `57:40959889:177` resumed at 40959916 — 27 bytes in — and the spoke then
		// dead-lettered a 150-byte tail fragment, losing exactly one record.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ , $node ] = $this->make_remote_spy();
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );

		// A fat VALUE so the local line is nowhere near the 177-byte on-disk record.
		$this->deliver( $sse, '57:40959889:177', '', [ 'pad' => \str_repeat( 'x', 400 ) ] );

		$this->assertSame(
			40959889 + 177,
			$this->read_private( $node, 'cursor_offset' ),
			'the cursor must land on the next record boundary, not inside it'
		);
		$this->assertSame(
			40959889 + 177,
			$node->connect_position()['offset'],
			'and the resume position is that same cursor — one position, not two'
		);
	}

	public function test_crumbless_throw_dead_letters_without_moving_the_cursor(): void {
		// A crumb-less throwing message has no position of its own: it cannot be placed in the
		// spoke's bytes, so it moves the cursor by nothing. The disposal still commits, and that
		// commit must land PAST the prior healthy record — never rewound onto it.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ , $node ] = $this->make_remote_spy();
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:100:40', '' ); // healthy → cursor advances past it.
		$this->assertSame( 140, $this->read_private( $node, 'cursor_offset' ) );

		$this->deliver( $sse, '', 'boom' ); // crumb-less, downstream throws.

		$this->assertSame( 1, $this->count_log_records( $this->dlq() ), 'the crumb-less throw IS dead-lettered' );
		$this->assertSame( 140, $this->read_private( $node, 'cursor_offset' ), 'an unplaceable record moves the cursor by nothing' );
		$node->checkpoint_shutdown();
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 140, $frame['offset'], 'and the handoff sits past the healthy record, never rewound onto it' );
	}

	public function test_caught_throw_commits_past_the_poison_and_a_reboot_moves_on(): void {
		// A caught-throw poison is dead-lettered ON SIGHT, so its position is resolved: the cursor
		// advances past it by its own crumb length and the disposal commits there GRACEFULLY. A
		// respawn therefore resumes past it — it is never re-delivered, and never re-quarantined.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $broker, $node, $spy ] = $this->make_remote_spy();
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:128:44', 'boom' ); // last message → dead-lettered, then idle.
		$this->assertSame( 1, $this->count_log_records( $this->dlq() ) );
		$this->assertSame( 172, $this->read_private( $node, 'cursor_offset' ), 'the cursor moves PAST the poison (128 + 44)' );

		$node->checkpoint_shutdown();
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 172, $frame['offset'], 'and the handoff commits there' );
		$this->assertSame( 0, $frame['attempts'], 'a disposed record leaves no lineage behind' );
		$broker->remove_node();
		$spy->remove_node();
		[ , $node2, $spy2 ] = $this->make_remote_spy();
		$node2->fire_cb();
		$this->assertSame( 172, $this->read_private( $node2, 'cursor_offset' ), 'the respawn resumes past the poison' );
		$this->assertFalse( $this->read_private( $node2, 'crawl_skip_head' ), 'and arms no head sacrifice on a resolved position' );

		$sse2 = Core::node( 'remote-austin:sse-in' );
		$this->deliver( $sse2, '7:200:40', '' );
		$this->assertCount( 1, $spy2->captured, 'the next message forwards normally' );
		$this->assertSame( 1, $this->count_log_records( $this->dlq() ), 'and nothing is re-quarantined' );
	}

	public function test_a_disposal_ends_a_climbing_crash_lineage(): void {
		// The record the lineage was climbing for is now IN the dead-letter queue — the suspect is
		// resolved. Committing the live streak instead would leave the next boot arming a head
		// sacrifice at a clean position, condemning whichever innocent message arrived there.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, 2, '' ); // climbing lineage: resume -> attempts=3.
		[ , $node ] = $this->make_remote_spy();
		$node->fire_cb();
		$this->assertSame( 3, $this->read_private( $node, 'attempts' ) );
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:128:44', 'boom' ); // caught throw on the boot message.

		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 172, $frame['offset'], 'committed past the disposed record' );
		$this->assertSame( 0, $frame['attempts'], 'the lineage ends with the record it was about' );
	}

	public function test_unparseable_tail_is_quarantined_where_the_cursor_stands(): void {
		// The broker drops a frame that will not unpack, so the reader meets one
		// only when handed it directly. It carries no crumb, so it cannot be placed
		// in the spoke's bytes: it is dead-lettered where the cursor stands and
		// moves it by nothing, never by a local line length.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, 0, '' ); // boot = {7,128}.
		[ , $node, $spy ] = $this->make_remote_spy();
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );

		$node->receive( 'not-a-valid-message', null );
		$node->poll();
		$this->assertSame( 1, $this->count_log_records( $this->dlq() ), 'the unparseable line is quarantined once' );
		$this->assertSame( 128, $this->read_private( $node, 'cursor_offset' ), 'the cursor stands where the record was placed' );
		$this->assertCount( 0, $spy->captured, 'and nothing is forwarded' );

		// The stream moves on: the next crumb-bearing record places itself and forwards.
		$this->deliver( $sse, '7:400:40', '' );
		$this->assertCount( 1, $spy->captured );
		$this->assertSame( 440, $this->read_private( $node, 'cursor_offset' ) );
	}

	public function test_unparseable_past_the_boot_head_is_dead_lettered(): void {
		// An unparseable line is genuinely new poison wherever it lands: the stream
		// resuming PAST a GC'd crash suspect does not make it that suspect.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, Remote_Consumer_Node::CRASH_MAX_ATTEMPTS, '' ); // crash lineage, boot={7,128}.
		[ , $node ] = $this->make_remote_spy();
		$node->fire_cb();
		$this->assertTrue( $this->read_private( $node, 'crawl_skip_head' ) );
		( new \ReflectionProperty( Remote_Consumer_Node::class, 'cursor_offset' ) )->setValue( $node, 500 ); // the stream resumed PAST the boot head (suspect GC'd).

		$node->receive( 'not-a-valid-message', null );
		$node->poll();

		$this->assertSame( 1, $this->count_log_records( $this->dlq() ), 'an unparseable line PAST the boot head is DLQ\'d, not silently dropped' );
	}

	public function test_hard_crash_lineage_climbs_attempts_across_respawn(): void {
		// A hard-crash lineage (NO reason — an uncatchable death, not a caught throw) restores
		// and resumes at attempts+1: the climb that eventually reaches CRASH_MAX and crawls.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, 1, '' );

		[ , $node ] = $this->make_remote_spy();
		$node->fire_cb(); // restore_position applies the frame → attempts+1.

		$this->assertSame( 2, $this->read_private( $node, 'attempts' ) );
	}

	public function test_transient_hard_crash_recovered_resets_streak_on_forward_progress(): void {
		// A hard-crash lineage that turns out transient (the next message forwards fine) must
		// clear its climbing streak the moment a message forwards successfully — else the next
		// unclean recycle would falsely keep climbing toward the crawl threshold.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, 1, '' ); // prior cycle's crash.

		[ , $node, $spy ] = $this->make_remote_spy();
		$node->fire_cb(); // restore → attempts = 2 (lineage in flight).
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
		$this->seed_offsetlog_frame( 7, 0, Remote_Consumer_Node::CRASH_MAX_ATTEMPTS, '' );

		Core::$now = 1000.0;
		[ , $node, $spy ] = $this->make_remote_spy();
		$node->fire_cb(); // restore → crawl, attempts pinned at CRASH_MAX, crawl_started = 1000.
		$this->assertTrue( $this->read_private( $node, 'crawl' ) );
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:100:40', '' );
		$this->deliver( $sse, '7:200:40', '' );
		$this->assertSame( 2, $spy->fill_count, 'crawl still forwards each message' );
		$this->assertGreaterThanOrEqual( 2, $this->count_offsetlog_records( $node ), 'crawl checkpoints per message' );
		$this->assertSame( Remote_Consumer_Node::CRASH_MAX_ATTEMPTS, $this->newest_offsetlog_frame( $node )['attempts'], 'attempts pinned during crawl' );

		// A full interval elapses crash-free → the next message exits crawl to the baseline.
		Core::$now = 1000.0 + Remote_Consumer_Node::CHECKPOINT_INTERVAL_S + 1.0;
		$this->deliver( $sse, '7:300:40', '' );
		$this->assertFalse( $this->read_private( $node, 'crawl' ) );
		$this->assertSame( 1, $this->newest_offsetlog_frame( $node )['attempts'], 'crawl exits to the healthy baseline' );
	}

	public function test_crawl_pre_dispatch_commit_pins_line_before_fill(): void {
		// In crawl, forward_line writes a FORCED checkpoint at the in-hand line's OWN start
		// BEFORE the fill — so an uncatchable crash mid-dispatch re-resumes at exactly it. A
		// sink that reads the newest committed frame at fill() time already sees THIS line's
		// start committed. (The trait's poll_crawl checkpoint runs only AFTER the fill.)
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 0, Remote_Consumer_Node::CRASH_MAX_ATTEMPTS, '' ); // boot into crawl at {7,0}.

		Core::$now = 1000.0;
		$probe = new class() extends Node {
			public ?Partition_Node $offsetlog = null;
			/** @var array<int,array{segment:int,offset:int}> */
			public array $committed_at_fill = [];
			public function fill( array $message ): void {
				$segments = $this->offsetlog?->get_segments( true ) ?? [];
				$last     = \end( $segments );
				if ( false === $last ) {
					$this->committed_at_fill[] = [ 'segment' => -1, 'offset' => -1 ];
					return;
				}
				$content = (string) $this->offsetlog?->read_at( $last['id'], 0, $last['size'] );
				$lines   = \array_values( \array_filter( \explode( "\n", $content ), static fn ( $l ) => '' !== $l ) );
				$v       = Message::unpacked( \end( $lines ) )[ Message::VALUE ];
				$this->committed_at_fill[] = [ 'segment' => (int) $v['segment'], 'offset' => (int) $v['offset'] ];
			}
		};
		$probe->name( 'downstream' );
		[ , $node ] = $this->make_broker();
		$node->fire_cb(); // enter crawl; the newest frame is the boot seed {7,0}.
		$probe->offsetlog = $this->read_private( $node, 'offsetlog' );
		$sse = Core::node( 'remote-austin:sse-in' );

		// A line PAST the boot pin: sacrifice_boot_head disarms (stream resumed past the GC'd
		// suspect) and forwards it in crawl — exercising the crawl FORWARD path (not the sacrifice).
		$this->deliver( $sse, '7:100:40', '' );

		$this->assertSame(
			[ [ 'segment' => 7, 'offset' => 100 ] ],
			$probe->committed_at_fill,
			'the pinned cursor is committed BEFORE the fill in crawl'
		);
	}

	public function test_crawl_entry_sacrifices_matching_head_to_dlq_then_forwards(): void {
		// Consumer-parity head-sacrifice: booting into a hard-crash lineage (crawl) pins the
		// boot cursor and arms a one-shot head-sacrifice. The first relayed message whose crumb
		// START matches the pin is the in-flight-at-crash suspect — dead-lettered with reason
		// 'crash' (NOT forwarded, even though it is otherwise healthy), the local cursor advances
		// PAST it (offset+length), the flag clears, and the next message forwards normally.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, Remote_Consumer_Node::CRASH_MAX_ATTEMPTS, '' );

		Core::$now = 1000.0;
		[ , $node, $spy ] = $this->make_remote_spy();
		$node->fire_cb(); // restore → crawl, boot pinned at {7,128}, head-sacrifice armed.
		$this->assertTrue( $this->read_private( $node, 'crawl' ) );
		$this->assertTrue( $this->read_private( $node, 'crawl_skip_head' ), 'crawl entry arms the head sacrifice' );
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:128:44', '' ); // matches the pin → sacrificed even though healthy.

		$this->assertSame( 1, $this->count_log_records( $this->dlq() ), 'suspect head dead-lettered' );
		$this->assertCount( 0, $spy->captured, 'suspect head is NOT forwarded downstream' );
		$this->assertFalse( $this->read_private( $node, 'crawl_skip_head' ), 'head sacrifice is one-shot' );
		// The suspect is resolved: the cursor moves PAST it (128 + 44).
		$this->assertSame( 7, $this->read_private( $node, 'cursor_segment' ) );
		$this->assertSame( 172, $this->read_private( $node, 'cursor_offset' ), 'cursor lands past the sacrificed head' );
		// And the disposal commits there, closing the sacrifice-to-next-arrival crash window: a
		// reboot inside it resumes past the suspect instead of producing a second DLQ entry.
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 172, $frame['offset'] );
		$this->assertSame( Remote_Consumer_Node::CRASH_MAX_ATTEMPTS, $frame['attempts'], 'crawl keeps its accounting pinned until it survives a clean interval' );

		$this->deliver( $sse, '7:172:40', '' ); // past the pin, flag cleared → forwards normally.
		$this->assertCount( 1, $spy->captured, 'the next message forwards normally' );
		$this->assertSame( 212, $this->read_private( $node, 'cursor_offset' ), 'and the cursor lands past it' );
		$this->assertSame( 1, $this->count_log_records( $this->dlq() ), 'only the head was dead-lettered' );
	}

	public function test_crawl_entry_disarms_without_sacrifice_when_first_message_past_pin(): void {
		// Stale suspect: the remote GC'd the suspect's segment (or the stream resumed beyond it),
		// so the first relayed crumb START is PAST the boot pin. The suspect no longer exists —
		// disarm WITHOUT sacrificing and forward the message normally. Only an exact match sacrifices.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, Remote_Consumer_Node::CRASH_MAX_ATTEMPTS, '' );

		Core::$now = 1000.0;
		[ , $node, $spy ] = $this->make_remote_spy();
		$node->fire_cb();
		$this->assertTrue( $this->read_private( $node, 'crawl_skip_head' ) );
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:500:40', '' ); // start PAST the {7,128} pin → stale suspect.

		$this->assertSame( 0, $this->count_log_records( $this->dlq() ), 'a past-the-pin message is not sacrificed' );
		$this->assertCount( 1, $spy->captured, 'and it forwards normally' );
		$this->assertFalse( $this->read_private( $node, 'crawl_skip_head' ), 'a stale suspect disarms the head sacrifice' );
	}

	public function test_crawl_does_not_exit_while_head_sacrifice_armed(): void {
		// The crawl-exit guard mirrors Consumer: an elapsed interval must NOT exit crawl while the
		// head sacrifice is still armed, or an un-sacrificed poison re-arms the crash loop next boot.
		// Only after the suspect is sacrificed (flag cleared) may an elapsed interval exit crawl.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, Remote_Consumer_Node::CRASH_MAX_ATTEMPTS, '' );

		Core::$now = 1000.0;
		[ , $node ] = $this->make_remote_spy();
		$node->fire_cb(); // restore → crawl, crawl_started = 1000, head-sacrifice armed.
		$sse = Core::node( 'remote-austin:sse-in' );

		// Interval elapsed, but a message with no usable breadcrumb keeps the flag armed.
		Core::$now = 1000.0 + Remote_Consumer_Node::CHECKPOINT_INTERVAL_S + 1.0;
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
		[ , $node ] = $this->make_remote_spy();
		$node->fire_cb(); // restore → attempts=1, boot cursor = {7,128}.
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver_built( $sse, $this->stop_message( '7:128:44' ) ); // deadline mid-forward on the boot message.
		$node->cooperative_stop( 'timeout', false );

		$this->assertSame( 0, $this->count_log_records( $this->dlq() ), 'below threshold → not quarantined' );
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 7, $frame['segment'] );
		$this->assertSame( 128, $frame['offset'], 'frozen at the poison message start (offset, not offset+length)' );
		$this->assertSame( 1, $frame['attempts'] );
		$this->assertSame( 'timeout', $frame['reason'] );
		// New-hazard guard: a below-threshold strike frame must carry NO quarantine marker, or the
		// successor would silently drop a message that still had fair shots left (data loss).
		$this->assertArrayNotHasKey( 'quarantined', $frame, 'a below-threshold strike is NOT a quarantine marker' );
	}

	public function test_cooperative_stop_at_threshold_quarantines_and_hands_off_past_it(): void {
		// At COOP_MAX the in-flight boot message is dead-lettered and the shutdown frame hands
		// off PAST it at the virgin baseline.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, Remote_Consumer_Node::COOP_MAX_ATTEMPTS - 1, 'timeout' );
		[ , $node ] = $this->make_remote_spy();
		$node->fire_cb(); // restore → attempts = COOP_MAX, boot = {7,128}.
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver_built( $sse, $this->stop_message( '7:128:44' ) ); // boot message, stopped mid-forward.
		$node->cooperative_stop( 'timeout', false );

		$this->assertSame( 1, $this->count_log_records( $this->dlq() ), 'quarantined at COOP_MAX' );
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 7, $frame['segment'] );
		$this->assertSame( 172, $frame['offset'], 'hands off PAST the quarantined message (128 + 44)' );
		$this->assertSame( 0, $frame['attempts'], 'clean handoff at the virgin baseline' );
	}

	public function test_cooperative_stop_clean_handoff_when_cursor_advanced(): void {
		// A stop AFTER the cursor advanced past boot is a normal recycle, not poison: clean
		// graceful handoff, no strike, no quarantine (EXACTLY Consumer).
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ , $node, $spy ] = $this->make_remote_spy();
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver_built( $sse, $this->healthy_message( '7:100:40' ) ); // forwards → cursor advances past boot.
		$this->deliver_built( $sse, $this->stop_message( '7:300:44' ) );    // a later stop.
		$node->cooperative_stop( 'timeout', false );

		$this->assertSame( 0, $this->count_log_records( $this->dlq() ), 'advanced cursor → no strike' );
		$this->assertCount( 1, $spy->captured );
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 300, $frame['offset'], 'graceful commit at the in-hand (stopped) message start' );
		$this->assertSame( 0, $frame['attempts'] );
		// Fair-shot absence: a routine cooperative stop is NEVER a quarantine — the successor
		// re-delivers the in-flight message (that re-delivery IS the fair shot).
		$this->assertArrayNotHasKey( 'quarantined', $frame, 'a routine cooperative stop writes no marker' );
	}

	public function test_assume_clean_shutdown_commits_past_the_stopped_message(): void {
		// With assume_clean_shutdown, a plain cooperative stop commits PAST the in-flight
		// message using the crumb's own LENGTH (seg:offset:length), so the restart resumes
		// after it and the hub isn't re-sent the already-written message. Contrast the
		// default, which commits at the message START and re-delivers it.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ , $node ] = $this->make_remote_spy();
		$node->set_assume_clean_shutdown( true );
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver_built( $sse, $this->stop_message( '7:300:44' ) ); // plain stop; crumb length 44.
		$node->cooperative_stop( 'timeout', false );

		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 344, $frame['offset'], 'commits past the message: start 300 + crumb length 44' );
		$this->assertSame( 0, $frame['attempts'], 'a clean-shutdown stop advances the cursor — no strike' );
	}

	public function test_assume_clean_shutdown_replays_a_stop_whose_downstream_flush_failed(): void {
		// A plain stop carrying a previous means the downstream write never landed, so
		// assume_clean_shutdown may not commit past it: the cursor stays at the message
		// START (300), and the stop escapes plain with the flush failure attached.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ , $node ] = $this->make_remote_spy();
		$node->set_assume_clean_shutdown( true );
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );

		$m                  = $this->stop_message( '7:300:44' );
		$m[ Message::KEY ]  = 'stop-flush-failed';
		$sse->process_sse_chunk( self::stream_frame( $m ) );
		try {
			$node->poll();
			$this->fail( 'expected Worker_Should_Stop' );
		} catch ( Worker_Should_Stop $e ) {
			$this->assertNotInstanceOf( \Newspack_Nodes\Worker_Should_Stop_Clean::class, $e, 'a failed flush never converts to clean' );
			$this->assertSame( 'segment write refused: ENOSPC', $e->getPrevious()?->getMessage() );
		}
		$node->cooperative_stop( 'timeout', false );

		$this->assertSame( 300, $this->newest_offsetlog_frame( $node )['offset'], 'replays from the message start, not past it' );
	}

	public function test_a_clean_stop_carrying_a_failure_replays_instead_of_committing_past(): void {
		// A Clean stop carrying a previous is not clean: the downstream write never
		// landed, so the cursor stays at the message START (300), not past it (344).
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ , $node ] = $this->make_remote_spy();
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );

		$m                 = $this->stop_message( '7:300:44' );
		$m[ Message::KEY ] = 'clean-flush-failed';
		$sse->process_sse_chunk( self::stream_frame( $m ) );
		try {
			$node->poll();
			$this->fail( 'expected Worker_Should_Stop' );
		} catch ( Worker_Should_Stop $e ) {
			$this->assertFalse( Worker_Should_Stop::is_clean( $e ), 'a failed flush is never clean' );
			$this->assertSame( 'segment write refused: EIO-63', $e->getPrevious()?->getMessage() );
		}
		$node->cooperative_stop( 'timeout', false );

		$this->assertSame( 300, $this->newest_offsetlog_frame( $node )['offset'], 'replays from the message start, not past it' );
	}

	public function test_a_clean_stop_in_crawl_commits_past_the_record(): void {
		// A clean stop says the record completed, crawl or not: the cursor
		// moves past it (300 + 44), exactly as a Consumer's drain does.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 0, Remote_Consumer_Node::CRASH_MAX_ATTEMPTS, '' );
		Core::$now = 1000.0;
		[ , $node ] = $this->make_remote_spy();
		$node->fire_cb(); // restore → crawl.
		$this->assertTrue( $this->read_private( $node, 'crawl' ) );
		$sse = Core::node( 'remote-austin:sse-in' );

		$m                 = $this->stop_message( '7:300:44' );
		$m[ Message::KEY ] = 'clean-bare';
		$sse->process_sse_chunk( self::stream_frame( $m ) );
		try {
			$node->poll();
			$this->fail( 'expected Worker_Should_Stop' );
		} catch ( Worker_Should_Stop $e ) {
			$this->assertTrue( Worker_Should_Stop::is_clean( $e ), 'a clean stop escapes clean in crawl' );
			$this->assertSame( 'clean stop 5146', $e->getMessage(), 'the stop raised is the one the sink threw' );
		}

		$this->assertSame( 344, $this->read_private( $node, 'cursor_offset' ), 'commits past the record' );
	}

	public function test_a_clean_stop_on_a_crumbless_record_escapes_clean_and_moves_the_cursor_by_nothing(): void {
		// A record with no breadcrumb has no position of its own, so committing
		// past it advances the cursor by nothing: the stop stays clean, and the
		// cursor stays at the prior record's end (140), where the spoke resumes.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ , $node ] = $this->make_remote_spy();
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:100:40', '' ); // healthy → cursor advances to 140.
		$m                 = $this->stop_message( '' );
		$m[ Message::KEY ] = 'clean-bare';
		$sse->process_sse_chunk( self::stream_frame( $m ) );
		try {
			$node->poll();
			$this->fail( 'expected Worker_Should_Stop' );
		} catch ( Worker_Should_Stop $e ) {
			$this->assertTrue( Worker_Should_Stop::is_clean( $e ), 'a clean stop is never rewritten' );
		}

		$this->assertSame( 140, $this->read_private( $node, 'cursor_offset' ), 'a crumbless record moves the cursor by nothing' );
		$this->assertStringNotContainsString( 'clean-bare', $this->read_private( $node, 'buffer' ), 'the completed line leaves the buffer' );
	}

	public function test_assume_clean_shutdown_does_not_advance_past_a_crumbless_message(): void {
		// A crumb-less message has no position of its own — the cursor stands PAST the prior
		// healthy record. assume_clean_shutdown commits past it by its crumb's length, which
		// is zero, never by the local line's bytes (prior_end + this_line_len would be a bogus
		// offset that misaligns the stream), so the cursor stays where it stands.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ , $node ] = $this->make_remote_spy();
		$node->set_assume_clean_shutdown( true );
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:100:40', '' );                  // healthy → cursor advances to 140.
		$this->deliver_built( $sse, $this->stop_message( '' ) ); // crumb-less stop.
		$node->cooperative_stop( 'timeout', false );

		$this->assertSame( 140, $this->newest_offsetlog_frame( $node )['offset'], 'a crumb-less stop moves the cursor by nothing' );
	}

	public function test_cooperative_stop_memory_watermark_exemption_does_not_strike(): void {
		// A memory stop with the fresh baseline already near the watermark blames a leak /
		// undersized limit, NOT the in-flight message: clean handoff, no strike (EXACTLY Consumer).
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, 0, '' ); // clean prior frame → resume attempts=1, boot={7,128}.
		[ , $node ] = $this->make_remote_spy();
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver_built( $sse, $this->stop_message( '7:128:44' ) ); // boot message, stopped mid-forward.
		$node->cooperative_stop( 'memory', true );

		$this->assertSame( 0, $this->count_log_records( $this->dlq() ), 'watermark exemption → not struck' );
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 128, $frame['offset'], 'graceful commit at the boot cursor' );
		$this->assertSame( 0, $frame['attempts'], 'clean handoff, no strike' );
	}

	public function test_the_cursor_lands_past_each_forwarded_message(): void {
		// The cursor names the next UNREAD byte, the same as Consumer's: a record's
		// own crumb gives its start and size, and forwarding it moves the cursor
		// past both. Pinned at the start instead, every resume re-delivers it.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ , $node, $spy ] = $this->make_remote_spy();
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:100:40', '' );
		$this->assertSame( 140, $this->read_private( $node, 'cursor_offset' ), 'past message N (100 + 40)' );

		$this->deliver( $sse, '7:140:30', '' );
		$this->assertSame( 170, $this->read_private( $node, 'cursor_offset' ), 'past N+1 (140 + 30)' );
		$this->assertCount( 2, $spy->captured );
	}

	public function test_reconnect_resumes_from_the_crumb_stamped_record_end(): void {
		// Resume at `crumb offset + crumb length` — exactly-once, no boot replay.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$captured_urls = [];
		\Newspack_Nodes\Event_Framework::$curl_dispatch = static function ( array $opts ) use ( &$captured_urls ): \CurlHandle {
			$captured_urls[] = Core::as_string( $opts[ \CURLOPT_URL ] );
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
		[ $broker, $node, $spy ] = $this->make_remote_spy();
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );

		// The stamp (999) is what the resume must honor — it is the on-disk record size.
		$sse->process_sse_chunk( self::stream_frame( [
			Message::TYPE  => Message::TM_STRUCT,
			Message::ID    => '7:200:999',
			Message::VALUE => [ 'p' => 1 ],
		] ) );
		$node->poll();
		$this->assertCount( 1, $spy->captured );

		// A reconnect: drop the handle, clear backoff, tick → maybe_connect rebuilds `positions`.
		$sse->disconnect();
		Core::$now = \microtime( true ) + 100;
		$broker->fire();
		$this->drain_connect_queue();

		$last_url = (string) \end( $captured_urls );
		\parse_str( (string) \parse_url( $last_url, \PHP_URL_QUERY ), $query );
		$positions = \json_decode( (string) ( $query['positions'] ?? '' ), true );
		$this->assertIsArray( $positions, 'the reconnect carries a positions param (not a boot replay)' );
		$this->assertSame(
			[ 'segment' => 7, 'offset' => 200 + 999 ],
			$positions['firehose.p0'] ?? null,
			'resume at the crumb-stamped record end, never a locally measured line length'
		);
		$this->assertCount( 1, $spy->captured, 'the reconnect itself re-forwards nothing' );
	}

	public function test_the_counter_counts_forwards_and_clean_stops_and_tracks_the_largest_line(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ , $node ] = $this->make_remote_spy();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:40:20', '' );
		$this->deliver( $sse, '7:100:40', '', [ 'pad' => \str_repeat( 'w', 333 ) ] );
		$m                 = $this->stop_message( '7:140:30' );
		$m[ Message::KEY ] = 'clean-bare';
		$this->deliver_built( $sse, $m );
		$this->deliver( $sse, '7:170:10', 'boom' );
		$node->fill( self::step_reply( 'remote-austin:firehose.p0', [], 0, 0 ) );

		$this->assertSame( 3, $node->counter(), 'two forwards and a clean stop; a throw and a reply count nothing' );
		$this->assertGreaterThan( 333, $node->largest_msg_sent(), 'the padded line is the largest' );
		$this->assertLessThan( 333 + 200, $node->largest_msg_sent(), 'measured as one line, not a sum' );
	}

	public function test_a_two_part_id_is_no_crumb(): void {
		// Every producer stamps seg:off:len; seg:off is only a viewer's lookup address.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ , $node, $spy ] = $this->make_remote_spy();
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );
		$node->next_offset( [ 'segment' => 3, 'offset' => 333 ] );

		$this->deliver( $sse, '7:200', '' );
		$this->deliver( $sse, '7::20', '' );

		$this->assertCount( 2, $spy->captured, 'the records still forward' );
		$this->assertSame( 3, $this->read_private( $node, 'cursor_segment' ) );
		$this->assertSame( 333, $this->read_private( $node, 'cursor_offset' ), 'but places nothing' );
	}

	public function test_relay_with_null_sink_fails_loud(): void {
		// A null/unwired downstream must FAIL LOUD — never silently no-op while the
		// stream is consumed (which would advance the cursor past undelivered messages).
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$broker = new Remote_Source_Node();
		$broker->name( 'remote-austin' );
		$broker->arguments( $this->remote_args() ); // no sink wired.
		$broker->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Remote_Consumer relay requires a wired sink' );
		$this->deliver( $sse, '7:1:20', '' ); // drain with a null sink → fail loud.
	}

	public function test_stream_data_relayed_downstream_not_to_http_out(): void {
		// Stream data flows via the reader's buffer → forward_line → downstream; it never
		// touches the outbound HTTP_Out path (that carries commands + the heartbeat only).
		// The reader forwards the spoke's trail unchanged.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ , $node, $spy ] = $this->make_remote_spy();
		$node->fire_cb();
		$http = Core::node( 'remote-austin:http-out' );
		$sse  = Core::node( 'remote-austin:sse-in' );

		$sse->process_sse_chunk( self::stream_frame( [
			Message::TYPE  => Message::TM_STRUCT,
			Message::FROM  => 'firehose.p0/job-worker.p0',
			Message::ID    => '7:1:20',
			Message::VALUE => [ 'p' => 1 ],
		] ) );
		$node->poll();

		$this->assertCount( 1, $spy->captured, 'stream data is relayed downstream' );
		$this->assertSame( 'firehose.p0/job-worker.p0', $spy->captured[0][ Message::FROM ] );
		$this->assertCount( 0, $this->read_private( $http, 'batch' ), 'stream data must NOT be misrouted to HTTP_Out' );
	}

	public function test_checkpoint_shutdown_commits_healthy_cursor(): void {
		// The worker's checkpoint sweep must commit the live cursor at shutdown — else
		// healthy progress is lost on every ~10-min recycle. The committed cursor is the
		// node-owned after-forward boundary (a forwarded message's END).
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ , $node ] = $this->make_remote_spy();
		$node->fire_cb();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->deliver( $sse, '9:512:40', '' ); // healthy forward → cursor lands past it.

		$node->checkpoint_shutdown();

		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 9, $frame['segment'] );
		$this->assertSame( 552, $frame['offset'], 'the handoff names the next unread record (512 + 40)' );
		$this->assertSame( 0, $frame['attempts'], 'a healthy shutdown is a clean handoff (attempts=0)' );
	}

	public function test_checkpoint_shutdown_commits_a_paused_seek_position(): void {
		// A paused time-travel SEEK sets the cursor + offset_set but leaves poll_initialized
		// false (no poll runs while paused). checkpoint_shutdown must still commit the seeked
		// position — guarding on poll_initialized ALONE silently drops it.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ , $node ] = $this->make_remote_spy();
		// No reader tick — a SEEK before the first poll, so poll_initialized stays false.
		$node->next_offset( [ 'segment' => 3, 'offset' => 256 ] );
		$this->assertFalse( $this->read_private( $node, 'poll_initialized' ), 'no poll ran' );
		$this->assertTrue( $this->read_private( $node, 'offset_set' ), 'the SEEK set the cursor explicitly' );

		$node->checkpoint_shutdown();

		$this->assertSame( 1, $this->count_offsetlog_records( $node ), 'the seeked position is committed at shutdown' );
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 3, $frame['segment'] );
		$this->assertSame( 256, $frame['offset'] );
	}

	public function test_an_unknown_generation_hands_off_no_frame(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ , $node ] = $this->make_remote();
		$node->next_offset( [ 'offset' => 1408 ] );

		$node->checkpoint_shutdown();

		$this->assertSame( 0, $this->count_offsetlog_records( $node ), 'segment 0 would name a foreign generation on restore' );
		$this->assertSame( [ 'offset' => 1408 ], $node->connect_position() );
	}

	// ---------------------------------------------------------------------
	// Restore, offsetlog sink, fire commits.
	// ---------------------------------------------------------------------

	public function test_committed_offsetlog_seeds_the_first_request(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );

		// Pre-seed the reader's offsetlog with a committed {seg,off} line.
		$dir = \Newspack_Nodes\Config::get_offsets_directory() . '/remote-austin/firehose.p0';
		\mkdir( $dir, 0755, true );
		$pre = new Partition_Node();
		$pre->name( 'preseed:offsetlog' );
		$pre->arguments( [ $dir ] );
		$entry                       = Message::new_message();
		$entry[ Message::TYPE ]      = Message::TM_STRUCT;
		$entry[ Message::VALUE ]     = [ 'segment' => 4, 'offset' => 256, '_ts' => 123 ];
		$pre->fill( $entry );
		$pre->flush();

		$asked = [];
		$this->capture_asked_positions( $asked );
		$this->make_remote();
		Core::$now = 1000.0;
		// No reader tick yet: the connect itself restores the cursor it states.
		$this->drain_connect_queue();

		$this->assertSame( [ [ 'segment' => 4, 'offset' => 256 ] ], $asked );
	}

	public function test_offsetlog_inherits_its_patrons_sink(): void {
		// A sidecar sinks where its patron sinks. make_node sinks every node into
		// _command_interpreter and flow is steered by target(), so inheriting the
		// patron's sink IS how the offsetlog's replies reach the interpreter.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ , $node ] = $this->make_remote_spy();
		$node->fire_cb();

		$offsetlog = $this->read_private( $node, 'offsetlog' );
		$this->assertInstanceOf( Partition_Node::class, $offsetlog );
		$this->assertSame( $node->sink(), $offsetlog->sink() );
	}

	public function test_fire_commits_node_cursor(): void {
		// The throttled per-tick checkpoint commits the node-owned after-forward cursor
		// (a forwarded message's END), not SSE_In's connection position.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ , $node ] = $this->make_remote_spy();
		$node->fire_cb();

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->deliver( $sse, '7:99:40', '' ); // healthy forward → cursor lands PAST it (99 + 40).

		// Advance clock past the commit interval and tick again.
		Core::$now = \microtime( true ) + 100;
		$node->fire_cb();

		$value = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 7, $value['segment'] );
		$this->assertSame( 139, $value['offset'] );
	}

	public function test_throttled_checkpoint_does_not_recommit_an_unchanged_position(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ , $node ] = $this->make_remote_spy();
		$node->fire_cb();

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->deliver( $sse, '5:5:40', '' ); // healthy forward advances the node cursor.
		Core::$now = \microtime( true ) + 100;
		$node->fire_cb(); // commits the moved cursor
		$baseline = $this->count_offsetlog_records( $node );
		$this->assertGreaterThanOrEqual( 1, $baseline, 'a moved cursor is committed' );

		// Idle stream: no new message, the node cursor is unchanged, another interval elapses.
		Core::$now = \microtime( true ) + 200;
		$node->fire_cb();
		$this->assertSame( $baseline, $this->count_offsetlog_records( $node ), 'an unchanged node cursor must not spam a duplicate keyframe (advance-guard, matching Consumer)' );
	}

	public function test_restore_position_raises_an_unparseable_offsetlog_entry(): void {
		// A junk final frame leaves the committed cursor unknown, so the restore
		// raises rather than connecting from the default position.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->seed_offsetlog_file( "this is not a packed message\n" );

		[ , $node ] = $this->make_remote();

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'this is not a packed message' );
		$node->fire_cb();
	}

	public function test_restore_position_ignores_non_array_value(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = 'scalar-not-a-cursor';
		$this->seed_offsetlog_file( Message::packed( $message ) . "\n" );

		[ , $node ] = $this->make_remote();
		$node->fire_cb();

		$this->assertSame( Consumer_Node::SEEK_END, $node->connect_position(), 'nothing restored asks for the end' );
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

		[ , $node ] = $this->make_remote();
		$node->fire_cb();

		$this->assertSame( [ 'segment' => 4, 'offset' => 256 ], $node->connect_position() );
	}

	public function test_restore_position_returns_empty_when_all_segments_empty(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		// Both the tail and the prior segment are empty — nothing to restore.
		$this->seed_offsetlog_file( '', 0 );
		$this->seed_offsetlog_file( '', 1 );

		[ , $node ] = $this->make_remote();
		$node->fire_cb();

		$this->assertSame( Consumer_Node::SEEK_END, $node->connect_position(), 'nothing restored asks for the end' );
	}

	// ---------------------------------------------------------------------
	// Schema, DLQ triage.
	// ---------------------------------------------------------------------

	public function test_node_schema_is_hidden_with_the_reader_args_and_verbs(): void {
		$schema = Remote_Consumer_Node::node_schema();
		$this->assertTrue( $schema['hidden'] );
		$this->assertSame( [ 'stamp', 'offsetlog_dir', 'deadletter_dir' ], \array_column( $schema['arguments'], 'name' ) );
		$verbs = \array_column( $schema['commands'], 'name' );
		foreach ( [ 'dl_list', 'dl_show', 'dl_requeue', 'dl_purge', 'add_snapshot_node', 'set_line_mode', 'seek_frame', 'pause', 'play', 'step', 'assume_clean_shutdown' ] as $verb ) {
			$this->assertContains( $verb, $verbs );
		}
	}

	public function test_list_and_purge_operate_on_the_readers_sidecar(): void {
		[ , $node ] = $this->make_remote();
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'remote-poison';
		$message[ Message::ID ]    = '7:12:30';
		( new \ReflectionMethod( Remote_Consumer_Node::class, 'dead_letter' ) )->invoke( $node, $message, 'timeout', null );

		$page = $node->list_deadletter( 50 );
		$this->assertSame( 1, $page['total'] );
		$this->assertSame( 'timeout', $page['rows'][0]['reason'] );
		$this->assertSame( '7:12:30', $page['rows'][0]['source'] );

		$this->assertStringStartsWith( 'ok', $node->purge_deadletter() );
		$this->assertSame( 0, $node->list_deadletter( 50 )['total'] );
	}

	/**
	 * Delivering rather than re-injecting gives a remote pull a working
	 * requeue: it has no local source log to append to, but it has a sink.
	 */
	public function test_requeue_redelivers_for_a_remote_reader(): void {
		[ , $node, $sink ] = $this->make_remote();
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'remote-retry';
		$message[ Message::ID ]    = '7:12:30';
		( new \ReflectionMethod( Remote_Consumer_Node::class, 'dead_letter' ) )->invoke( $node, $message, 'timeout', null );

		$loc = $node->list_deadletter( 50 )['rows'][0]['locator'];

		$this->assertStringStartsWith( 'ok', $node->requeue_deadletter( $loc ) );
		$this->assertSame( [ 'remote-retry' ], \array_column( $sink->captured, Message::VALUE ) );
	}

	// ---------------------------------------------------------------------
	// A paused step asks the spoke over the broker's HTTP_Out.
	// ---------------------------------------------------------------------

	/**
	 * The spoke's answer to one step, as HTTP_Out delivers it, echoing the
	 * arguments it answers as `interpret()` does: the stamp and `$asked`.
	 */
	private static function step_reply( string $to, array $record, int $segment, int $offset, string $asked = '31:4404', string $stamp = 'firehose.p0' ): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$m[ Message::TO ]    = $to;
		$m[ Message::VALUE ] = [
			'name'      => 'read_message',
			'arguments' => [ $stamp, $asked ],
			'payload'   => [ 'source' => $stamp, 'message' => $record, 'cursor' => [ 'segment' => $segment, 'offset' => $offset ], 'at_eof' => false ],
		];
		return $m;
	}

	public function test_a_paused_step_asks_the_spoke_for_the_record_at_the_cursor(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $broker, $node ] = $this->make_remote();
		$http = Core::node( 'remote-austin:http-out' );
		$node->next_offset( [ 'segment' => 31, 'offset' => 4404 ] );
		$node->pause();

		$node->step();

		$batch = $this->read_private( $http, 'batch' );
		$sent  = \end( $batch );
		$this->assertSame( Message::TM_COMMAND, $sent[ Message::TYPE ] );
		$this->assertSame( 'remote-austin:firehose.p0', $sent[ Message::FROM ] );
		$this->assertSame( 'raw-logs', $sent[ Message::TO ] );
		$this->assertSame( [ 'name' => 'read_message', 'arguments' => [ 'firehose.p0', '31:4404' ] ], \array_intersect_key( $sent[ Message::VALUE ], [ 'name' => 1, 'arguments' => 1 ] ) );
		$this->assertTrue( $http->admit_addressed( self::step_reply( 'remote-austin:firehose.p0', [], 0, 0 ) ), 'the reply route is declared' );
	}

	public function test_a_step_without_a_session_asks_for_one_and_retries(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		Command_Auth::forget_session( 'austin' );
		[ $broker, $node ] = $this->make_remote();
		$http = Core::node( 'remote-austin:http-out' );
		$node->pause();

		$node->step();
		$this->assertSame( [], $this->read_private( $http, 'batch' ), 'nothing unsigned goes out' );
		$this->assertSame( 1, $this->read_private( $node, 'steps_owed' ) );

		Command_Auth::remember_session( 'austin', \str_repeat( 'c', 32 ), 'spoke-session-key' );
		$node->fire_cb();
		$batch = $this->read_private( $http, 'batch' );
		$this->assertSame( 'read_message', \end( $batch )[ Message::VALUE ]['name'] );
	}

	public function test_a_file_reader_with_an_unknown_generation_steps_at_its_offset(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->make_remote( 'remote-austin', $this->remote_args( 'remote-austin', 'austin', 'sources/php:downstream' ) );
		$node = Core::node( 'remote-austin:sources:php' );
		$http = Core::node( 'remote-austin:http-out' );
		$node->next_offset( [ 'segment' => 31, 'offset' => 4404 ] );
		$node->next_offset( [ 'offset' => 3307 ] );
		$node->pause();

		$node->step();
		$batch = $this->read_private( $http, 'batch' );
		$this->assertSame( [ 'sources/php', ':3307' ], \end( $batch )[ Message::VALUE ]['arguments'], 'the offset alone, never segment 0' );

		$node->fill( self::empty_step_reply( 'remote-austin:sources:php', 918273, 3307, ':3307', 'sources/php' ) );
		$this->assertSame( [ 'segment' => 918273, 'offset' => 3307 ], $node->connect_position(), 'the reply names the generation' );
	}

	/** A packed-able bytestream record the spoke read at `$crumb`. */
	private static function stepped_record( string $crumb, string $value ): array {
		$record                   = Message::new_message();
		$record[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$record[ Message::FROM ]  = 'firehose.p0';
		$record[ Message::ID ]    = $crumb;
		$record[ Message::VALUE ] = $value;
		return $record;
	}

	/** The spoke's no-record answer: `message: null`, with where its reader stopped. */
	private static function empty_step_reply( string $to, int $segment, int $offset, string $asked = '31:4404', string $stamp = 'firehose.p0' ): array {
		$m = self::step_reply( $to, [], $segment, $offset, $asked, $stamp );
		$m[ Message::VALUE ]['payload']['message'] = null;
		$m[ Message::VALUE ]['payload']['at_eof']  = true;
		return $m;
	}

	/** A reader paused at 31:4404 with one step out and owed. */
	private function stepping_reader( ?array $args = null ): array {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $broker, $node, $sink ] = $this->make_remote( 'remote-austin', $args );
		$node->next_offset( [ 'segment' => 31, 'offset' => 4404 ] );
		$node->pause();
		$node->step();
		return [ $broker, $node, $sink ];
	}

	public function test_a_step_reply_forwards_its_record_and_takes_its_cursor(): void {
		[ , $node, $sink ] = $this->stepping_reader();

		$node->fill( self::step_reply( 'remote-austin:firehose.p0', self::stepped_record( '31:4404:61', 'stepped-8820' ), 31, 4465 ) );

		$this->assertSame( [ 'stepped-8820' ], \array_column( $sink->captured, Message::VALUE ) );
		$this->assertSame( 'firehose.p0', $sink->captured[0][ Message::FROM ], 'a step relays the spoke\'s trail unchanged' );
		$this->assertSame( [ 'segment' => 31, 'offset' => 4465 ], $node->connect_position() );
		$this->assertSame( 'PAUSED', $node->get_state( 'POLLING' ), 'a step stays paused' );
		$this->assertSame( 0, $this->read_private( $node, 'steps_owed' ) );
		$this->assertNull( $this->read_private( $node, 'step_requested_at' ) );
	}

	public function test_a_step_reply_places_a_crumbless_record_at_the_spokes_cursor(): void {
		[ , $node, $sink ] = $this->stepping_reader();

		$node->fill( self::step_reply( 'remote-austin:firehose.p0', self::stepped_record( 'no-crumb-7', 'bare-2290' ), 31, 5120 ) );

		$this->assertSame( [ 'bare-2290' ], \array_column( $sink->captured, Message::VALUE ) );
		$this->assertSame( [ 'segment' => 31, 'offset' => 5120 ], $node->connect_position(), 'the reply names where the next step resumes' );
	}

	public function test_a_step_reply_landing_after_play_is_ignored(): void {
		[ , $node, $sink ] = $this->stepping_reader();
		$node->play();

		$node->fill( self::step_reply( 'remote-austin:firehose.p0', self::stepped_record( '31:4404:61', 'stale-3301' ), 31, 4465 ) );

		$this->assertSame( [], $sink->captured );
		$this->assertSame( 0, $node->buffered_bytes(), 'nothing is held for the live stream to replay' );
		$this->assertSame( [ 'segment' => 31, 'offset' => 4404 ], $node->connect_position() );
		$this->assertNull( $this->read_private( $node, 'step_requested_at' ), 'even a stale reply settles the request' );
	}

	public function test_a_step_reply_a_paused_seek_abandoned_is_ignored(): void {
		[ , $node, $sink ] = $this->stepping_reader();
		$node->next_offset( [ 'segment' => 44, 'offset' => 1707 ] );

		$node->fill( self::step_reply( 'remote-austin:firehose.p0', self::stepped_record( '31:4404:61', 'abandoned-6614' ), 31, 4465 ) );

		$this->assertSame( [], $sink->captured );
		$this->assertSame( [ 'segment' => 44, 'offset' => 1707 ], $node->connect_position() );
	}

	public function test_a_step_finding_no_record_owes_nothing_and_takes_the_cursor(): void {
		[ , $node, $sink ] = $this->stepping_reader();
		$node->step();

		$node->fill( self::empty_step_reply( 'remote-austin:firehose.p0', 31, 4511 ) );

		$this->assertSame( [], $sink->captured );
		$this->assertSame( 0, $this->read_private( $node, 'steps_owed' ) );
		$this->assertNull( $this->read_private( $node, 'step_requested_at' ) );
		$this->assertSame( [ 'segment' => 31, 'offset' => 4511 ], $node->connect_position(), 'a line the spoke consumed moves the cursor' );
		$this->assertSame( 'PAUSED', $node->get_state( 'POLLING' ) );
	}

	public function test_a_step_reply_cursor_answers_a_pending_seek(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ , $node ] = $this->make_remote();
		$node->pause();
		$node->next_offset( 'recent' );
		$node->step();

		$node->fill( self::empty_step_reply( 'remote-austin:firehose.p0', 31, 4511, 'recent' ) );

		$this->assertSame( [ 'segment' => 31, 'offset' => 4511 ], $node->connect_position(), 'a real place supersedes the seek' );
	}

	public function test_a_refused_step_owes_nothing_and_logs_once(): void {
		[ , $node, $sink ] = $this->stepping_reader();
		$refusal                   = Message::new_message();
		$refusal[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_ERROR;
		$refusal[ Message::TO ]    = 'remote-austin:firehose.p0';
		$refusal[ Message::VALUE ] = [ 'name' => 'read_message', 'arguments' => [ 'firehose.p0', '31:4404' ], 'payload' => "read_message: invalid position 9137\n" ];

		$node->fill( $refusal );
		$node->step();
		$node->fill( $refusal );

		$this->assertSame( [], $sink->captured );
		$this->assertSame( 0, $this->read_private( $node, 'steps_owed' ) );
		$this->assertNull( $this->read_private( $node, 'step_requested_at' ) );
		$this->assertSame( [ 'segment' => 31, 'offset' => 4404 ], $node->connect_position() );
		$log = \implode( '', Core::$recent_log );
		$this->assertStringContainsString( 'read_message: invalid position 9137', $log );
		$this->assertSame( 1, \substr_count( $log, 'invalid position 9137' ), 'rate-limited' );
	}

	public function test_an_older_spokes_string_answer_is_a_refusal(): void {
		[ , $node, $sink ] = $this->stepping_reader();
		$answer                   = Message::new_message();
		$answer[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$answer[ Message::TO ]    = 'remote-austin:firehose.p0';
		$answer[ Message::VALUE ] = [ 'name' => 'read_message', 'arguments' => [ 'firehose.p0', '31:4404' ], 'payload' => "read_message: no record at firehose.p0 31:4404-5582\n" ];

		$node->fill( $answer );

		$this->assertSame( [], $sink->captured );
		$this->assertSame( 0, $this->read_private( $node, 'steps_owed' ) );
		$this->assertNull( $this->read_private( $node, 'step_requested_at' ) );
		$this->assertSame( [ 'segment' => 31, 'offset' => 4404 ], $node->connect_position() );
		$this->assertStringContainsString( 'no record at firehose.p0 31:4404-5582', \implode( '', Core::$recent_log ) );
	}

	public function test_a_bounce_of_a_stepped_record_is_no_step_reply(): void {
		[ , $node ] = $this->stepping_reader( $this->remote_args( 'remote-austin', 'austin', 'firehose.p0:nowhere-6120' ) );

		$node->fill( self::step_reply( 'remote-austin:firehose.p0', self::stepped_record( '31:4404:61', 'unrouted-4173' ), 31, 4465 ) );

		$this->assertSame( 0, $this->read_private( $node, 'steps_owed' ), 'the Router bounce settles nothing' );
		$this->assertSame( [ 'segment' => 31, 'offset' => 4465 ], $node->connect_position() );
	}

	public function test_a_router_bounce_leaves_the_step_in_flight(): void {
		[ , $node ] = $this->stepping_reader();
		$http       = Core::node( 'remote-austin:http-out' );
		$bounce                    = Message::new_message();
		$bounce[ Message::TYPE ]   = Message::TM_ERROR;
		$bounce[ Message::FROM ]   = 'nowhere-6120';
		$bounce[ Message::TO ]     = 'remote-austin:firehose.p0';
		$bounce[ Message::VALUE ]  = "NOT_AVAILABLE\n";

		$node->fill( $bounce );
		$node->fire_cb();

		$this->assertCount( 1, $this->read_private( $http, 'batch' ), 'a bounce answers no step, so none is sent again' );
		$this->assertSame( 1, $this->read_private( $node, 'steps_owed' ) );
	}

	public function test_line_mode_turned_off_before_the_reply_sends_no_second_request(): void {
		[ , $node, $sink ] = $this->stepping_reader();
		$http               = Core::node( 'remote-austin:http-out' );
		$node->set_line_mode( false );

		$node->fill( self::step_reply( 'remote-austin:firehose.p0', self::stepped_record( '31:4404:61', 'stepped-5531' ), 31, 4465 ) );

		$this->assertSame( [ 'stepped-5531' ], \array_column( $sink->captured, Message::VALUE ) );
		$this->assertCount( 1, $this->read_private( $http, 'batch' ), 'the consumed reply asks for nothing more' );
		$this->assertNull( $this->read_private( $node, 'step_requested_at' ), 'the reply settled the request' );
	}

	public function test_a_message_that_is_no_command_reply_settles_no_step(): void {
		[ , $node, $sink ] = $this->stepping_reader();
		$echo                     = self::step_reply( 'remote-austin:firehose.p0', self::stepped_record( '31:4404:61', 'forged-5124' ), 31, 4465 );
		$echo[ Message::TYPE ]    = Message::TM_STRUCT;

		$node->fill( $echo );

		$this->assertSame( [], $sink->captured, 'only a command reply answers a step' );
		$this->assertSame( 1, $this->read_private( $node, 'steps_owed' ) );
	}

	public function test_a_late_reply_to_a_superseded_step_leaves_the_new_step_in_flight(): void {
		[ , $node ] = $this->stepping_reader();
		$http       = Core::node( 'remote-austin:http-out' );
		$node->next_offset( [ 'segment' => 52, 'offset' => 7781 ] );
		$node->step();
		$this->assertCount( 2, $this->read_private( $http, 'batch' ), 'the seek\'s own step went out' );

		$node->fill( self::step_reply( 'remote-austin:firehose.p0', self::stepped_record( '31:4404:61', 'late-3307' ), 31, 4465 ) );
		$node->fire_cb();

		$this->assertCount( 2, $this->read_private( $http, 'batch' ), 'a stale answer settles nothing, so nothing is sent again' );
	}

	public function test_a_step_whose_reply_never_comes_is_sent_again_after_the_request_timeout(): void {
		[ , $node ] = $this->stepping_reader();
		$http = Core::node( 'remote-austin:http-out' );
		$this->assertCount( 1, $this->read_private( $http, 'batch' ) );

		Core::$now += \Newspack_Nodes\HTTP_Out_Node::REQUEST_TIMEOUT - 1;
		$node->fire_cb();
		$this->assertCount( 1, $this->read_private( $http, 'batch' ), 'not before the timeout' );

		Core::$now += 1;
		$node->fire_cb();
		$batch = $this->read_private( $http, 'batch' );
		$this->assertCount( 2, $batch, 'the lost request goes out again' );
		$this->assertSame( [ 'firehose.p0', '31:4404' ], \end( $batch )[ Message::VALUE ]['arguments'] );
	}

	public function test_a_step_lost_to_an_expired_session_asks_for_one_on_the_retry(): void {
		[ , $node ] = $this->stepping_reader();
		$captured = [];
		\Newspack_Nodes\Event_Framework::$curl_dispatch = function ( array $opts ) use ( &$captured ): \CurlHandle {
			$captured[] = $opts;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
		// HTTP_Out forgets the session on a 401, and its reply never comes.
		Command_Auth::forget_session( 'austin' );

		Core::$now = self::link_second( Core::$now + \Newspack_Nodes\HTTP_Out_Node::REQUEST_TIMEOUT + 4 );
		$node->fire_cb();

		$urls = \array_map( static fn ( array $opts ): string => (string) $opts[ \CURLOPT_URL ], $captured );
		$this->assertContains( 'https://austin.example/wp-json/newspack-nodes/v1/auth', $urls );
	}

	/** A step with no session asks for one on its link's second of the cadence, never on every tick. */
	public function test_a_step_without_a_session_asks_on_its_links_cadence(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		Command_Auth::forget_session( 'austin' );
		[ , $node ] = $this->make_remote();
		$auths = 0;
		Event_Framework::$curl_dispatch = static function ( array $opts ) use ( &$auths ): \CurlHandle {
			$auths += (int) \str_ends_with( (string) $opts[ \CURLOPT_URL ], '/auth' );
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
		$node->pause();
		$on_cadence = self::link_second( 9000.0 );
		Core::$now  = $on_cadence - 1;

		$node->step();
		$this->assertSame( 0, $auths, 'off its second, the step asks for nothing' );

		Core::$now = $on_cadence;
		$node->fire_cb();
		$this->assertSame( 1, $auths, 'on its second, the retried step asks' );
	}

	/** The first wall-second at or after `$from` on which `remote-austin` asks for a session. */
	private static function link_second( float $from ): float {
		$interval = \Newspack_Nodes\Remote_Link_Node::HEARTBEAT_INTERVAL;
		$at       = (int) \ceil( $from );
		return (float) ( $at + ( ( \crc32( 'remote-austin' ) % $interval ) - $at % $interval + $interval ) % $interval );
	}

	public function test_a_seek_then_a_step_ignores_the_old_reply_and_sends_the_new_one(): void {
		[ , $node, $sink ] = $this->stepping_reader();
		$http = Core::node( 'remote-austin:http-out' );
		$node->next_offset( [ 'segment' => 44, 'offset' => 1707 ] );

		$node->step();
		$batch = $this->read_private( $http, 'batch' );
		$this->assertSame( [ 'firehose.p0', '44:1707' ], \end( $batch )[ Message::VALUE ]['arguments'], 'a seek frees the next step to go out at once' );

		$node->fill( self::step_reply( 'remote-austin:firehose.p0', self::stepped_record( '31:4404:61', 'superseded-9046' ), 31, 4465 ) );

		$this->assertSame( [], $sink->captured );
		$this->assertSame( [ 'segment' => 44, 'offset' => 1707 ], $node->connect_position() );
		$this->assertSame( 1, $this->read_private( $node, 'steps_owed' ), 'the new step is still owed' );
	}

	public function test_a_pending_end_seek_steps_with_end(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ , $node ] = $this->make_remote();
		$http = Core::node( 'remote-austin:http-out' );
		$node->next_offset( [ 'segment' => 31, 'offset' => 4404 ] );
		$node->pause();
		$node->next_offset( 'end' );

		$node->step();

		$batch = $this->read_private( $http, 'batch' );
		$this->assertSame( [ 'firehose.p0', 'end' ], \end( $batch )[ Message::VALUE ]['arguments'] );
	}

	public function test_renaming_the_broker_moves_children_and_their_reply_route(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $broker, $node ] = $this->make_remote();

		$broker->name( 'remote-quoll' );

		$this->assertSame( $node, Core::node( 'remote-quoll:firehose.p0' ) );
		$this->assertSame( 'remote-quoll:firehose.p0:offsetlog', $this->read_private( $node, 'offsetlog' )->name() );
		$this->assertTrue( Core::node( 'remote-quoll:http-out' )->admit_addressed( self::step_reply( 'remote-quoll:firehose.p0', [], 0, 0 ) ) );
	}

	// ---------------------------------------------------------------------
	// Helpers.
	// ---------------------------------------------------------------------

	/** The default reader's dead-letter dir. */
	private function dlq(): string {
		return \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin/firehose.p0';
	}

	/**
	 * Push one TM_STRUCT stream message through the SSE_In parser (keyed `boom` to poison the
	 * relay), then drive one reader tick to drain it (crawl caps drain at one line per poll —
	 * one poll per delivered line).
	 */
	private function deliver( SSE_In_Node $sse, string $id, string $key = '', array $value = [ 'p' => 1 ] ): void {
		$sse->process_sse_chunk( self::stream_msg( $id, $key, $value ) );
		$patron = $sse->patron();
		if ( $patron instanceof Remote_Source_Node ) {
			Core::node( $patron->name() . ':firehose.p0' )->poll();
		}
	}

	/**
	 * Deliver a pre-built message, then drive one reader tick — swallowing the Worker_Should_Stop a
	 * `stop`-keyed one raises when the tick dispatches it (it propagates up like the real drain
	 * loop; the worker then routes to cooperative_stop).
	 */
	private function deliver_built( SSE_In_Node $sse, array $m ): void {
		$sse->process_sse_chunk( self::stream_frame( $m ) );
		$patron = $sse->patron();
		try {
			if ( $patron instanceof Remote_Source_Node ) {
				Core::node( $patron->name() . ':firehose.p0' )->poll();
			}
		} catch ( Worker_Should_Stop $e ) {
			// Expected for a `stop`-keyed message.
		}
	}

	/** A TM_STRUCT stream message keyed `stop` (downstream raises Worker_Should_Stop on it). */
	private function stop_message( string $id ): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::FROM ]  = 'firehose.p0';
		$m[ Message::ID ]    = $id;
		$m[ Message::KEY ]   = 'stop';
		$m[ Message::VALUE ] = [ 'p' => 1 ];
		return $m;
	}

	/** A healthy TM_STRUCT stream message (forwards cleanly). */
	private function healthy_message( string $id ): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::FROM ]  = 'firehose.p0';
		$m[ Message::ID ]    = $id;
		$m[ Message::KEY ]   = '';
		$m[ Message::VALUE ] = [ 'p' => 1 ];
		return $m;
	}

	/** Write a single committed offsetlog frame (with attempt accounting) for the default reader. */
	private function seed_offsetlog_frame( int $segment, int $offset, int $attempts, string $reason, string $name = 'remote-austin', bool $quarantined = false ): void {
		$dir = \Newspack_Nodes\Config::get_offsets_directory() . "/{$name}/firehose.p0";
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

	/** Write a raw offsetlog segment file (`<seg>.log`) for the default reader. */
	private function seed_offsetlog_file( string $contents, int $segment_id = 0 ): void {
		$dir = \Newspack_Nodes\Config::get_offsets_directory() . '/remote-austin/firehose.p0';
		if ( ! \is_dir( $dir ) ) {
			\mkdir( $dir, 0755, true );
		}
		\file_put_contents( "{$dir}/{$segment_id}.log", $contents );
	}

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
