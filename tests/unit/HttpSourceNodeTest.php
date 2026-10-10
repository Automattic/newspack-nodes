<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\HTTP_Source_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Remote_Broker_Node;
use Newspack_Nodes\Remote_Consumer_Node;
use Newspack_Nodes\Remote_Source_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Vault;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

/**
 * The HTTP-pull broker: `Remote_Source`'s pairs and readers over the command
 * channel alone, with no SSE slot and no heartbeat, a reply cap sized to its
 * readers, and the status snapshot under the broker's key.
 */
#[CoversClass( HTTP_Source_Node::class )]
#[CoversClass( Remote_Consumer_Node::class )]
class HttpSourceNodeTest extends TestCase {

	private string $base_dir = '';

	protected function setUp(): void {
		parent::setUp();
		$this->base_dir = $this->make_temp_dir();
		$this->use_base_dir( $this->base_dir );
		Core::$memd             = new InMemoryMemcached();
		Core::$var['partition'] = '0';
		// A live graph always has _router: the readers route through it.
		( new Router_Node() )->name( '_router' );
		Core::$now = 500.0;
	}

	protected function tearDown(): void {
		unset( Core::$var['partition'] );
		Command_Auth::forget_session( 'austin' );
		Core::$memd                    = null;
		Event_Framework::$curl_dispatch = null;
		Event_Framework::reset();
		Remote_Source_Node::reset_connect_queue();
		Vault::get_instance()->reset_cache();
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	protected function seed_vault( string $id, array $entry ): void {
		// A spoke that can be sent to has authed; a read signs for it.
		Command_Auth::remember_session( $id, \str_repeat( 'b', 32 ), 'spoke-session-key' );
		parent::seed_vault( $id, $entry );
	}

	/** @return list<string> Broker tokens: vault, the two roots, then one pair per argument. */
	private function remote_args( string $name = 'pull-austin', string $vault = 'austin', string ...$pairs ): array {
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		return [ $vault, "{$offsets}/{$name}", "{$base}/deadletter/{$name}", ...( [] === $pairs ? [ 'firehose.p0:downstream' ] : $pairs ) ];
	}

	/** A named broker sinking into _router, its first tick not yet run. */
	private function broker( string $name = 'pull-austin', ?array $args = null ): HTTP_Source_Node {
		$node = new HTTP_Source_Node();
		$node->name( $name );
		$node->sink( Core::node( '_router' ) );
		$node->arguments( $args ?? $this->remote_args( $name ) );
		return $node;
	}

	/**
	 * The broker's readers, read off its sibling map and keyed by stamp.
	 *
	 * @return array<string,Remote_Consumer_Node>
	 */
	private function readers( Remote_Broker_Node $node ): array {
		$readers = [];
		foreach ( ( new \ReflectionMethod( $node, 'siblings' ) )->invoke( $node ) as $sibling ) {
			if ( $sibling instanceof Remote_Consumer_Node ) {
				$readers[ $sibling->stamp() ] = $sibling;
			}
		}
		return $readers;
	}

	private function seed_austin(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
	}

	/**
	 * A live reader of `firehose.p0` standing at 31:4404, its broker ticked once.
	 *
	 * @return array{0:HTTP_Source_Node,1:Remote_Consumer_Node,2:Capture_Sink_Node,3:HTTP_Out_Node}
	 */
	private function fetching_reader(): array {
		$this->seed_austin();
		$sink = new Capture_Sink_Node();
		$sink->name( 'downstream' );
		$node = $this->broker( 'pull-austin' );
		$node->fire();
		$reader = Core::node( 'pull-austin:firehose.p0' );
		$reader->next_offset( [ 'segment' => 31, 'offset' => 4404 ] );
		return [ $node, $reader, $sink, Core::node( 'pull-austin:http-out' ) ];
	}

	/** @return list<list<string>> The read_block commands queued on the patron, by their arguments. */
	private function fetches( HTTP_Out_Node $http ): array {
		$asked = [];
		foreach ( $this->read_private( $http, 'batch' ) as $m ) {
			if ( 'read_block' === $m[ Message::VALUE ]['name'] ) {
				$asked[] = $m[ Message::VALUE ]['arguments'];
			}
		}
		return $asked;
	}

	/** @return list<string> The arguments of the last read_block queued. */
	private function last_fetch( HTTP_Out_Node $http ): array {
		return \array_slice( $this->fetches( $http ), -1 )[0];
	}

	/** @return list<string> The arguments of the last read_block a stamp's reader asked. */
	private function last_fetch_of( HTTP_Out_Node $http, string $stamp ): array {
		return \array_slice( \array_filter( $this->fetches( $http ), static fn ( array $a ): bool => $stamp === $a[0] ), -1 )[0];
	}

	/** A spoke's read_block answer, echoing `$asked`. */
	private static function block_reply( array $asked, array $records, int $segment, int $offset, bool $at_eof, int $skipped = 0 ): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$m[ Message::TO ]    = 'pull-austin:firehose.p0';
		$m[ Message::VALUE ] = [
			'name'      => 'read_block',
			'arguments' => $asked,
			'payload'   => [ 'source' => $asked[0], 'messages' => $records, 'cursor' => [ 'segment' => $segment, 'offset' => $offset ], 'at_eof' => $at_eof, 'unparseable_lines' => $skipped ],
		];
		return $m;
	}

	/** A bytestream record the spoke read at `$crumb`. */
	private static function record_at( string $crumb, string $value ): array {
		$r                   = Message::new_message();
		$r[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$r[ Message::FROM ]  = 'firehose.p0';
		$r[ Message::ID ]    = $crumb;
		$r[ Message::VALUE ] = $value;
		return $r;
	}

	/** The status snapshot the broker last wrote. */
	private function snapshot(): array {
		return Core::$memd->get( HTTP_Source_Node::status_key_for( 'pull-austin', 0 ) );
	}

	/** A spoke's `list_logs` answer: one available row per key, as `Raw_Logs_CI_Node` writes it. */
	private static function catalog_reply( array $keys ): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$m[ Message::TO ]    = 'pull-austin';
		$m[ Message::VALUE ] = [
			'name'      => 'list_logs',
			'arguments' => [],
			'payload'   => \array_map( static fn ( string $k ): array => [ 'key' => $k, 'label' => $k, 'available' => true ], $keys ),
		];
		return $m;
	}

	/** @return list<array<int,mixed>> The list_logs commands queued on the patron. */
	private function catalog_asks( HTTP_Out_Node $http ): array {
		return \array_values( \array_filter( $this->read_private( $http, 'batch' ), static fn ( array $m ): bool => 'list_logs' === $m[ Message::VALUE ]['name'] ) );
	}

	/** A broker over one glob pair, `jobstats.p*`, its first tick not yet run. */
	private function globbing_broker(): HTTP_Source_Node {
		$this->seed_austin();
		return $this->broker( 'pull-austin', $this->remote_args( 'pull-austin', 'austin', 'jobstats.p*:stats' ) );
	}

	public function test_it_builds_each_exact_pairs_reader_on_the_first_tick(): void {
		$this->seed_austin();
		$node = $this->broker( 'pull-austin', $this->remote_args( 'pull-austin', 'austin', 'firehose.p0:downstream', 'sources/php:errors' ) );

		$node->fire();

		$this->assertSame( [ 'firehose.p0', 'sources/php' ], \array_keys( $this->readers( $node ) ) );
	}

	public function test_it_holds_no_stream_and_sends_no_heartbeat(): void {
		$this->seed_austin();
		$node = $this->broker( 'pull-austin' );

		$node->fire();
		Core::$now += 61;
		$node->fire();

		$this->assertNull( Core::node( 'pull-austin:sse-in' ) );
		$verbs = \array_map( static fn ( array $m ): string => $m[ Message::VALUE ]['name'], $this->read_private( Core::node( 'pull-austin:http-out' ), 'batch' ) );
		$this->assertNotContains( 'heartbeat', $verbs );
	}

	public function test_the_reply_cap_counts_a_reader_built_this_tick(): void {
		$this->seed_austin();
		$node = $this->broker( 'pull-austin', $this->remote_args( 'pull-austin', 'austin', 'firehose.p0:downstream', 'sources/php:errors', 'jobstats.p0:stats' ) );

		$node->fire();

		$this->assertSame( 3 * HTTP_Source_Node::READER_REPLY_BYTES, $this->read_private( Core::node( 'pull-austin:http-out' ), 'reply_cap' ) );
	}

	/** A channel rebuilt since the tick is sized to every reader as a fetch goes out. */
	public function test_the_reply_cap_counts_every_reader_as_a_fetch_goes_out(): void {
		$this->seed_austin();
		$node = $this->broker( 'pull-austin', $this->remote_args( 'pull-austin', 'austin', 'firehose.p0:downstream', 'sources/php:errors' ) );
		$node->fire();
		$node->reload();

		$this->readers( $node )['firehose.p0']->fire_cb();

		$this->assertSame( 2 * HTTP_Source_Node::READER_REPLY_BYTES, $this->read_private( Core::node( 'pull-austin:http-out' ), 'reply_cap' ) );
	}

	public function test_its_status_goes_under_the_brokers_key(): void {
		$this->seed_austin();
		$node = $this->broker( 'pull-austin' );

		$node->fire();

		$status = Core::$memd->get( HTTP_Source_Node::status_key_for( 'pull-austin', 0 ) );
		$this->assertFalse( $status['connected'], 'nothing answered yet' );
		$this->assertNull( $status['last_sse_heartbeat'] );
		$this->assertNull( $status['last_response'] );
	}

	/** Aggregator_CI and the Status tab read both brokers' snapshots alike. */
	public function test_its_status_writes_the_keys_remote_source_writes(): void {
		$this->seed_austin();
		$sse  = new Remote_Source_Node();
		$sse->name( 'stream-austin' );
		$sse->sink( Core::node( '_router' ) );
		$sse->arguments( $this->remote_args( 'stream-austin' ) );
		$http = $this->broker( 'pull-austin' );

		$sse->fire();
		$http->fire();

		$keys = static function ( string $name ): array {
			$k = \array_keys( Core::$memd->get( Remote_Broker_Node::status_key_for( $name, 0 ) ) );
			\sort( $k );
			return $k;
		};
		$this->assertSame( $keys( 'stream-austin' ), $keys( 'pull-austin' ) );
	}

	public function test_its_status_reports_the_patrons_last_transfer(): void {
		$this->seed_austin();
		$node = $this->broker( 'pull-austin' );
		$node->fire();
		( new \ReflectionProperty( HTTP_Out_Node::class, 'last_outcome' ) )->setValue( Core::node( 'pull-austin:http-out' ), [ 'code' => 503, 'error' => 'HTTP 503 from austin-7741' ] );

		Core::$now += 1;
		$node->fire();

		$status = Core::$memd->get( HTTP_Source_Node::status_key_for( 'pull-austin', 0 ) );
		$this->assertSame( 503, $status['last_http_code'] );
		$this->assertSame( 'HTTP 503 from austin-7741', $status['last_error'] );
	}

	/** A broker no Vault entry names stays disconnected and writes no snapshot. */
	public function test_without_a_vault_entry_it_writes_no_status(): void {
		$node = $this->broker( 'pull-austin' );

		$node->fire();

		$this->assertNull( Core::node( 'pull-austin:http-out' ) );
		$this->assertFalse( Core::$memd->get( HTTP_Source_Node::status_key_for( 'pull-austin', 0 ) ) );
	}

	/** A reply addressed to the broker settles here and never goes back out. */
	public function test_a_reply_to_the_broker_is_not_relayed_to_the_spoke(): void {
		$this->seed_austin();
		$node = $this->broker( 'pull-austin' );
		$node->fire();
		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$reply[ Message::TO ]    = 'pull-austin';
		$reply[ Message::VALUE ] = [ 'name' => 'list_logs', 'arguments' => [], 'payload' => [] ];

		$node->fill( $reply );

		$this->assertSame( [], $this->read_private( Core::node( 'pull-austin:http-out' ), 'batch' ) );
	}

	public function test_a_live_reader_asks_for_a_block_at_its_cursor(): void {
		[ , $reader, , $http ] = $this->fetching_reader();

		$reader->fire_cb();

		$this->assertSame( [ [ 'firehose.p0', '31:4404' ] ], $this->fetches( $http ) );
		$this->assertSame( 'pull-austin:firehose.p0', \array_slice( $this->read_private( $http, 'batch' ), -1 )[0][ Message::FROM ] );
	}

	public function test_a_multi_writer_broker_asks_with_the_seal_grace(): void {
		[ $node, $reader, , $http ] = $this->fetching_reader();
		$node->set_multi_writer( true );

		$reader->fire_cb();

		$this->assertSame( [ [ 'firehose.p0', '31:4404', '--multi_writer=true' ] ], $this->fetches( $http ) );
	}

	public function test_one_fetch_is_out_at_a_time(): void {
		[ , $reader, , $http ] = $this->fetching_reader();

		$reader->fire_cb();
		$reader->fire_cb();

		$this->assertCount( 1, $this->fetches( $http ) );
	}

	public function test_a_block_reply_forwards_its_records_and_asks_again(): void {
		[ , $reader, $sink, $http ] = $this->fetching_reader();
		$reader->fire_cb();

		$reader->fill( self::block_reply( [ 'firehose.p0', '31:4404' ], [ self::record_at( '31:4404:61', 'one-8820' ), self::record_at( '31:4465:59', 'two-3307' ) ], 31, 4524, false ) );
		$reader->fire_cb();

		$this->assertSame( [ 'one-8820', 'two-3307' ], \array_column( $sink->captured, Message::VALUE ) );
		$this->assertSame( [ [ 'firehose.p0', '31:4404' ], [ 'firehose.p0', '31:4524' ] ], $this->fetches( $http ) );
	}

	/** A block of torn lines alone moves the reader on, and it asks again at once. */
	public function test_a_block_of_skipped_lines_alone_asks_again_at_once(): void {
		[ , $reader, , $http ] = $this->fetching_reader();
		$reader->fire_cb();

		$reader->fill( self::block_reply( [ 'firehose.p0', '31:4404' ], [], 32, 1049100, false, 5 ) );

		$this->assertSame( [ 'firehose.p0', '32:1049100' ], $this->last_fetch( $http ) );
		$this->assertCount( 2, $this->fetches( $http ) );
	}

	public function test_a_reader_holding_a_block_waits_for_its_drain(): void {
		[ , $reader, , $http ] = $this->fetching_reader();
		$reader->fire_cb();
		$big   = \str_repeat( 'q', \Newspack_Nodes\Log_Sources::BLOCK_BYTES + 4194 );
		$asked = $this->last_fetch( $http );

		$reader->fill( self::block_reply( $asked, [ self::record_at( '31:4404:' . \strlen( $big ), $big ) ], 31, 4404 + \strlen( $big ), false ) );

		$this->assertCount( 1, $this->fetches( $http ), 'no new ask while it holds more than a block' );
		$this->assertSame( $asked, $this->last_fetch( $http ) );
	}

	/** The reader's own tick drains the held block, then asks past it. */
	public function test_a_drained_reader_asks_past_what_it_held(): void {
		[ , $reader, $sink, $http ] = $this->fetching_reader();
		$reader->fire_cb();
		$big = \str_repeat( 'r', \Newspack_Nodes\Log_Sources::BLOCK_BYTES + 7713 );
		$end = 4404 + \strlen( $big );
		$reader->fill( self::block_reply( [ 'firehose.p0', '31:4404' ], [ self::record_at( '31:4404:' . \strlen( $big ), $big ) ], 31, $end, false ) );

		$reader->fire_cb();

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( [ 'firehose.p0', "31:{$end}" ], $this->last_fetch( $http ) );
		$this->assertCount( 2, $this->fetches( $http ) );
	}

	/** The end waits five seconds, and the broker's tick, not the reader's poll, asks again. */
	public function test_the_end_waits_five_seconds_for_the_brokers_tick(): void {
		[ $node, $reader, , $http ] = $this->fetching_reader();
		$reader->fire_cb();
		$reader->fill( self::block_reply( [ 'firehose.p0', '31:4404' ], [], 31, 4404, true ) );

		Core::$now += 4.9;
		$node->fire();
		$this->assertCount( 1, $this->fetches( $http ) );

		Core::$now += 0.2;
		$reader->fire_cb();
		$this->assertCount( 1, $this->fetches( $http ), 'the reader\'s own poll does not end the wait' );
		$node->fire();
		$this->assertCount( 2, $this->fetches( $http ) );
	}

	/** Readers whose waits fall due in one second ask together, in one batch. */
	public function test_readers_at_the_end_ask_again_on_one_tick(): void {
		$this->seed_austin();
		$node = $this->broker( 'pull-austin', $this->remote_args( 'pull-austin', 'austin', 'firehose.p0:downstream', 'sources/php:errors', 'jobstats.p0:stats' ) );
		$node->fire();
		$http = Core::node( 'pull-austin:http-out' );
		foreach ( [ 'firehose.p0' => 503.1, 'sources/php' => 503.45, 'jobstats.p0' => 503.8 ] as $stamp => $at ) {
			Core::$now = $at;
			$reader    = $this->readers( $node )[ $stamp ];
			$reader->fire_cb();
			$reader->fill( self::block_reply( $this->last_fetch_of( $http, $stamp ), [], 4, 6100, true ) );
		}
		$asked = \count( $this->fetches( $http ) );

		Core::$now = 509.0;
		foreach ( $this->readers( $node ) as $reader ) {
			$reader->fire_cb();
		}
		$this->assertCount( $asked, $this->fetches( $http ), 'no reader ends its own wait' );
		$node->fire();

		$this->assertSame( [ 'firehose.p0', 'sources/php', 'jobstats.p0' ], \array_column( \array_slice( $this->fetches( $http ), $asked ), 0 ) );
	}

	public function test_a_lost_fetch_is_asked_again_after_the_request_timeout(): void {
		[ , $reader, , $http ] = $this->fetching_reader();
		$reader->fire_cb();

		Core::$now += HTTP_Out_Node::REQUEST_TIMEOUT - 1;
		$reader->fire_cb();
		$this->assertCount( 1, $this->fetches( $http ) );

		Core::$now += 2;
		$reader->fire_cb();
		$this->assertCount( 2, $this->fetches( $http ) );
	}

	public function test_a_block_ending_in_skipped_lines_fetches_past_them(): void {
		[ , $reader, , $http ] = $this->fetching_reader();
		$reader->fire_cb();

		$reader->fill( self::block_reply( [ 'firehose.p0', '31:4404' ], [ self::record_at( '31:4404:61', 'one-8820' ) ], 31, 4602, false, 2 ) );
		$reader->fire_cb();

		$this->assertSame( [ 'firehose.p0', '31:4602' ], $this->last_fetch( $http ) );
		$this->assertSame( 2, $reader->fetch_stats()['skipped'] );
	}

	public function test_a_fetch_reply_after_a_seek_is_ignored(): void {
		[ , $reader, $sink ] = $this->fetching_reader();
		$reader->fire_cb();
		$reader->next_offset( [ 'segment' => 40, 'offset' => 977 ] );

		$reader->fill( self::block_reply( [ 'firehose.p0', '31:4404' ], [ self::record_at( '31:4404:61', 'stale-6113' ) ], 31, 4465, false ) );

		$this->assertSame( [], $sink->captured );
		$this->assertSame( [ 'segment' => 40, 'offset' => 977 ], $reader->connect_position() );
	}

	public function test_a_paused_reader_steps_and_does_not_fetch(): void {
		[ , $reader, , $http ] = $this->fetching_reader();
		$reader->pause();

		$reader->step();
		$reader->fire_cb();

		$names = \array_map( static fn ( array $m ): string => $m[ Message::VALUE ]['name'], $this->read_private( $http, 'batch' ) );
		$this->assertSame( [ 'read_message' ], $names );
	}

	public function test_a_refused_fetch_waits_an_eof_poll(): void {
		[ , $reader, , $http ] = $this->fetching_reader();
		$reader->fire_cb();
		$refusal                              = self::block_reply( [ 'firehose.p0', '31:4404' ], [], 0, 0, false );
		$refusal[ Message::TYPE ]             = Message::TM_COMMAND | Message::TM_ERROR;
		$refusal[ Message::VALUE ]['payload'] = "unknown log: \"firehose.p0\"\n";

		$reader->fill( $refusal );
		$reader->fire_cb();

		$this->assertCount( 1, $this->fetches( $http ) );
		$this->assertEqualsWithDelta( Core::$now + HTTP_Source_Node::EOF_POLL_SECONDS, $reader->fetch_stats()['fetch_after'], 0.001 );
	}

	/** A refused fetch shows in the status, and the next answered block clears it. */
	public function test_a_refused_fetch_is_the_status_error_until_a_block_answers(): void {
		[ $node, $reader, , $http ] = $this->fetching_reader();
		$reader->fire_cb();
		$refusal                              = self::block_reply( [ 'firehose.p0', '31:4404' ], [], 0, 0, false );
		$refusal[ Message::TYPE ]             = Message::TM_COMMAND | Message::TM_ERROR;
		$refusal[ Message::VALUE ]['payload'] = "unknown command: read_block\n";
		$reader->fill( $refusal );
		$node->fire();
		$this->assertStringContainsString( 'unknown command: read_block', (string) $this->snapshot()['last_error'] );

		Core::$now += HTTP_Source_Node::EOF_POLL_SECONDS + 0.5;
		$node->fire();
		$reader->fill( self::block_reply( $this->last_fetch( $http ), [], 31, 4404, true ) );
		$node->fire();

		$this->assertNull( $this->snapshot()['last_error'] );
	}

	/** An answered fetch reads as connected, with its send time and round trip. */
	public function test_the_status_reports_the_latest_answered_fetch(): void {
		[ $node, $reader ] = $this->fetching_reader();
		Core::$now = 512.0;
		$reader->fire_cb();
		Core::$now = 515.25;
		$reader->fill( self::block_reply( [ 'firehose.p0', '31:4404' ], [ self::record_at( '31:4404:61', 'one-8820' ) ], 31, 4465, false ) );

		$node->fire();

		$status = $this->snapshot();
		$this->assertTrue( $status['connected'] );
		$this->assertSame( 515, $status['last_response'] );
		$this->assertSame( 3250.0, $status['last_rtt'], 'milliseconds, as the Status tab reads it' );
		$this->assertSame( 515, $status['last_connection_attempt'], 'the refetch the answer sent' );
	}

	/** The round trip is milliseconds, rounded as Remote_Source rounds it. */
	public function test_the_status_round_trip_is_in_milliseconds(): void {
		[ $node, $reader ] = $this->fetching_reader();
		Core::$now = 500.250;
		$reader->fire_cb();
		Core::$now = 501.900;
		$reader->fill( self::block_reply( [ 'firehose.p0', '31:4404' ], [], 31, 4404, true ) );

		$node->fire();

		$this->assertSame( 1650.0, $this->snapshot()['last_rtt'] );
	}

	/** A same-host round trip keeps the hundredth of a millisecond the tab shows. */
	public function test_the_status_round_trip_keeps_hundredths_of_a_millisecond(): void {
		[ $node, $reader ] = $this->fetching_reader();
		Core::$now = 500.0;
		$reader->fire_cb();
		Core::$now = 500.000375;
		$reader->fill( self::block_reply( [ 'firehose.p0', '31:4404' ], [], 31, 4404, true ) );

		$node->fire();

		$this->assertSame( 0.38, $this->snapshot()['last_rtt'] );
	}

	/** An answer older than four EOF polls no longer reads as connected. */
	public function test_the_status_ages_out_a_stale_answer(): void {
		[ $node, $reader ] = $this->fetching_reader();
		$reader->fire_cb();
		$reader->fill( self::block_reply( [ 'firehose.p0', '31:4404' ], [], 31, 4404, true ) );

		Core::$now += 4 * HTTP_Source_Node::EOF_POLL_SECONDS + 0.5;
		$node->fire();

		$this->assertFalse( $this->snapshot()['connected'] );
	}

	/** A reader waiting out the end is due back at its next fetch. */
	public function test_the_status_schedules_the_next_fetch_after_the_end(): void {
		[ $node, $reader ] = $this->fetching_reader();
		$reader->fire_cb();
		Core::$now = 503.25;
		$reader->fill( self::block_reply( [ 'firehose.p0', '31:4404' ], [], 31, 4404, true ) );

		$node->fire();

		$this->assertSame( 509, $this->snapshot()['scheduled_reconnect_at'] );
	}

	/** Torn lines every reader's blocks skipped add up under the broker. */
	public function test_the_status_sums_each_readers_skipped_lines(): void {
		$this->seed_austin();
		$node = $this->broker( 'pull-austin', $this->remote_args( 'pull-austin', 'austin', 'firehose.p0:downstream', 'sources/php:errors' ) );
		$node->fire();
		$http = Core::node( 'pull-austin:http-out' );
		foreach ( [ 'firehose.p0' => 7, 'sources/php' => 4 ] as $stamp => $skipped ) {
			$reader = $this->readers( $node )[ $stamp ];
			$reader->fire_cb();
			$reader->fill( self::block_reply( $this->last_fetch_of( $http, $stamp ), [], 31, 9000 + $skipped, true, $skipped ) );
		}

		$node->fire();

		$this->assertSame( 11, $this->snapshot()['unparseable_lines'] );
	}

	/** A step taken while a fetch is out pauses the reader; the late block asks nothing more. */
	public function test_a_block_answered_after_a_step_asks_nothing_more(): void {
		[ , $reader, , $http ] = $this->fetching_reader();
		$reader->fire_cb();
		$reader->step();

		$reader->fill( self::block_reply( [ 'firehose.p0', '31:4404' ], [ self::record_at( '31:4404:61', 'one-8820' ) ], 31, 4465, false ) );

		$this->assertSame( [ [ 'firehose.p0', '31:4404' ] ], $this->fetches( $http ) );
		$this->assertSame( 0, $reader->buffered_bytes(), 'the step forgave the fetch, so its block settles nothing' );
		$this->assertNull( $reader->fetch_stats()['answered_at'] );
	}

	/** A pause forgives the fetch in flight: its late block forwards and moves nothing. */
	public function test_a_block_answered_after_a_pause_is_dropped(): void {
		[ , $reader, $sink ] = $this->fetching_reader();
		$reader->fire_cb();
		$reader->pause();
		$before = $reader->connect_position();

		$reader->fill( self::block_reply( [ 'firehose.p0', '31:4404' ], [ self::record_at( '31:4404:61', 'late-5150' ) ], 31, 4465, false ) );

		$this->assertSame( [], $sink->captured );
		$this->assertSame( 0, $reader->buffered_bytes() );
		$this->assertSame( $before, $reader->connect_position() );
	}

	/** A seek forgives the wait at the end: the new place is asked at once. */
	public function test_a_seek_at_the_end_asks_the_new_place_at_once(): void {
		[ , $reader, , $http ] = $this->fetching_reader();
		$reader->fire_cb();
		$reader->fill( self::block_reply( [ 'firehose.p0', '31:4404' ], [], 31, 4404, true ) );

		$reader->next_offset( [ 'segment' => 44, 'offset' => 2718 ] );
		$reader->fire_cb();

		$this->assertSame( [ 'firehose.p0', '44:2718' ], $this->last_fetch( $http ) );
	}

	/** Across readers: the latest answer, the latest fetch sent and the soonest wait. */
	public function test_the_status_reads_every_reader(): void {
		$this->seed_austin();
		$node = $this->broker( 'pull-austin', $this->remote_args( 'pull-austin', 'austin', 'firehose.p0:downstream', 'sources/php:errors' ) );
		$node->fire();
		$http    = Core::node( 'pull-austin:http-out' );
		$readers = $this->readers( $node );
		Core::$now = 500.0;
		$readers['firehose.p0']->fire_cb();
		Core::$now = 501.0;
		$readers['sources/php']->fire_cb();
		Core::$now = 503.25;
		$readers['firehose.p0']->fill( self::block_reply( $this->last_fetch_of( $http, 'firehose.p0' ), [], 31, 4404, true ) );
		Core::$now = 504.5;
		$readers['sources/php']->fill( self::block_reply( $this->last_fetch_of( $http, 'sources/php' ), [], 2, 880, true ) );

		$node->fire();

		$status = $this->snapshot();
		$this->assertSame( 504, $status['last_response'] );
		$this->assertSame( 3500.0, $status['last_rtt'] );
		$this->assertSame( 501, $status['last_connection_attempt'] );
		$this->assertSame( 509, $status['scheduled_reconnect_at'], 'the soonest of 508.25 and 509.5' );
	}

	/** A fresh reader's pending seek goes out as its word; the spoke resolves it. */
	public function test_a_fresh_reader_asks_from_its_seek_word(): void {
		$this->seed_austin();
		$node = $this->broker( 'pull-austin' );
		$node->fire();
		$reader = Core::node( 'pull-austin:firehose.p0' );
		$http   = Core::node( 'pull-austin:http-out' );

		$reader->fire_cb();
		$reader->fill( self::block_reply( [ 'firehose.p0', 'end' ], [], 9, 8817, false ) );

		$this->assertSame( [ [ 'firehose.p0', 'end' ], [ 'firehose.p0', '9:8817' ] ], $this->fetches( $http ) );
	}

	public function test_a_glob_pair_asks_for_the_catalog_from_the_brokers_name(): void {
		$node = $this->globbing_broker();

		$node->fire();

		$asked = $this->catalog_asks( Core::node( 'pull-austin:http-out' ) );
		$this->assertCount( 1, $asked );
		$this->assertSame( 'pull-austin', $asked[0][ Message::FROM ] );
		$this->assertSame( 'raw-logs', $asked[0][ Message::TO ] );
	}

	/** The catalog is asked again an EOF poll after its answer, on the broker's tick. */
	public function test_the_catalog_is_asked_again_an_eof_poll_after_its_answer(): void {
		$node = $this->globbing_broker();
		$node->fire();
		$http = Core::node( 'pull-austin:http-out' );
		Core::$now = 501.2;
		$node->fill( self::catalog_reply( [] ) );

		Core::$now = 506.1;
		$node->fire();
		$this->assertCount( 1, $this->catalog_asks( $http ) );

		Core::$now = 506.3;
		$node->fire();
		$this->assertCount( 2, $this->catalog_asks( $http ) );
	}

	/** One ask is out at a time; a lost one goes again after the request timeout. */
	public function test_a_lost_catalog_ask_goes_again_after_the_request_timeout(): void {
		$node = $this->globbing_broker();
		$node->fire();
		$http = Core::node( 'pull-austin:http-out' );

		Core::$now = 500.0 + HTTP_Out_Node::REQUEST_TIMEOUT - 0.4;
		$node->fire();
		$this->assertCount( 1, $this->catalog_asks( $http ) );

		Core::$now = 500.0 + HTTP_Out_Node::REQUEST_TIMEOUT + 0.6;
		$node->fire();
		$this->assertCount( 2, $this->catalog_asks( $http ) );
	}

	public function test_the_catalog_builds_a_reader_for_each_key_a_glob_claims(): void {
		$node = $this->globbing_broker();
		$node->fire();

		$node->fill( self::catalog_reply( [ 'jobstats.p0', 'jobstats.p3', 'firehose.p0', 'offsets/jobstats.p1' ] ) );

		$this->assertSame( [ 'jobstats.p0', 'jobstats.p3' ], \array_keys( $this->readers( $node ) ) );
	}

	public function test_discovery_ignores_keys_no_pair_claims_without_a_warning(): void {
		$node = $this->globbing_broker();
		$node->fire();
		$err = $this->capture_stderr();

		$node->fill( self::catalog_reply( [ 'firehose.p0', 'sources/php', 'offsets/jobstats.p1' ] ) );

		$this->assertSame( [], $this->readers( $node ) );
		$this->assertSame( [], (array) $err );
	}

	/** A row the spoke could not key, an error row, builds nothing. */
	public function test_a_catalog_row_with_no_key_builds_nothing(): void {
		$node = $this->globbing_broker();
		$node->fire();
		$reply                                 = self::catalog_reply( [ 'jobstats.p2' ] );
		$reply[ Message::VALUE ]['payload'][] = [ 'label' => 'jobstats.p9', 'available' => false, 'error' => 'unreadable 7720' ];

		$node->fill( $reply );

		$this->assertSame( [ 'jobstats.p2' ], \array_keys( $this->readers( $node ) ) );
	}

	public function test_discovery_builds_no_more_than_max_readers(): void {
		$node = $this->globbing_broker();
		$node->fire();
		$keys = \array_map( static fn ( int $i ): string => "jobstats.p{$i}", \range( 0, HTTP_Source_Node::MAX_READERS + 2 ) );

		$node->fill( self::catalog_reply( $keys ) );

		$this->assertCount( HTTP_Source_Node::MAX_READERS, $this->readers( $node ) );
	}

	public function test_a_refused_catalog_builds_nothing_and_says_so(): void {
		$node = $this->globbing_broker();
		$node->fire();
		$err                                = $this->capture_stderr();
		$refusal                            = self::catalog_reply( [] );
		$refusal[ Message::TYPE ]           = Message::TM_COMMAND | Message::TM_ERROR;
		$refusal[ Message::VALUE ]['payload'] = "unknown command: list_logs 6604\n";

		$node->fill( $refusal );

		$this->assertSame( [], $this->readers( $node ) );
		$this->assertStringContainsString( 'list_logs refused: unknown command: list_logs 6604', \implode( '', (array) $err ) );
	}

	/** Only an answer naming `list_logs` is the catalog. */
	public function test_a_reply_naming_another_verb_is_no_catalog(): void {
		$node = $this->globbing_broker();
		$node->fire();
		$reply                           = self::catalog_reply( [ 'jobstats.p4' ] );
		$reply[ Message::VALUE ]['name'] = 'dump_log';

		$node->fill( $reply );

		$this->assertSame( [], $this->readers( $node ) );
	}

	/** A refusal's spoke text reaches stderr bounded to one clean line. */
	public function test_a_refused_catalog_says_a_bounded_reason(): void {
		$node = $this->globbing_broker();
		$node->fire();
		$err                                  = $this->capture_stderr();
		$refusal                              = self::catalog_reply( [] );
		$refusal[ Message::TYPE ]             = Message::TM_COMMAND | Message::TM_ERROR;
		$refusal[ Message::VALUE ]['payload'] = "spoke-3391\x1b[31m" . \str_repeat( 'z', 900 );

		$node->fill( $refusal );

		$said = \implode( '', (array) $err );
		$this->assertStringNotContainsString( "\x1b", $said );
		$this->assertStringContainsString( 'list_logs refused: spoke-3391 [31mzzz', $said );
		$this->assertLessThan( 700, \strlen( $said ), 'the 512-byte cap, not the 900 sent' );
	}

	public function test_a_broker_of_exact_pairs_never_asks_for_the_catalog(): void {
		$this->seed_austin();
		$node = $this->broker( 'pull-austin' );

		$node->fire();
		Core::$now += 6;
		$node->fire();

		$this->assertSame( [], $this->catalog_asks( Core::node( 'pull-austin:http-out' ) ) );
	}

	/** A reader discovered between ticks counts in the reply cap at its first fetch. */
	public function test_a_discovered_reader_counts_in_the_cap_at_its_first_fetch(): void {
		$this->seed_austin();
		$node = $this->broker( 'pull-austin', $this->remote_args( 'pull-austin', 'austin', 'firehose.p0:downstream', 'jobstats.p*:stats' ) );
		$node->fire();
		$node->fill( self::catalog_reply( [ 'jobstats.p0', 'jobstats.p3' ] ) );

		$this->readers( $node )['jobstats.p3']->fire_cb();

		$this->assertSame( 3 * HTTP_Source_Node::READER_REPLY_BYTES, $this->read_private( Core::node( 'pull-austin:http-out' ), 'reply_cap' ) );
	}

	public function test_its_schema_matches_remote_sources_arguments_and_verbs(): void {
		$http = HTTP_Source_Node::node_schema();
		$sse  = Remote_Source_Node::node_schema();

		$this->assertSame( 'I/O', $http['category'] );
		$this->assertFalse( $http['has_target'] );
		$this->assertSame( $sse['arguments'], $http['arguments'] );
		$this->assertSame( \array_column( $sse['commands'], 'name' ), \array_column( $http['commands'], 'name' ) );
	}
}
