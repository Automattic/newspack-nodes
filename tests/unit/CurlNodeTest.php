<?php
/**
 * Curl_Node: fetch the URL a TM_BYTESTREAM carries on the shared multi and
 * emit the response, or a TM_ERROR naming why there is none.
 *
 * The dispatch and result seams stand in for libcurl, so the URL resolution,
 * the opts, the in-flight cap and the response classification all run as
 * production code with no network.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Curl_Node;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Message;
use Newspack_Nodes\Vault;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Tests\Capture_Sink_Node;

#[CoversClass( Curl_Node::class )]
class CurlNodeTest extends TestCase {

	/** @var array<int,array<int,mixed>> Opts each dispatch was handed. */
	private array $captured = [];

	/** @var list<\CurlHandle> Handles each dispatch returned, in order. */
	private array $handles = [];

	private Capture_Sink_Node $sink;

	protected function setUp(): void {
		parent::setUp();
		Event_Framework::reset();
		$this->use_base_dir( $this->make_temp_dir(), [ 'vault_require_ssl' => false ] );
		\Newspack_Nodes\Event_Framework::$curl_dispatch = function ( array $opts ): \CurlHandle {
			$this->captured[] = $opts;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			$easy            = \curl_init();
			$this->handles[] = $easy;
			return $easy;
		};
		$this->sink = new Capture_Sink_Node();
		$this->sink->name( '_command_interpreter' );
	}

	protected function tearDown(): void {
		\Newspack_Nodes\Event_Framework::$curl_dispatch = null;
		Curl_Node::$curl_result   = null;
		Vault::get_instance()->reset_cache();
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	private function curl( string ...$args ): Curl_Node {
		$node = new Curl_Node();
		$node->name( 'fetch-7731' );
		$node->arguments( \array_values( $args ) );
		$node->sink( $this->sink );
		$node->target( 'fetched-4402' );
		return $node;
	}

	/** Fill inside a running drain loop, where a fetch may start. */
	private function fetch( Curl_Node $node, array $message ): void {
		$filled = false;
		Event_Framework::instance()->drain(
			static function () use ( $node, $message, &$filled ): bool {
				if ( ! $filled ) {
					$filled = true;
					$node->fill( $message );
				}
				return false;
			}
		);
	}

	private function url_message( mixed $value, int $type = Message::TM_BYTESTREAM ): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = $type;
		$m[ Message::FROM ]  = 'asker-5519/reply';
		$m[ Message::ID ]    = 'corr-6081';
		$m[ Message::KEY ]   = 'key-2297';
		$m[ Message::VALUE ] = $value;
		return $m;
	}

	private function done( \CurlHandle $easy, int $result = \CURLE_OK ): array {
		return [ 'msg' => \CURLMSG_DONE, 'handle' => $easy, 'result' => $result ];
	}

	/** @return array<int,mixed> The one message the sink holds. */
	private function only_emitted(): array {
		$this->assertCount( 1, $this->sink->captured );
		return $this->sink->captured[0];
	}

	private function assert_error( string $expected ): void {
		$out = $this->only_emitted();
		$this->assertSame( Message::TM_ERROR, $out[ Message::TYPE ] );
		$this->assertSame( $expected, $out[ Message::VALUE ] );
		$this->assertSame( [], $this->captured, 'no transfer starts' );
	}

	public function test_absolute_url_without_a_vault_dispatches_a_get(): void {
		$this->use_base_dir( $this->make_temp_dir(), [ 'vault_verify_ssl' => false ] );
		$node = $this->curl();

		$this->fetch( $node, $this->url_message( "  https://feeds.example:8443/odd/path-31?q=7\n" ) );

		$this->assertCount( 1, $this->captured );
		$opts = $this->captured[0];
		$this->assertSame( 'https://feeds.example:8443/odd/path-31?q=7', $opts[ \CURLOPT_URL ] );
		$this->assertTrue( $opts[ \CURLOPT_HTTPGET ] );
		$this->assertSame( \CURLPROTO_HTTP | \CURLPROTO_HTTPS, $opts[ \CURLOPT_PROTOCOLS ] );
		$this->assertSame( \CURLPROTO_HTTP | \CURLPROTO_HTTPS, $opts[ \CURLOPT_REDIR_PROTOCOLS ] );
		$this->assertTrue( $opts[ \CURLOPT_FOLLOWLOCATION ] );
		$this->assertSame( Curl_Node::MAX_REDIRECTS, $opts[ \CURLOPT_MAXREDIRS ] );
		$this->assertSame( 5, Curl_Node::MAX_REDIRECTS );
		$this->assertSame( Curl_Node::REQUEST_TIMEOUT, $opts[ \CURLOPT_TIMEOUT ] );
		$this->assertSame( 30, Curl_Node::REQUEST_TIMEOUT );
		$this->assertFalse( $opts[ \CURLOPT_SSL_VERIFYPEER ], 'vault_verify_ssl is read' );
		$this->assertSame( 0, $opts[ \CURLOPT_SSL_VERIFYHOST ] );
		$this->assertSame( 8388608, $opts[ \CURLOPT_MAXFILESIZE ] );
		$this->assertIsCallable( $opts[ \CURLOPT_WRITEFUNCTION ] );
		foreach ( $opts[ \CURLOPT_HTTPHEADER ] ?? [] as $header ) {
			$this->assertStringStartsNotWith( 'Authorization:', $header );
		}
		$this->assertSame( [], $this->sink->captured, 'nothing emits until the transfer completes' );
	}

	/** Group `crawl-g7` on two origins, a third entry on one of them in another group, and one with no url. */
	private function seed_group(): void {
		$this->seed_vault_servers(
			[
				'north-31'  => [ 'url' => 'https://North-31.Example:8443/api', 'auth_username' => 'svc-n31', 'auth_password' => 'pw-n58', 'group' => 'crawl-g7' ],
				'south-52'  => [ 'url' => 'https://south-52.example', 'auth_username' => 'svc-s52', 'auth_password' => 'pw-s19', 'group' => 'crawl-g7' ],
				'other-90'  => [ 'url' => 'https://south-52.example', 'auth_username' => 'svc-o90', 'auth_password' => 'pw-o44', 'group' => 'elsewhere-4' ],
				'blank-31'  => [ 'auth_username' => 'no-url-31', 'group' => 'crawl-g7' ],
			]
		);
	}

	/** @return list<string> The Authorization headers dispatch $i carried. */
	private function authorization_of( int $i ): array {
		return \array_values( \array_filter( $this->captured[ $i ][ \CURLOPT_HTTPHEADER ] ?? [], static fn ( string $h ): bool => \str_starts_with( $h, 'Authorization:' ) ) );
	}

	public function test_each_origin_in_the_group_carries_its_own_credential(): void {
		$this->seed_group();
		$node = $this->curl( 'crawl-g7' );

		$this->fetch( $node, $this->url_message( 'https://north-31.example:8443/deep/x-1' ) );
		$this->fetch( $node, $this->url_message( 'HTTPS://SOUTH-52.example:443/y-2' ) );

		$this->assertSame( 'https://north-31.example:8443/deep/x-1', $this->captured[0][ \CURLOPT_URL ], 'the url is fetched as written, no path joined' );
		$this->assertSame( [ 'Authorization: ' . Vault::credential_header( 'svc-n31', 'pw-n58' ) ], $this->authorization_of( 0 ) );
		$this->assertSame( 'HTTPS://SOUTH-52.example:443/y-2', $this->captured[1][ \CURLOPT_URL ] );
		$this->assertSame( [ 'Authorization: ' . Vault::credential_header( 'svc-s52', 'pw-s19' ) ], $this->authorization_of( 1 ), 'the entry in another group is not counted' );
		$this->assertSame( [], $this->sink->captured );
	}

	public function test_an_origin_outside_the_group_fetches_without_authorization(): void {
		$this->use_base_dir( $this->make_temp_dir(), [ 'vault_require_ssl' => true ] );
		$this->seed_group();
		$node = $this->curl( 'crawl-g7' );

		$this->fetch( $node, $this->url_message( 'http://stranger-77.example:8090/z-3' ) );
		$this->fetch( $node, $this->url_message( 'https://north-31.example/other-port-4' ) );

		$this->assertSame( 'http://stranger-77.example:8090/z-3', $this->captured[0][ \CURLOPT_URL ] );
		$this->assertSame( [], $this->authorization_of( 0 ) );
		$this->assertSame( \CURLPROTO_HTTP | \CURLPROTO_HTTPS, $this->captured[0][ \CURLOPT_PROTOCOLS ], 'require_ssl binds only a credentialed fetch' );
		$this->assertSame( [], $this->authorization_of( 1 ), 'another port is another origin' );
		$this->assertSame( [], $this->sink->captured );
	}

	public function test_two_entries_on_one_origin_refuse_naming_both(): void {
		$this->seed_vault_servers(
			[
				'twin-b' => [ 'url' => 'https://twin-12.example/b', 'auth_username' => 'svc-b', 'auth_password' => 'pw-b', 'group' => 'crawl-g7' ],
				'twin-a' => [ 'url' => 'https://Twin-12.example:443/a', 'auth_username' => 'svc-a', 'auth_password' => 'pw-a', 'group' => 'crawl-g7' ],
			]
		);

		$this->fetch( $this->curl( 'crawl-g7' ), $this->url_message( 'https://twin-12.example/page-5' ) );

		$this->assert_error( 'vault entries twin-a, twin-b share origin https://twin-12.example:443 https://twin-12.example/page-5' );
	}

	public function test_vault_require_ssl_refuses_an_http_url_on_a_matched_origin(): void {
		$this->use_base_dir( $this->make_temp_dir(), [ 'vault_require_ssl' => true ] );
		$this->seed_vault( 'plain-7', [ 'url' => 'http://plain-7.example:8081', 'auth_username' => 'svc-p7', 'auth_password' => 'pw-p7', 'group' => 'crawl-g7' ] );

		$this->fetch( $this->curl( 'crawl-g7' ), $this->url_message( 'http://plain-7.example:8081/feed-14' ) );

		$this->assert_error( 'vault_require_ssl set but url is not https http://plain-7.example:8081/feed-14' );
	}

	public function test_an_uppercase_https_url_under_require_ssl_is_fetched_with_its_credential(): void {
		$this->use_base_dir( $this->make_temp_dir(), [ 'vault_require_ssl' => true ] );
		$this->seed_vault( 'loud-6', [ 'url' => 'https://loud-6.example:9443', 'auth_username' => 'svc-l6', 'auth_password' => 'pw-l6', 'group' => 'crawl-g7' ] );

		$this->fetch( $this->curl( 'crawl-g7' ), $this->url_message( 'HTTPS://loud-6.example:9443/caps-38' ) );

		$this->assertSame( [], $this->sink->captured, 'the scheme matches https whatever its case' );
		$this->assertSame( 'HTTPS://loud-6.example:9443/caps-38', $this->captured[0][ \CURLOPT_URL ] );
		$this->assertSame( [ 'Authorization: ' . Vault::credential_header( 'svc-l6', 'pw-l6' ) ], $this->authorization_of( 0 ) );
		$this->assertSame( \CURLPROTO_HTTPS, $this->captured[0][ \CURLOPT_PROTOCOLS ] );
	}

	public function test_a_matched_origin_under_require_ssl_narrows_both_protocol_lists_to_https(): void {
		$this->use_base_dir( $this->make_temp_dir(), [ 'vault_require_ssl' => true ] );
		$this->seed_vault( 'sealed-8', [ 'url' => 'https://sealed-8.example:9443', 'auth_username' => 'svc-8', 'auth_password' => 'pw-8', 'group' => 'crawl-g7' ] );

		$this->fetch( $this->curl( 'crawl-g7' ), $this->url_message( 'https://sealed-8.example:9443/only-tls-56' ) );

		$this->assertSame( \CURLPROTO_HTTPS, $this->captured[0][ \CURLOPT_PROTOCOLS ] );
		$this->assertSame( \CURLPROTO_HTTPS, $this->captured[0][ \CURLOPT_REDIR_PROTOCOLS ] );
	}

	public function test_a_matched_origin_not_requiring_ssl_keeps_http_and_https(): void {
		$this->seed_vault( 'open-9', [ 'url' => 'https://open-9.example:9443', 'auth_username' => 'svc-9', 'auth_password' => 'pw-9', 'group' => 'crawl-g7' ] );

		$this->fetch( $this->curl( 'crawl-g7' ), $this->url_message( 'https://open-9.example:9443/either-57' ) );

		$this->assertSame( \CURLPROTO_HTTP | \CURLPROTO_HTTPS, $this->captured[0][ \CURLOPT_PROTOCOLS ] );
		$this->assertSame( \CURLPROTO_HTTP | \CURLPROTO_HTTPS, $this->captured[0][ \CURLOPT_REDIR_PROTOCOLS ] );
	}

	public function test_a_credential_is_not_sent_past_a_redirect_to_another_origin(): void {
		$this->seed_group();

		$this->fetch( $this->curl( 'crawl-g7' ), $this->url_message( 'https://south-52.example/hop-6' ) );

		$this->assertTrue( $this->captured[0][ \CURLOPT_FOLLOWLOCATION ] );
		$this->assertFalse( $this->captured[0][ \CURLOPT_UNRESTRICTED_AUTH ], 'libcurl drops Authorization when a redirect changes host, port or scheme' );
	}

	public function test_a_fill_outside_an_event_loop_starts_nothing(): void {
		$node = $this->curl();

		$node->fill( $this->url_message( 'https://idle-loop.example:8443/no-drain-58' ) );

		$this->assert_error( 'no event loop https://idle-loop.example:8443/no-drain-58' );
	}

	public function test_a_success_emits_the_body_as_a_bytestream(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->url_message( 'http://body.example:8090/doc-61', Message::TM_BYTESTREAM | Message::TM_RESPONSE ) );
		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 203, 'body' => "body-text-9172\n", 'redirect' => '' ];

		$this->deliver_curl_rows( [ $this->done( $this->handles[0] ) ] );

		$out = $this->only_emitted();
		$this->assertSame( Message::TM_BYTESTREAM, $out[ Message::TYPE ], 'TYPE is replaced, not OR-ed' );
		$this->assertSame( "body-text-9172\n", $out[ Message::VALUE ] );
		$this->assertSame( 'asker-5519/reply', $out[ Message::FROM ] );
		$this->assertSame( 'corr-6081', $out[ Message::ID ] );
		$this->assertSame( 'key-2297', $out[ Message::KEY ] );
		$this->assertSame( 'fetched-4402', $out[ Message::TO ] );
		$this->assertSame( [], \Newspack_Nodes\Event_Framework::instance()->handles_of( $node ), 'the handle is released' );
		$this->assertSame( [], Event_Framework::instance()->curl_handles(), 'and detached' );
	}

	public function test_follow_off_fetches_without_following(): void {
		$node = $this->curl();
		$node->follow_redirects( false );

		$this->fetch( $node, $this->url_message( 'http://hop.example:8090/start-31' ) );

		$this->assertFalse( $this->captured[0][ \CURLOPT_FOLLOWLOCATION ] );
	}

	public function test_with_follow_off_a_redirect_answers_its_location_as_a_response(): void {
		$node = $this->curl();
		$node->follow_redirects( false );
		$this->fetch( $node, $this->url_message( 'http://hop.example:8090/start-31' ) );
		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 301, 'body' => 'moved text', 'redirect' => 'http://hop.example:8090/landed-32' ];

		$this->deliver_curl_rows( [ $this->done( $this->handles[0] ) ] );

		$out = $this->only_emitted();
		$this->assertSame( Message::TM_RESPONSE, $out[ Message::TYPE ] );
		$this->assertSame( 'http://hop.example:8090/landed-32', $out[ Message::VALUE ] );
		$this->assertSame( 'asker-5519/reply', $out[ Message::FROM ] );
		$this->assertSame( 'corr-6081', $out[ Message::ID ] );
		$this->assertSame( 'key-2297', $out[ Message::KEY ] );
		$this->assertSame( 'fetched-4402', $out[ Message::TO ] );
	}

	public function test_with_follow_off_a_redirect_without_a_location_answers_an_http_error(): void {
		$node = $this->curl();
		$node->follow_redirects( false );
		$this->fetch( $node, $this->url_message( 'http://hop.example:8090/start-31' ) );
		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 302, 'body' => '', 'redirect' => '' ];

		$this->deliver_curl_rows( [ $this->done( $this->handles[0] ) ] );

		$out = $this->only_emitted();
		$this->assertSame( Message::TM_ERROR, $out[ Message::TYPE ] );
		$this->assertSame( 'HTTP 302 http://hop.example:8090/start-31', $out[ Message::VALUE ] );
	}

	public function test_with_follow_on_a_3xx_that_completes_is_a_body(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->url_message( 'http://hop.example:8090/start-31' ) );
		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 304, 'body' => 'not modified 61', 'redirect' => 'http://hop.example:8090/ignored-33' ];

		$this->deliver_curl_rows( [ $this->done( $this->handles[0] ) ] );

		$out = $this->only_emitted();
		$this->assertSame( Message::TM_BYTESTREAM, $out[ Message::TYPE ] );
		$this->assertSame( 'not modified 61', $out[ Message::VALUE ] );
	}

	public function test_each_transfer_buffers_its_own_body(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->url_message( 'http://own-buffer.example:8090/first-43' ) );
		$this->fetch( $node, $this->url_message( 'http://own-buffer.example:8090/second-44' ) );
		$this->captured[0][ \CURLOPT_WRITEFUNCTION ]( $this->handles[0], 'alpha-43' );
		$this->captured[1][ \CURLOPT_WRITEFUNCTION ]( $this->handles[1], 'beta-44' );
		$this->captured[0][ \CURLOPT_WRITEFUNCTION ]( $this->handles[0], '-tail' );

		$this->complete_curl( $this->handles[1] );
		$this->complete_curl( $this->handles[0] );

		$this->assertSame( [ 'beta-44', 'alpha-43-tail' ], \array_column( $this->sink->captured, Message::VALUE ) );
	}

	public function test_a_status_of_400_or_more_emits_an_http_error(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->url_message( 'http://teapot.example:8090/brew-418' ) );
		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 418, 'body' => 'short and stout', 'redirect' => '' ];

		$this->deliver_curl_rows( [ $this->done( $this->handles[0] ) ] );

		$out = $this->only_emitted();
		$this->assertSame( Message::TM_ERROR, $out[ Message::TYPE ] );
		$this->assertSame( 'HTTP 418 http://teapot.example:8090/brew-418', $out[ Message::VALUE ] );
		$this->assertSame( 'corr-6081', $out[ Message::ID ] );
	}

	public function test_a_404_emits_an_http_error(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->url_message( 'http://gone.example:8090/missing-404' ) );
		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 404, 'body' => '', 'redirect' => '' ];

		$this->deliver_curl_rows( [ $this->done( $this->handles[0] ) ] );

		$this->assertSame( 'HTTP 404 http://gone.example:8090/missing-404', $this->only_emitted()[ Message::VALUE ] );
	}

	public function test_a_curl_error_emits_its_number_and_reason(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->url_message( 'http://slow.example:8090/stall-28' ) );
		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 200, 'body' => 'never read', 'redirect' => '' ];

		$this->deliver_curl_rows( [ $this->done( $this->handles[0], \CURLE_OPERATION_TIMEDOUT ) ] );

		$out = $this->only_emitted();
		$this->assertSame( Message::TM_ERROR, $out[ Message::TYPE ] );
		$this->assertSame(
			'curl error 28 (' . \curl_strerror( \CURLE_OPERATION_TIMEDOUT ) . ') http://slow.example:8090/stall-28',
			$out[ Message::VALUE ]
		);
		$this->assertSame( [], \Newspack_Nodes\Event_Framework::instance()->handles_of( $node ) );
	}

	public function test_the_seventeenth_fill_is_turned_away_until_a_handle_completes(): void {
		$node = $this->curl();
		for ( $i = 1; $i <= 16; $i++ ) {
			$this->fetch( $node, $this->url_message( "http://busy.example:8090/n-{$i}" ) );
		}
		$this->assertCount( 16, $this->captured );

		$this->fetch( $node, $this->url_message( 'http://busy.example:8090/n-17' ) );

		$this->assertCount( 16, $this->captured, 'the 17th dispatches nothing' );
		$out = $this->only_emitted();
		$this->assertSame( Message::TM_ERROR, $out[ Message::TYPE ] );
		$this->assertSame( 'busy: 16 requests in flight http://busy.example:8090/n-17', $out[ Message::VALUE ] );

		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 200, 'body' => 'n-1 body', 'redirect' => '' ];
		$this->deliver_curl_rows( [ $this->done( $this->handles[0] ) ] );
		$this->fetch( $node, $this->url_message( 'http://busy.example:8090/n-18' ) );

		$this->assertCount( 17, $this->captured, 'a completed handle frees a slot' );
		$this->assertSame( 'http://busy.example:8090/n-18', $this->captured[16][ \CURLOPT_URL ] );
	}

	public function test_a_failed_dispatch_emits_curl_init_failed(): void {
		$lines = [];
		Core::set_stderr_handler( static function ( $line ) use ( &$lines ): void {
			$lines[] = $line;
		} );
		\Newspack_Nodes\Event_Framework::$curl_dispatch = static fn ( array $opts ): bool => false;
		$node = $this->curl();

		$this->fetch( $node, $this->url_message( 'http://no-handle.example:8090/init-53' ) );

		$out = $this->only_emitted();
		$this->assertSame( Message::TM_ERROR, $out[ Message::TYPE ] );
		$this->assertSame( 'curl_init failed http://no-handle.example:8090/init-53', $out[ Message::VALUE ] );
		$this->assertSame( 'corr-6081', $out[ Message::ID ] );
		$this->assertSame( [], \Newspack_Nodes\Event_Framework::instance()->handles_of( $node ) );
		$this->assertSame( [], $lines, 'the TM_ERROR is the one report' );
	}

	public function test_remove_node_counts_the_transfers_it_discards(): void {
		$lines = [];
		Core::set_stderr_handler( static function ( $line ) use ( &$lines ): void {
			$lines[] = $line;
		} );
		$node = $this->curl();
		$this->fetch( $node, $this->url_message( 'http://lost.example:8090/a-91' ) );
		$this->fetch( $node, $this->url_message( 'http://lost.example:8090/b-92' ) );

		$node->remove_node();

		$discards = \array_values( \array_filter( $lines, static fn ( string $line ): bool => \str_contains( $line, 'in flight' ) ) );
		$this->assertCount( 1, $discards );
		$this->assertStringContainsString( 'discarding 2 transfers in flight', $discards[0] );
	}

	public function test_remove_node_with_nothing_in_flight_logs_nothing(): void {
		$lines = [];
		Core::set_stderr_handler( static function ( $line ) use ( &$lines ): void {
			$lines[] = $line;
		} );

		$this->curl()->remove_node();

		$this->assertSame( [], $lines );
	}

	public function test_a_struct_emits_nothing_and_logs_one_line(): void {
		$lines = [];
		Core::set_stderr_handler( static function ( $line ) use ( &$lines ): void {
			$lines[] = $line;
		} );
		$node = $this->curl();

		$this->fetch( $node, $this->url_message( [ 'url' => 'http://struct.example/s-5' ], Message::TM_STRUCT ) );

		$this->assertSame( [], $this->sink->captured );
		$this->assertSame( [], $this->captured );
		$this->assertCount( 1, $lines );
		$this->assertStringContainsString( 'TM_STRUCT', $lines[0] );
	}

	public function test_a_blank_bytestream_is_an_invalid_url(): void {
		$this->fetch( $this->curl(), $this->url_message( " \n" ) );
		$this->assert_error( 'invalid url ' );
	}

	public function test_a_garbage_bytestream_is_an_invalid_url(): void {
		$this->fetch( $this->curl(), $this->url_message( "ftp://files.example/f-90\n" ) );
		$this->assert_error( 'invalid url ftp://files.example/f-90' );
	}

	public function test_a_hostless_url_is_invalid(): void {
		$this->fetch( $this->curl(), $this->url_message( 'http:///no-host-35' ) );
		$this->assert_error( 'invalid url http:///no-host-35' );
	}

	public function test_garbage_under_a_vault_group_is_an_invalid_url(): void {
		$this->seed_group();
		$this->fetch( $this->curl( 'crawl-g7' ), $this->url_message( 'not a url 66' ) );
		$this->assert_error( 'invalid url not a url 66' );
	}

	public function test_a_url_whose_authority_holds_two_at_signs_is_refused(): void {
		$this->seed_vault( 'spoke-31', [ 'url' => 'https://spoke-31.example', 'auth_username' => 'svc-31', 'auth_password' => 'pw-31', 'group' => 'crawl-g7' ] );

		$this->fetch( $this->curl( 'crawl-g7' ), $this->url_message( 'https://x@evil-44.example@spoke-31.example/steal-5' ) );

		$this->assert_error( 'invalid url carrying userinfo' );
	}

	public function test_a_url_carrying_userinfo_is_refused(): void {
		$this->fetch( $this->curl(), $this->url_message( 'https://svc-12:pw-77@plain-12.example/page-3' ) );

		$this->assert_error( 'invalid url carrying userinfo' );
	}

	public function test_remove_node_detaches_every_inflight_handle(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->url_message( 'http://many.example:8090/a-1' ) );
		$this->fetch( $node, $this->url_message( 'http://many.example:8090/b-2' ) );
		$this->assertCount( 2, \Newspack_Nodes\Event_Framework::instance()->handles_of( $node ) );
		$this->assertArrayHasKey( \spl_object_id( $node ), Event_Framework::instance()->curl_handles() );

		$node->remove_node();

		$this->assertSame( [], \Newspack_Nodes\Event_Framework::instance()->handles_of( $node ) );
		$this->assertSame( [], Event_Framework::instance()->curl_handles() );
	}

	public function test_the_vault_group_round_trips(): void {
		$node = $this->curl( 'crawl-g7' );

		$this->assertSame( [ 'crawl-g7' ], $node->arguments() );
		$this->assertStringContainsString( "make_node Curl fetch-7731 crawl-g7\n", $node->dump_config() );
	}

	public function test_node_schema_declares_one_vault_group_argument(): void {
		$schema = Curl_Node::node_schema();

		$this->assertSame( [ 'vault_group' ], \array_column( $schema['arguments'], 'name' ) );
		$this->assertSame( [ 'vault_group' ], \array_column( $schema['arguments'], 'type' ) );
	}

	public function test_the_vault_group_is_optional(): void {
		$node = $this->curl();

		$this->assertSame( [], $node->arguments() );
		$this->assertStringContainsString( "make_node Curl fetch-7731\n", $node->dump_config() );
	}
}
