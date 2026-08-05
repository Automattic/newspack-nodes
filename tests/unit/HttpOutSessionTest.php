<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Core;
use Newspack_Nodes\Vault;
use Newspack_Nodes\Message;

/**
 * HTTP_Out owns the session handshake with its spoke: it already holds that
 * spoke's credentials and its cURL-multi registration, and the minters that will
 * sign for the spoke have neither. It does NOT sign — that stays at the mint
 * site — it only makes `has_session()` true before a minter needs it.
 */
#[CoversClass( HTTP_Out_Node::class )]
class HttpOutSessionTest extends TestCase {

	private const SPOKE = 'austin';

	private ?\Memcached $prev_memd = null;

	protected function setUp(): void {
		parent::setUp();
		$this->prev_memd = Core::$memd;
		Core::$memd      = new InMemoryMemcached();
	}

	protected function tearDown(): void {
		HTTP_Out_Node::$curl_dispatch = null;
		HTTP_Out_Node::$curl_result   = null;
		Command_Auth::forget_session( self::SPOKE );
		Vault::get_instance()->reset_cache();
		Core::$memd = $this->prev_memd;
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	private function seed_vault( string $id, array $entry ): void {
		\update_option( Vault::OPTION_KEY, [ $id => $entry ] );
		Vault::get_instance()->reset_cache();
	}

	private function make_node( string $id ): HTTP_Out_Node {
		$node = new HTTP_Out_Node();
		$node->name( 'remote:' . $id );
		$node->arguments( [ $id ] );
		return $node;
	}

	private function a_command(): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_COMMAND;
		$m[ Message::TO ]    = 'settings';
		$m[ Message::VALUE ] = [ 'name' => 'set', 'arguments' => [ 'x', 'y' ] ];
		return $m;
	}

	private function last_handle( HTTP_Out_Node $node ): \CurlHandle {
		$inflight = $this->read_private( $node, 'inflight' );
		$entry    = \end( $inflight );
		return $entry['handle'];
	}

	/** @param array<int,array<int,mixed>> $captured */
	private function capture( array &$captured ): void {
		HTTP_Out_Node::$curl_dispatch = static function ( array $opts ) use ( &$captured ): \CurlHandle|false {
			$captured[] = $opts;
			return \curl_init();
		};
	}

	/**
	 * The bootstrap must not need traffic to start. Every minter refuses to
	 * emit without a session (it cannot sign), so if the handshake only ran
	 * when a batch was already queued, neither side could ever move: the
	 * settings pushes and the Remote_Link heartbeat both went silent forever,
	 * and a suppressed heartbeat let the spoke close the SSE stream.
	 */
	public function test_a_session_less_tick_runs_the_handshake_with_nothing_queued(): void {
		$this->seed_vault( self::SPOKE, [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$captured = [];
		$this->capture( $captured );
		$node = $this->make_node( self::SPOKE );

		$node->fire(); // nothing enqueued, no session

		$this->assertCount( 1, $captured, 'a session-less tick must reach out' );
		$this->assertStringEndsWith(
			'/wp-json/newspack-nodes/v1/auth',
			(string) $captured[0][ \CURLOPT_URL ]
		);
	}

	/** With a session in hand and nothing queued, a tick stays silent. */
	public function test_an_established_tick_with_nothing_queued_sends_nothing(): void {
		$this->seed_vault( self::SPOKE, [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		Command_Auth::remember_session( self::SPOKE, 'handle-7', 'key-7' );
		$captured = [];
		$this->capture( $captured );
		$node = $this->make_node( self::SPOKE );

		$node->fire();

		$this->assertSame( [], $captured );
	}

	/**
	 * A spoke that evicted our session (or restarted) answers 401. Without
	 * dropping the handle we would re-sign with a dead one forever — only a
	 * process restart cleared it, since has_session() stayed true locally.
	 */
	public function test_a_401_forgets_the_session_and_re_authenticates(): void {
		$this->seed_vault( self::SPOKE, [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		Command_Auth::remember_session( self::SPOKE, 'stale-handle', 'stale-key' );
		$captured = [];
		$this->capture( $captured );
		$node = $this->make_node( self::SPOKE );
		$node->fill( $this->a_command() );
		$node->fire(); // POSTs /command with the stale handle
		$easy = $this->last_handle( $node );

		HTTP_Out_Node::$curl_result = static fn ( \CurlHandle $h ): array => [ 'code' => 401, 'body' => '' ];
		$node->on_curl_message( [ 'msg' => \CURLMSG_DONE, 'handle' => $easy, 'result' => \CURLE_OK ] );

		$this->assertFalse(
			Command_Auth::has_session( self::SPOKE ),
			'a 401 must drop the dead handle'
		);
		$node->fire();
		$this->assertStringEndsWith(
			'/wp-json/newspack-nodes/v1/auth',
			(string) $captured[ \array_key_last( $captured ) ][ \CURLOPT_URL ],
			'the next tick must re-authenticate'
		);
	}

	public function test_fire_runs_the_auth_handshake_before_sending_any_command(): void {
		$this->seed_vault( self::SPOKE, [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$captured = [];
		$this->capture( $captured );

		$node = $this->make_node( self::SPOKE );
		$node->fill( $this->a_command() );
		$node->fire();

		$this->assertCount( 1, $captured, 'the handshake goes first, alone' );
		$this->assertStringEndsWith( '/wp-json/newspack-nodes/v1/auth', $captured[0][ \CURLOPT_URL ] );
	}

	public function test_the_batch_is_held_not_dropped_while_unauthed(): void {
		$this->seed_vault( self::SPOKE, [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$captured = [];
		$this->capture( $captured );

		$node = $this->make_node( self::SPOKE );
		$node->fill( $this->a_command() );
		$node->fire();

		// Session lands out of band; the held batch must still be there.
		Command_Auth::remember_session( self::SPOKE, \str_repeat( 'a', 32 ), 'session-key-4242' );
		$node->fire();

		$this->assertCount( 2, $captured );
		$this->assertStringEndsWith( '/wp-json/newspack-nodes/v1/command', $captured[1][ \CURLOPT_URL ] );
		$wire = Message::unpacked( \rtrim( $captured[1][ \CURLOPT_POSTFIELDS ], "\n" ) );
		$this->assertSame( 'settings', $wire[ Message::TO ], 'the held message survived' );
	}

	public function test_a_refused_handshake_leaves_the_batch_intact(): void {
		$this->seed_vault( self::SPOKE, [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$captured = [];
		$this->capture( $captured );
		HTTP_Out_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 403, 'body' => '' ];

		$node = $this->make_node( self::SPOKE );
		$node->fill( $this->a_command() );
		$node->fire();
		foreach ( $this->read_private( $node, 'inflight' ) as $entry ) {
			$node->on_curl_message( [ 'msg' => \CURLMSG_DONE, 'handle' => $entry['handle'], 'result' => \CURLE_OK ] );
		}

		Command_Auth::remember_session( self::SPOKE, \str_repeat( 'b', 32 ), 'session-key-9999' );
		$node->fire();

		$this->assertCount( 2, $captured, 'the command still ships once a session exists' );
	}

	/** Permanent misconfiguration still drops — that is not the same as unauthed. */
	public function test_a_missing_vault_entry_still_drops_the_batch(): void {
		$captured = [];
		$this->capture( $captured );

		$node = $this->make_node( 'nonexistent' );
		$node->fill( $this->a_command() );
		$node->fire();
		Command_Auth::remember_session( 'nonexistent', \str_repeat( 'c', 32 ), 'k' );
		$node->fire();

		$this->assertCount( 0, $captured );
		Command_Auth::forget_session( 'nonexistent' );
	}
}
