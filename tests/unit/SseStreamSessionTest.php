<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Rest\SSE_Out_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

/**
 * A stream presents the command session it signs with, and its replies are
 * addressed to that session rather than to the process serving it: the
 * handle must be live and the requesting user's own, the lease is keyed by
 * it, and the `connected` envelope echoes it where the pid used to ride.
 */
#[CoversClass( SSE_Out_Node::class )]
class SseStreamSessionTest extends TestCase {

	/** Distinct from 0, the shim's default user. */
	private const USER = 4471;

	private ?\Memcached $prev_memd = null;

	protected function setUp(): void {
		parent::setUp();
		\Newspack_Nodes\Event_Framework::reset();
		$this->use_loop_time();
		$this->prev_memd                         = Core::$memd;
		Core::$memd                              = new InMemoryMemcached();
		$GLOBALS['_wp_test_current_user_id']     = self::USER;
	}

	protected function tearDown(): void {
		unset( $GLOBALS['_wp_test_current_user_id'] );
		Core::$memd = $this->prev_memd;
		\Newspack_Nodes\Event_Framework::reset();
		parent::tearDown();
	}

	/**
	 * Stream a request whose acquire seam records what it was offered and
	 * refuses, so nothing past acquisition runs.
	 *
	 * @param array<string,string> $params Query parameters.
	 * @return array{0:mixed,1:list<array{0:int,1:?array<string,mixed>}>} The result, then every acquire call.
	 */
	private function stream_refused_at_acquire( array $params ): array {
		$calls                      = [];
		SSE_Out_Node::$acquire_slot = static function ( int $partition, ?array $session ) use ( &$calls ): array|false {
			$calls[] = [ $partition, $session ];
			return false;
		};
		$req = new \WP_REST_Request( 'GET' );
		foreach ( $params as $key => $value ) {
			$req->set_param( $key, $value );
		}
		return [ ( new SSE_Out_Node() )->stream( $req ), $calls ];
	}

	public function test_a_stream_presenting_another_users_session_is_refused_before_acquiring(): void {
		$GLOBALS['_wp_test_current_user_id'] = 9119;
		$session                             = Command_Auth::mint_session();
		$GLOBALS['_wp_test_current_user_id'] = self::USER;

		[ $result, $calls ] = $this->stream_refused_at_acquire(
			[ 'subscribe' => 'firehose.*', 'session' => $session['handle'] ]
		);

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'sse_session_refused', $result->get_error_code() );
		$this->assertSame( 401, $result->get_error_data()['status'] ?? null );
		$this->assertSame( [], $calls, 'a refused stream must not take a slot' );
	}

	public function test_a_stream_presenting_a_dead_session_is_refused(): void {
		[ $result, $calls ] = $this->stream_refused_at_acquire(
			[ 'subscribe' => 'firehose.*', 'session' => 'deadbeefdeadbeefdeadbeefdeadbeef' ]
		);

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'sse_session_refused', $result->get_error_code() );
		$this->assertSame( [], $calls );
	}

	public function test_a_revoked_session_is_refused(): void {
		$session = Command_Auth::mint_session();
		Command_Auth::revoke_session( $session['handle'] );

		[ $result ] = $this->stream_refused_at_acquire(
			[ 'subscribe' => 'firehose.*', 'session' => $session['handle'] ]
		);

		$this->assertSame( 'sse_session_refused', $result->get_error_code() );
	}

	public function test_a_handle_that_could_not_be_one_is_refused(): void {
		[ $result, $calls ] = $this->stream_refused_at_acquire(
			[ 'subscribe' => 'firehose.*', 'session' => '../_sse:1/_output' ]
		);

		$this->assertSame( 'sse_session_refused', $result->get_error_code() );
		$this->assertSame( [], $calls );
	}

	public function test_a_stream_with_no_session_acquires_as_before(): void {
		[ $result, $calls ] = $this->stream_refused_at_acquire( [ 'subscribe' => 'firehose.*' ] );

		$this->assertSame( 'too_many_connections', $result->get_error_code() );
		$this->assertSame( [ [ -1, null ] ], $calls );
	}

	public function test_a_session_stream_keys_its_lease_by_the_handle_and_the_stream_it_names(): void {
		$session = Command_Auth::mint_session();
		$stream  = [ 'subscribe' => 'combined.p7', 'session' => $session['handle'] ];

		[ , $calls ]  = $this->stream_refused_at_acquire( $stream + [ 'stream' => 'console.p7:sse-in' ] );
		[ , $same ]   = $this->stream_refused_at_acquire( $stream + [ 'stream' => 'console.p7:sse-in' ] );
		[ , $sibling ] = $this->stream_refused_at_acquire( $stream + [ 'stream' => 'overlay:sse-in' ] );

		$this->assertSame( 7, $calls[0][0] );
		$this->assertSame( $session['handle'] . ':console.p7:sse-in', $calls[0][1]['key'] );
		$this->assertSame( $calls[0][1]['key'], $same[0][1]['key'], 'a reconnect asks for the same lease' );
		$this->assertNotSame( $calls[0][1]['key'], $sibling[0][1]['key'], 'two same-subscription streams on one page keep two leases' );
	}

	public function test_the_lease_index_is_offered_the_sessions_remaining_life(): void {
		$session = Command_Auth::mint_session( \Newspack_Nodes\Capabilities::READ, 4242 );

		[ , $calls ] = $this->stream_refused_at_acquire(
			[ 'subscribe' => 'combined.p7', 'session' => $session['handle'], 'stream' => 'console.p7:sse-in' ]
		);

		$this->assertEqualsWithDelta( 4242, $calls[0][1]['ttl'], 2 );
	}

	public function test_a_session_stream_naming_no_stream_takes_no_takeover_key(): void {
		$session = Command_Auth::mint_session();

		[ , $calls ] = $this->stream_refused_at_acquire( [ 'subscribe' => 'combined.p7', 'session' => $session['handle'] ] );

		$this->assertSame( [ [ 7, null ] ], $calls );
	}

	public function test_a_stream_id_that_could_not_be_one_is_refused(): void {
		$session = Command_Auth::mint_session();

		[ $result, $calls ] = $this->stream_refused_at_acquire(
			[ 'subscribe' => 'combined.p7', 'session' => $session['handle'], 'stream' => "bad stream\nid" ]
		);

		$this->assertSame( 'sse_stream_invalid', $result->get_error_code() );
		$this->assertSame( 400, $result->get_error_data()['status'] ?? null );
		$this->assertSame( [], $calls );
	}

	/**
	 * The browser's dead-session probe depends on this order: a malformed
	 * stream id with a dead session must answer the SESSION refusal, and with
	 * a live one the stream-id refusal, and neither may take a slot.
	 */
	public function test_the_session_is_checked_before_the_stream_id(): void {
		$live = Command_Auth::mint_session();

		[ $dead_result, $dead_calls ] = $this->stream_refused_at_acquire(
			[ 'subscribe' => 'combined.p7', 'session' => 'deadbeefdeadbeefdeadbeefdeadbeef', 'stream' => '!' ]
		);
		[ $live_result, $live_calls ] = $this->stream_refused_at_acquire(
			[ 'subscribe' => 'combined.p7', 'session' => $live['handle'], 'stream' => '!' ]
		);

		$this->assertSame( 'sse_session_refused', $dead_result->get_error_code() );
		$this->assertSame( 'sse_stream_invalid', $live_result->get_error_code() );
		$this->assertSame( [], $dead_calls );
		$this->assertSame( [], $live_calls );
	}

	public function test_a_superseded_lease_closes_quietly_with_its_own_key(): void {
		$logged                       = [];
		SSE_Out_Node::$check_slot     = static fn ( array $lease, int $partition ): bool => false;
		SSE_Out_Node::$inspect_slot   = static fn ( array $lease, int $partition ): array => [ 'backend' => 'memcached', 'lease_state' => 'superseded' ];
		SSE_Out_Node::$diagnostic_log = static function ( array $context ) use ( &$logged ): void {
			$logged[] = $context;
		};

		$events = $this->run_ipc_stream( null, [], false );

		$this->assertSame( 'superseded', $events['disconnect'][0][ Message::KEY ] ?? null );
		$this->assertSame( [], $logged, 'a routine reconnect is no error' );
	}

	public function test_a_lost_lease_still_reports_its_diagnostic(): void {
		$logged                       = [];
		SSE_Out_Node::$check_slot     = static fn ( array $lease, int $partition ): bool => false;
		SSE_Out_Node::$inspect_slot   = static fn ( array $lease, int $partition ): array => [ 'backend' => 'memcached', 'lease_state' => 'pointer_owner_mismatch' ];
		SSE_Out_Node::$diagnostic_log = static function ( array $context ) use ( &$logged ): void {
			$logged[] = $context;
		};

		$events = $this->run_ipc_stream( null, [], false );

		$this->assertSame( 'slot_lease_lost', $events['disconnect'][0][ Message::KEY ] ?? null );
		$this->assertCount( 1, $logged );
	}

	public function test_release_names_the_session_lease_it_frees(): void {
		$released                   = [];
		SSE_Out_Node::$release_slot = static function ( array $lease, int $partition, ?string $session ) use ( &$released ): void {
			$released[] = $session;
		};

		$this->run_ipc_stream( 'c0ffee77c0ffee77c0ffee77c0ffee77', [], true, 'c0ffee77c0ffee77c0ffee77c0ffee77:console.p7:sse-in' );

		$this->assertSame( [ 'c0ffee77c0ffee77c0ffee77c0ffee77:console.p7:sse-in' ], $released );
	}

	public function test_connected_carries_the_session_and_no_pid(): void {
		$session = Command_Auth::mint_session();
		$events  = $this->run_ipc_stream( $session['handle'], [] );

		$connected = $events['connected'][0] ?? null;
		$this->assertNotNull( $connected );
		$tokens = \explode( ' ', Core::as_string( $connected[ Message::VALUE ] ) );
		$this->assertSame( [ 'SESSION', $session['handle'] ], \array_slice( $tokens, 0, 2 ) );
		$this->assertNotContains( 'PID', $tokens );
	}

	public function test_a_sessionless_stream_names_no_session_in_connected(): void {
		$events = $this->run_ipc_stream( null, [] );

		$tokens = \explode( ' ', Core::as_string( $events['connected'][0][ Message::VALUE ] ) );
		$this->assertNotContains( 'SESSION', $tokens );
		$this->assertNotContains( 'PID', $tokens );
	}

	public function test_the_stream_delivers_its_own_sessions_replies_and_drops_the_rest(): void {
		$session = Command_Auth::mint_session();
		$events  = $this->run_ipc_stream(
			$session['handle'],
			[
				'_output/_sse:' . $session['handle'] . '/_output' => 'mine-4471',
				'_output/_sse:0ther0ther0ther0ther0ther0the/_output' => 'theirs-9119',
				'_output/_sse:' . \getmypid() . '/_output'         => 'a-pid-8080',
			]
		);

		$values = \array_map( static fn ( array $m ) => $m[ Message::VALUE ], $events['msg'] ?? [] );
		$this->assertSame( [ 'mine-4471' ], $values );
		$this->assertSame( '_output', $events['msg'][0][ Message::TO ] );
	}

	/**
	 * Write replies into a worker's IPC output partition, then run one bounded
	 * stream attached to it and group what it emitted by event name.
	 *
	 * @param string|null          $session   Handle the stream presents.
	 * @param array<string,string> $replies   TO => VALUE for each reply record.
	 * @param bool                 $bounded   Install the bounded check and a silent log.
	 * @param string|null          $lease_key The session lease key the stream holds.
	 * @return array<string,list<array<int,mixed>>> Decoded messages per event.
	 */
	private function run_ipc_stream( ?string $session, array $replies, bool $bounded = true, ?string $lease_key = null ): array {
		$base = $this->make_temp_dir( 'sse-session-' );
		$dir  = "{$base}/ipc/combined.p7/output";
		\mkdir( $dir, 0755, true );
		$partition = new Partition_Node();
		$partition->arguments( [ $dir ] );
		foreach ( $replies as $to => $value ) {
			$m                   = Message::new_message();
			$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
			$m[ Message::TO ]    = $to;
			$m[ Message::VALUE ] = $value;
			$partition->fill( $m );
		}
		$partition->flush();

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $base );
		if ( $bounded ) {
			SSE_Out_Node::$check_slot     = $this->boundedTicks( 20 );
			SSE_Out_Node::$diagnostic_log = static function ( array $_context ): void {};
		}
		\ob_start();
		$ctrl->run_stream_loop(
			[ 'combined.p7' ],
			[ 'combined.p7' => 'start' ],
			500,
			[ 'slot' => 3, 'owner' => 42424243 ],
			7,
			$session,
			$lease_key
		);
		$out = (string) \ob_get_clean();
		$this->rmdir_recursive( $base );

		$events = [];
		foreach ( \explode( "\n\n", \trim( $out ) ) as $chunk ) {
			if ( ! \preg_match( '/^event: (\S+)\ndata: (.*)$/s', \trim( $chunk ), $match ) ) {
				continue;
			}
			$decoded = \json_decode( $match[2], true );
			if ( \is_array( $decoded ) ) {
				$events[ $match[1] ][] = $decoded;
			}
		}
		return $events;
	}
}
