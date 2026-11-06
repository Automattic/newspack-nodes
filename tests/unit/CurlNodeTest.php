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
		Curl_Node::$resolve       = null;
		Curl_Node::$prereq_available = null;
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
		$this->assertSame( 30000, $opts[ \CURLOPT_TIMEOUT_MS ], 'the whole transfer gets REQUEST_TIMEOUT' );
		$this->assertArrayNotHasKey( \CURLOPT_TIMEOUT, $opts );
		$this->assertSame( 'newspack-nodes/' . \NEWSPACK_NODES_VERSION, $opts[ \CURLOPT_USERAGENT ], 'a fetch names its client' );
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
		$this->assertSame( [ 'Authorization: Basic ' . \base64_encode( 'svc-n31:pw-n58' ) ], $this->authorization_of( 0 ) );
		$this->assertSame( 'HTTPS://SOUTH-52.example:443/y-2', $this->captured[1][ \CURLOPT_URL ] );
		$this->assertSame( [ 'Authorization: Basic ' . \base64_encode( 'svc-s52:pw-s19' ) ], $this->authorization_of( 1 ), 'the entry in another group is not counted' );
		$this->assertSame( [], $this->sink->captured );
	}

	public function test_a_named_header_entry_sends_its_whole_line(): void {
		$this->seed_vault( 'feed-12', [ 'url' => 'https://feed-12.example', 'auth_password' => 'feed-key-4410', 'auth_header' => 'X-Feed-Key-12', 'auth_scheme' => 'Key-5', 'group' => 'crawl-g7' ] );

		$this->fetch( $this->curl( 'crawl-g7' ), $this->url_message( 'https://feed-12.example/items-8' ) );

		$this->assertContains( 'X-Feed-Key-12: Key-5 feed-key-4410', $this->captured[0][ \CURLOPT_HTTPHEADER ] );
		$this->assertSame( [], $this->authorization_of( 0 ) );
	}

	/**
	 * libcurl drops only `Authorization` (and `Cookie`) when a redirect leaves
	 * the origin, so a request carrying a credential in any other header never
	 * follows a redirect.
	 */
	public function test_a_credential_in_another_header_follows_no_redirect(): void {
		$this->seed_vault( 'feed-12', [ 'url' => 'https://feed-12.example', 'auth_password' => 'feed-key-4410', 'auth_header' => 'X-Feed-Key-12', 'group' => 'crawl-g7' ] );
		$node = $this->curl( 'crawl-g7' );

		$this->fetch( $node, $this->url_message( 'https://feed-12.example/moved-9' ) );
		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 302, 'body' => '', 'redirect' => 'https://elsewhere-3.example/landed-9' ];
		$this->deliver_curl_rows( [ $this->done( $this->handles[0] ) ] );

		$this->assertFalse( $this->captured[0][ \CURLOPT_FOLLOWLOCATION ] );
		$out = $this->only_emitted();
		$this->assertSame( Message::TM_ERROR, $out[ Message::TYPE ] );
		$this->assertSame( 'redirect not followed: credential in X-Feed-Key-12 https://feed-12.example/moved-9', $out[ Message::VALUE ] );
		$this->assertStringNotContainsString( 'feed-key-4410', $out[ Message::VALUE ] );
	}

	public function test_a_guarded_credential_answers_a_redirect_location_when_following_none(): void {
		$this->seed_vault( 'feed-12', [ 'url' => 'https://feed-12.example', 'auth_password' => 'feed-key-4410', 'auth_header' => 'X-Feed-Key-12', 'group' => 'crawl-g7' ] );
		$node = $this->curl( 'crawl-g7' );
		$node->follow_redirects( false );

		$this->fetch( $node, $this->url_message( 'https://feed-12.example/moved-9' ) );
		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 301, 'body' => '', 'redirect' => 'https://feed-12.example/landed-10' ];
		$this->deliver_curl_rows( [ $this->done( $this->handles[0] ) ] );

		$out = $this->only_emitted();
		$this->assertSame( Message::TM_RESPONSE, $out[ Message::TYPE ] );
		$this->assertSame( 'https://feed-12.example/landed-10', $out[ Message::VALUE ] );
	}

	public function test_a_guarded_3xx_without_a_location_is_a_body_while_following(): void {
		$this->seed_vault( 'feed-12', [ 'url' => 'https://feed-12.example', 'auth_password' => 'feed-key-4410', 'auth_header' => 'X-Feed-Key-12', 'group' => 'crawl-g7' ] );
		$node = $this->curl( 'crawl-g7' );

		$this->fetch( $node, $this->url_message( 'https://feed-12.example/same-11' ) );
		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 304, 'body' => 'unchanged 11', 'redirect' => '' ];
		$this->deliver_curl_rows( [ $this->done( $this->handles[0] ) ] );

		$out = $this->only_emitted();
		$this->assertSame( Message::TM_BYTESTREAM, $out[ Message::TYPE ] );
		$this->assertSame( 'unchanged 11', $out[ Message::VALUE ] );
	}

	public function test_a_credential_named_authorization_in_any_case_still_follows_redirects(): void {
		$this->seed_vault( 'linear-6', [ 'url' => 'https://linear-6.example', 'auth_password' => 'lin-key-6604', 'auth_header' => 'authorization', 'group' => 'crawl-g7' ] );

		$this->fetch( $this->curl( 'crawl-g7' ), $this->url_message( 'https://linear-6.example/graphql' ) );

		$this->assertContains( 'authorization: lin-key-6604', $this->captured[0][ \CURLOPT_HTTPHEADER ] );
		$this->assertTrue( $this->captured[0][ \CURLOPT_FOLLOWLOCATION ] );
	}

	public function test_a_fetch_without_a_credential_keeps_following(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->url_message( 'https://open-31.example/a-1' ) );
		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 302, 'body' => 'moved body 31', 'redirect' => '' ];
		$this->deliver_curl_rows( [ $this->done( $this->handles[0] ) ] );

		$this->assertTrue( $this->captured[0][ \CURLOPT_FOLLOWLOCATION ] );
		$this->assertSame( Message::TM_BYTESTREAM, $this->only_emitted()[ Message::TYPE ] );
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
		$this->assertSame( [ 'Authorization: Basic ' . \base64_encode( 'svc-l6:pw-l6' ) ], $this->authorization_of( 0 ) );
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
		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 304, 'body' => 'not modified 61', 'redirect' => '' ];

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

	/**
	 * A teardown releases every transfer still in flight without a word: it
	 * is a planned exit, and the crawler requeues what it left in flight.
	 */
	public function test_remove_node_releases_its_transfers_in_flight_silently(): void {
		$lines = [];
		Core::set_stderr_handler( static function ( $line ) use ( &$lines ): void {
			$lines[] = $line;
		} );
		$node = $this->curl();
		$this->fetch( $node, $this->url_message( 'http://lost.example:8090/a-91' ) );
		$this->fetch( $node, $this->url_message( 'http://lost.example:8090/b-92' ) );
		$this->assertSame( 2, $node->transfers_in_flight() );

		$node->remove_node();

		$this->assertSame( 0, $node->transfers_in_flight() );
		$this->assertSame( [], \Newspack_Nodes\Event_Framework::instance()->handles_of( $node ) );
		$this->assertSame( [], $lines );
	}

	public function test_a_message_neither_a_url_nor_a_request_emits_nothing_and_logs_one_line(): void {
		$lines = [];
		Core::set_stderr_handler( static function ( $line ) use ( &$lines ): void {
			$lines[] = $line;
		} );
		$node = $this->curl();

		$this->fetch( $node, $this->url_message( 'http://info.example/s-5', Message::TM_INFO ) );

		$this->assertSame( [], $this->sink->captured );
		$this->assertSame( [], $this->captured );
		$this->assertCount( 1, $lines );
		$this->assertStringContainsString( 'TM_INFO', $lines[0] );
	}

	/** @param array<string,mixed> $request */
	private function request_message( array $request ): array {
		return $this->url_message( $request, Message::TM_STRUCT );
	}

	public function test_a_post_request_sends_its_body_as_json(): void {
		$node = $this->curl();
		$body = '{"query":"{ issues(first: 31) { nodes { id } } }"}';

		$this->fetch( $node, $this->request_message( [ 'url' => ' https://api.linear-9.example/graphql ', 'method' => 'POST', 'body' => $body ] ) );

		$this->assertCount( 1, $this->captured );
		$opts = $this->captured[0];
		$this->assertSame( 'https://api.linear-9.example/graphql', $opts[ \CURLOPT_URL ] );
		$this->assertTrue( $opts[ \CURLOPT_POST ] );
		$this->assertSame( $body, $opts[ \CURLOPT_POSTFIELDS ] );
		$this->assertArrayNotHasKey( \CURLOPT_HTTPGET, $opts );
		$this->assertContains( 'Content-Type: application/json', $opts[ \CURLOPT_HTTPHEADER ] );
		$this->assertSame( 'newspack-nodes/' . \NEWSPACK_NODES_VERSION, $opts[ \CURLOPT_USERAGENT ] );
		$this->assertSame( [], $this->sink->captured );
	}

	public function test_a_post_without_a_body_sends_an_empty_one(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://api.empty-4.example/ping', 'method' => 'POST' ] ) );

		$this->assertTrue( $this->captured[0][ \CURLOPT_POST ] );
		$this->assertSame( '', $this->captured[0][ \CURLOPT_POSTFIELDS ] );
	}

	public function test_a_get_request_fetches_as_the_url_form_does(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://slack-7.example/api/conversations.history?channel=C0-61', 'method' => 'GET' ] ) );

		$opts = $this->captured[0];
		$this->assertSame( 'https://slack-7.example/api/conversations.history?channel=C0-61', $opts[ \CURLOPT_URL ] );
		$this->assertTrue( $opts[ \CURLOPT_HTTPGET ] );
		$this->assertArrayNotHasKey( \CURLOPT_POST, $opts );
		$this->assertSame( [], \preg_grep( '/^Content-Type:/', $opts[ \CURLOPT_HTTPHEADER ] ?? [] ) );
	}

	public function test_a_request_answers_with_a_copy_of_itself_carrying_the_body(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->request_message( [ 'url' => 'https://api.linear-9.example/graphql', 'method' => 'POST', 'body' => '{"q":1}' ] ) );
		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 200, 'body' => '{"data":{"n":4471}}', 'redirect' => '' ];

		$this->deliver_curl_rows( [ $this->done( $this->handles[0] ) ] );

		$out = $this->only_emitted();
		$this->assertSame( Message::TM_BYTESTREAM, $out[ Message::TYPE ] );
		$this->assertSame( '{"data":{"n":4471}}', $out[ Message::VALUE ] );
		$this->assertSame( 'asker-5519/reply', $out[ Message::FROM ] );
		$this->assertSame( 'corr-6081', $out[ Message::ID ] );
		$this->assertSame( 'key-2297', $out[ Message::KEY ] );
		$this->assertSame( 'fetched-4402', $out[ Message::TO ] );
	}

	public function test_a_request_error_names_its_url(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->request_message( [ 'url' => 'https://api.linear-9.example/graphql', 'method' => 'POST', 'body' => '{}' ] ) );
		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 401, 'body' => 'no', 'redirect' => '' ];

		$this->deliver_curl_rows( [ $this->done( $this->handles[0] ) ] );

		$this->assertSame( 'HTTP 401 https://api.linear-9.example/graphql', $this->only_emitted()[ Message::VALUE ] );
	}

	/** @return array<string,array{0:array<string,mixed>,1:string}> */
	public static function refused_request_provider(): array {
		$url = 'https://api.refuse-5.example/x-2';
		return [
			'lowercase method' => [ [ 'url' => $url, 'method' => 'post', 'body' => '{}' ], "invalid method post {$url}" ],
			'unknown method'   => [ [ 'url' => $url, 'method' => 'PATCH' ], "invalid method PATCH {$url}" ],
			'body on a DELETE' => [ [ 'url' => $url, 'method' => 'DELETE', 'body' => '' ], "body on a DELETE {$url}" ],
			'no method'        => [ [ 'url' => $url ], "invalid method  {$url}" ],
			'array method'     => [ [ 'url' => $url, 'method' => [ 'GET' ] ], "invalid method  {$url}" ],
			'body on a GET'    => [ [ 'url' => $url, 'method' => 'GET', 'body' => '{"a":1}' ], "body on a GET {$url}" ],
			'empty body GET'   => [ [ 'url' => $url, 'method' => 'GET', 'body' => '' ], "body on a GET {$url}" ],
			'array body'       => [ [ 'url' => $url, 'method' => 'POST', 'body' => [ 'a' => 1 ] ], "invalid body {$url}" ],
			'oversized body'   => [ [ 'url' => $url, 'method' => 'POST', 'body' => \str_repeat( 'x', 65537 ) ], "body over 65536 bytes {$url}" ],
			'no url'           => [ [ 'method' => 'GET' ], 'invalid url ' ],
			'not a map'        => [ [ 'https://api.refuse-5.example/x-2' ], 'invalid url ' ],
		];
	}

	/** @param array<string,mixed> $request */
	#[\PHPUnit\Framework\Attributes\DataProvider( 'refused_request_provider' )]
	public function test_a_malformed_request_is_refused_naming_its_url( array $request, string $expected ): void {
		$this->fetch( $this->curl(), $this->request_message( $request ) );
		$this->assert_error( $expected );
	}

	public function test_a_body_of_exactly_the_cap_is_sent(): void {
		$this->assertSame( 65536, Curl_Node::DEFAULT_BODY_CAP );
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://api.cap-6.example/x', 'method' => 'POST', 'body' => \str_repeat( 'y', 65536 ) ] ) );

		$this->assertSame( 65536, \strlen( $this->captured[0][ \CURLOPT_POSTFIELDS ] ) );
	}

	/** `set_body_cap()` raises the body this node sends, and a body past it is refused naming the cap. */
	public function test_set_body_cap_raises_the_body_a_request_may_carry(): void {
		$node = $this->curl();
		$url  = 'https://proxy-4.example/chat';

		$node->set_body_cap( 471223 );
		$this->fetch( $node, $this->request_message( [ 'url' => $url, 'method' => 'POST', 'body' => \str_repeat( 'z', 471223 ) ] ) );
		$this->fetch( $node, $this->request_message( [ 'url' => $url, 'method' => 'POST', 'body' => \str_repeat( 'z', 471224 ) ] ) );

		$this->assertCount( 1, $this->captured );
		$this->assertSame( 471223, \strlen( $this->captured[0][ \CURLOPT_POSTFIELDS ] ) );
		$this->assertSame( "body over 471223 bytes {$url}", $this->only_emitted()[ Message::VALUE ] );
	}

	public function test_the_body_cap_is_per_node(): void {
		$this->curl()->set_body_cap( 524288 );
		$other = new Curl_Node();
		$other->name( 'fetch-8840' );
		$other->sink( $this->sink );

		$this->fetch( $other, $this->request_message( [ 'url' => 'https://proxy-4.example/chat', 'method' => 'POST', 'body' => \str_repeat( 'z', 65537 ) ] ) );

		$this->assertSame( 'body over 65536 bytes https://proxy-4.example/chat', $this->only_emitted()[ Message::VALUE ] );
	}

	public function test_a_body_cap_of_one_mib_is_taken(): void {
		$node = $this->curl();
		$node->set_body_cap( 1048576 );

		$this->fetch( $node, $this->request_message( [ 'url' => 'https://proxy-4.example/chat', 'method' => 'POST', 'body' => \str_repeat( 'z', 1048576 ) ] ) );

		$this->assertSame( 1048576, \strlen( $this->captured[0][ \CURLOPT_POSTFIELDS ] ) );
	}

	/** @return array<string,array{0:int}> */
	public static function refused_body_cap_provider(): array {
		return [
			'below the default' => [ 65535 ],
			'zero'              => [ 0 ],
			'past one MiB'      => [ 1048577 ],
		];
	}

	/** A body cap outside DEFAULT_BODY_CAP to 1 MiB is refused, and the cap in force stays. */
	#[\PHPUnit\Framework\Attributes\DataProvider( 'refused_body_cap_provider' )]
	public function test_a_body_cap_outside_its_range_is_refused( int $bytes ): void {
		$node = $this->curl();
		$node->set_body_cap( 300007 );
		try {
			$node->set_body_cap( $bytes );
			$this->fail( 'set_body_cap refuses' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertSame( "body cap wants a whole number from 65536 to 1048576, got '{$bytes}'", $e->getMessage() );
		}

		$this->fetch( $node, $this->request_message( [ 'url' => 'https://proxy-4.example/chat', 'method' => 'POST', 'body' => \str_repeat( 'z', 300008 ) ] ) );
		$this->assertSame( 'body over 300007 bytes https://proxy-4.example/chat', $this->only_emitted()[ Message::VALUE ] );
	}

	public function test_a_curl_carries_no_config_interpreter(): void {
		$node = $this->curl();
		$node->set_body_cap( 200003 );

		$this->assertNull( Core::node( 'fetch-7731:config' ) );
		$this->assertStringNotContainsString( 'body_cap', $node->dump_config() );
		$this->assertSame( [], Curl_Node::node_schema()['commands'] );
	}

	public function test_a_request_on_a_group_origin_carries_its_credential(): void {
		$this->seed_vault( 'linear-6', [ 'url' => 'https://api.linear-6.example', 'auth_password' => 'lin-key-6604', 'auth_header' => 'Authorization', 'group' => 'crawl-g7' ] );

		$this->fetch( $this->curl( 'crawl-g7' ), $this->request_message( [ 'url' => 'https://api.linear-6.example/graphql', 'method' => 'POST', 'body' => '{}' ] ) );

		$this->assertSame( [ 'Content-Type: application/json', 'Authorization: lin-key-6604' ], $this->captured[0][ \CURLOPT_HTTPHEADER ] );
	}

	public function test_a_request_shares_the_origin_refusal(): void {
		$this->seed_vault_servers(
			[
				'twin-b' => [ 'url' => 'https://twin-12.example/b', 'auth_username' => 'svc-b', 'auth_password' => 'pw-b', 'group' => 'crawl-g7' ],
				'twin-a' => [ 'url' => 'https://twin-12.example/a', 'auth_username' => 'svc-a', 'auth_password' => 'pw-a', 'group' => 'crawl-g7' ],
			]
		);

		$this->fetch( $this->curl( 'crawl-g7' ), $this->request_message( [ 'url' => 'https://twin-12.example/q-4', 'method' => 'POST', 'body' => '{}' ] ) );

		$this->assert_error( 'vault entries twin-a, twin-b share origin https://twin-12.example:443 https://twin-12.example/q-4' );
	}

	public function test_a_request_shares_vault_require_ssl(): void {
		$this->use_base_dir( $this->make_temp_dir(), [ 'vault_require_ssl' => true ] );
		$this->seed_vault( 'plain-7', [ 'url' => 'http://plain-7.example:8081', 'auth_username' => 'svc-p7', 'auth_password' => 'pw-p7', 'group' => 'crawl-g7' ] );

		$this->fetch( $this->curl( 'crawl-g7' ), $this->request_message( [ 'url' => 'http://plain-7.example:8081/gql-3', 'method' => 'POST', 'body' => '{}' ] ) );

		$this->assert_error( 'vault_require_ssl set but url is not https http://plain-7.example:8081/gql-3' );
	}

	public function test_a_request_sends_its_headers_after_the_json_type(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://mcp-8.example/v1', 'method' => 'POST', 'body' => '{}', 'headers' => [ 'Accept: application/json, text/event-stream', 'Authorization: Bearer file-token-5512', 'Mcp-Session-Id: sess-4471' ] ] ) );

		$this->assertSame( [ 'Content-Type: application/json', 'Accept: application/json, text/event-stream', 'Authorization: Bearer file-token-5512', 'Mcp-Session-Id: sess-4471' ], $this->captured[0][ \CURLOPT_HTTPHEADER ] );
	}

	public function test_a_content_type_header_replaces_the_json_type(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://token-3.example/oauth', 'method' => 'POST', 'body' => 'grant_type=refresh_token', 'headers' => [ 'content-TYPE: application/x-www-form-urlencoded' ] ] ) );

		$this->assertSame( [ 'content-TYPE: application/x-www-form-urlencoded' ], $this->captured[0][ \CURLOPT_HTTPHEADER ] );
	}

	public function test_a_get_request_sends_its_headers(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://mcp-8.example/v1', 'method' => 'GET', 'headers' => [ 'Accept: text/plain-73' ] ] ) );

		$this->assertSame( [ 'Accept: text/plain-73' ], $this->captured[0][ \CURLOPT_HTTPHEADER ] );
	}

	public function test_a_request_header_rides_before_the_vault_credential(): void {
		$this->seed_vault( 'mcp-6', [ 'url' => 'https://mcp-6.example', 'auth_password' => 'vault-key-6604', 'auth_header' => 'X-Api-Key', 'group' => 'crawl-g7' ] );

		$this->fetch( $this->curl( 'crawl-g7' ), $this->request_message( [ 'url' => 'https://mcp-6.example/v1', 'method' => 'POST', 'body' => '{}', 'headers' => [ 'Mcp-Session-Id: sess-9031' ] ] ) );

		$this->assertSame( [ 'Content-Type: application/json', 'Mcp-Session-Id: sess-9031', 'X-Api-Key: vault-key-6604' ], $this->captured[0][ \CURLOPT_HTTPHEADER ] );
	}

	public function test_authorization_beside_a_vault_credential_is_refused(): void {
		$this->seed_vault( 'mcp-6', [ 'url' => 'https://mcp-6.example', 'auth_password' => 'vault-key-6604', 'auth_header' => 'X-Api-Key', 'group' => 'crawl-g7' ] );

		$this->fetch( $this->curl( 'crawl-g7' ), $this->request_message( [ 'url' => 'https://mcp-6.example/v1', 'method' => 'POST', 'body' => '{}', 'headers' => [ 'AUTHORIZATION: Bearer file-token-5512' ] ] ) );

		$this->assert_error( 'refused header AUTHORIZATION beside a vault credential https://mcp-6.example/v1' );
	}

	public function test_a_proxy_beside_a_vault_credential_on_a_plain_url_is_refused(): void {
		$this->seed_vault( 'plain-9', [ 'url' => 'http://plain-9.example:8093', 'auth_password' => 'vault-key-9937', 'auth_header' => 'X-Api-Key', 'group' => 'crawl-g7' ] );

		$this->fetch( $this->curl( 'crawl-g7' ), $this->request_message( [ 'url' => 'http://plain-9.example:8093/v1', 'method' => 'GET', 'proxy' => 'http://proxy-6.example:3128' ] ) );

		$this->assertSame( [], $this->captured );
		$this->assert_error( 'refused proxy beside a credential on a plain url http://plain-9.example:8093/v1' );
	}

	/** A request carrying header lines of its own takes a proxy only over https, as one carrying a vault credential does. */
	public function test_a_proxy_beside_request_headers_on_a_plain_url_is_refused(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'http://plain-4.example:8094/v1', 'method' => 'GET', 'headers' => [ 'X-Session-7: s-4410' ], 'proxy' => 'http://proxy-6.example:3128' ] ) );

		$this->assert_error( 'refused proxy beside a credential on a plain url http://plain-4.example:8094/v1' );
	}

	public function test_a_proxy_beside_request_headers_on_an_https_url_tunnels(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://mcp-8.example/v1', 'method' => 'GET', 'headers' => [ 'X-Session-7: s-4410' ], 'proxy' => 'socks5h://proxy-6.example:1086' ] ) );

		$this->assertSame( 'socks5h://proxy-6.example:1086', $this->captured[0][ \CURLOPT_PROXY ] );
	}

	/**
	 * A request carrying header lines of its own never follows a redirect,
	 * since any of them may be a credential libcurl would carry along, and a
	 * 3xx answers as the credential guard's does, without naming a value.
	 */
	public function test_request_headers_follow_no_redirect(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->request_message( [ 'url' => 'https://mcp-8.example/moved-5', 'method' => 'GET', 'headers' => [ 'X-Session-7: s-4410' ] ] ) );
		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 307, 'body' => '', 'redirect' => 'https://elsewhere-3.example/landed-5' ];
		$this->deliver_curl_rows( [ $this->done( $this->handles[0] ) ] );

		$this->assertFalse( $this->captured[0][ \CURLOPT_FOLLOWLOCATION ] );
		$this->assertSame( 'redirect not followed: credential in request headers https://mcp-8.example/moved-5', $this->only_emitted()[ Message::VALUE ] );
		$this->assertStringNotContainsString( 's-4410', $this->only_emitted()[ Message::VALUE ] );
	}

	/** A DELETE never follows a redirect, so its method is never sent to another url. */
	public function test_a_delete_follows_no_redirect(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->request_message( [ 'url' => 'https://mcp-8.example/v1', 'method' => 'DELETE' ] ) );
		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 308, 'body' => '', 'redirect' => 'https://elsewhere-3.example/v2' ];
		$this->deliver_curl_rows( [ $this->done( $this->handles[0] ) ] );

		$this->assertFalse( $this->captured[0][ \CURLOPT_FOLLOWLOCATION ] );
		$this->assertSame( 'redirect not followed: a DELETE https://mcp-8.example/v1', $this->only_emitted()[ Message::VALUE ] );
	}

	/** A plain GET with no credential and no header lines still follows redirects. */
	public function test_a_plain_request_still_follows_redirects(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://mcp-8.example/v1', 'method' => 'GET' ] ) );

		$this->assertTrue( $this->captured[0][ \CURLOPT_FOLLOWLOCATION ] );
	}

	public function test_a_proxy_beside_a_vault_credential_on_an_https_url_tunnels(): void {
		$this->seed_vault( 'mcp-6', [ 'url' => 'https://mcp-6.example', 'auth_password' => 'vault-key-6604', 'auth_header' => 'X-Api-Key', 'group' => 'crawl-g7' ] );

		$this->fetch( $this->curl( 'crawl-g7' ), $this->request_message( [ 'url' => 'https://mcp-6.example/v1', 'method' => 'GET', 'proxy' => 'socks5h://proxy-6.example:1086' ] ) );

		$this->assertSame( 'socks5h://proxy-6.example:1086', $this->captured[0][ \CURLOPT_PROXY ] );
	}

	public function test_authorization_on_an_origin_the_group_lends_nothing_is_sent(): void {
		$this->seed_vault( 'mcp-6', [ 'url' => 'https://mcp-6.example', 'auth_password' => 'vault-key-6604', 'auth_header' => 'X-Api-Key', 'group' => 'crawl-g7' ] );

		$this->fetch( $this->curl( 'crawl-g7' ), $this->request_message( [ 'url' => 'https://elsewhere-2.example/v1', 'method' => 'POST', 'body' => '{}', 'headers' => [ 'Authorization: Bearer file-token-5512' ] ] ) );

		$this->assertSame( [ 'Content-Type: application/json', 'Authorization: Bearer file-token-5512' ], $this->captured[0][ \CURLOPT_HTTPHEADER ] );
	}

	/** @return array<string,array{0:mixed,1:string}> */
	public static function refused_headers_provider(): array {
		$url = 'https://mcp-8.example/v1';
		return [
			'host'              => [ [ 'Accept: x', 'hOsT: evil-1.example' ], "refused header hOsT {$url}" ],
			'cookie'            => [ [ 'Cookie: a=1' ], "refused header Cookie {$url}" ],
			'content-length'    => [ [ 'CONTENT-LENGTH: 9' ], "refused header CONTENT-LENGTH {$url}" ],
			'transfer-encoding' => [ [ 'Transfer-Encoding: chunked' ], "refused header Transfer-Encoding {$url}" ],
			'connection'        => [ [ 'connection: close' ], "refused header connection {$url}" ],
			'expect'            => [ [ 'Expect: 100-continue' ], "refused header Expect {$url}" ],
			'upgrade'           => [ [ 'upgrade: h2c' ], "refused header upgrade {$url}" ],
			'te'                => [ [ 'TE: trailers' ], "refused header TE {$url}" ],
			'keep-alive'        => [ [ 'Keep-Alive: timeout=5' ], "refused header Keep-Alive {$url}" ],
			'proxy-connection'  => [ [ 'Proxy-Connection: keep-alive' ], "refused header Proxy-Connection {$url}" ],
			'proxy-auth'        => [ [ 'Proxy-Authorization: Basic eDp5' ], "refused header Proxy-Authorization {$url}" ],
			'empty value'       => [ [ 'User-Agent:' ], "empty header User-Agent {$url}" ],
			'blank value'       => [ [ "Accept: \t " ], "empty header Accept {$url}" ],
			'carriage return'   => [ [ "Accept: x\rHost: evil-2.example" ], "header carries CR or LF {$url}" ],
			'line feed'         => [ [ "Mcp-Session-Id: s-1\nCookie: a=1" ], "header carries CR or LF {$url}" ],
			'not a list'        => [ [ 'Accept' => 'x' ], "invalid headers {$url}" ],
			'not a string'      => [ [ [ 'Accept: x' ] ], "invalid headers {$url}" ],
			'no name'           => [ [ ': x' ], "invalid headers {$url}" ],
			'no colon'          => [ [ 'Accept x' ], "invalid headers {$url}" ],
			'bad name'          => [ [ 'Acc ept: x' ], "invalid headers {$url}" ],
			'a string'          => [ 'Accept: x', "invalid headers {$url}" ],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider( 'refused_headers_provider' )]
	public function test_a_request_header_that_would_rewrite_the_request_is_refused( mixed $headers, string $expected ): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://mcp-8.example/v1', 'method' => 'POST', 'body' => '{}', 'headers' => $headers ] ) );

		$this->assert_error( $expected );
	}

	/** @return array<string,array{0:string}> */
	public static function proxy_provider(): array {
		return [
			'socks5h' => [ 'socks5h://host.docker.internal:8080' ],
			'socks5'  => [ 'socks5://10.0.4.7:1081' ],
			'http'    => [ 'http://proxy-3.example:3128' ],
			'https'   => [ 'HTTPS://proxy-4.example:8443/' ],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider( 'proxy_provider' )]
	public function test_a_request_naming_a_proxy_fetches_through_it( string $proxy ): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://mcp-8.example/v1', 'method' => 'POST', 'body' => '{}', 'proxy' => $proxy ] ) );

		$this->assertCount( 1, $this->captured );
		$this->assertSame( $proxy, $this->captured[0][ \CURLOPT_PROXY ] );
		$this->assertSame( '', $this->captured[0][ \CURLOPT_NOPROXY ], 'no environment variable bypasses the proxy' );
	}

	/** A proxy's TLS takes the vault's posture, as the server's does. */
	public function test_a_proxy_takes_the_vaults_tls_posture(): void {
		$this->use_base_dir( $this->make_temp_dir(), [ 'vault_verify_ssl' => false ] );

		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://mcp-8.example/v1', 'method' => 'GET', 'proxy' => 'https://proxy-4.example:8443' ] ) );

		$this->assertFalse( $this->captured[0][ \CURLOPT_PROXY_SSL_VERIFYPEER ] );
		$this->assertSame( 0, $this->captured[0][ \CURLOPT_PROXY_SSL_VERIFYHOST ] );
	}

	/** A request header naming the header the vault's credential for the origin rides in is refused. */
	public function test_a_request_header_naming_the_credentials_header_is_refused(): void {
		$this->seed_vault( 'mcp-6', [ 'url' => 'https://mcp-6.example', 'auth_password' => 'vault-key-6604', 'auth_header' => 'X-Api-Key', 'group' => 'crawl-g7' ] );

		$this->fetch( $this->curl( 'crawl-g7' ), $this->request_message( [ 'url' => 'https://mcp-6.example/v1', 'method' => 'POST', 'body' => '{}', 'headers' => [ 'x-API-key: forged-2210' ] ] ) );

		$this->assert_error( 'refused header x-API-key beside a vault credential https://mcp-6.example/v1' );
	}

	/** A DELETE sends no body and the method by name, and is answered as any request. */
	public function test_a_delete_request_sends_the_method_and_no_body(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://mcp-8.example/v1', 'method' => 'DELETE', 'headers' => [ 'Mcp-Session-Id: sess-end-4471' ] ] ) );

		$opts = $this->captured[0];
		$this->assertSame( 'DELETE', $opts[ \CURLOPT_CUSTOMREQUEST ] );
		$this->assertArrayNotHasKey( \CURLOPT_POSTFIELDS, $opts );
		$this->assertSame( [ 'Mcp-Session-Id: sess-end-4471' ], $opts[ \CURLOPT_HTTPHEADER ] );
	}

	/** A request naming a connect timeout bounds the connection by it, under the transfer's own timeout. */
	public function test_a_request_naming_a_connect_timeout_bounds_the_connection(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://feeds-9.example/feed/', 'method' => 'GET', 'connect_timeout' => 7 ] ) );

		$this->assertSame( 7, $this->captured[0][ \CURLOPT_CONNECTTIMEOUT ] );
		$this->assertSame( 30000, $this->captured[0][ \CURLOPT_TIMEOUT_MS ] );
	}

	public function test_a_request_naming_no_connect_timeout_sets_none(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->request_message( [ 'url' => 'https://feeds-9.example/feed/', 'method' => 'GET' ] ) );
		$this->fetch( $node, $this->url_message( 'https://feeds-9.example/rss' ) );

		$this->assertArrayNotHasKey( \CURLOPT_CONNECTTIMEOUT, $this->captured[0] );
		$this->assertArrayNotHasKey( \CURLOPT_CONNECTTIMEOUT, $this->captured[1] );
	}

	/** @return array<string,array{0:mixed}> */
	public static function refused_connect_timeout_provider(): array {
		return [
			'zero'            => [ 0 ],
			'negative'        => [ -4 ],
			'past the total'  => [ 31 ],
			'a numeric string' => [ '10' ],
			'a float'         => [ 2.5 ],
		];
	}

	/** A connect timeout that is not whole seconds from 1 to the transfer's own timeout is refused. */
	#[\PHPUnit\Framework\Attributes\DataProvider( 'refused_connect_timeout_provider' )]
	public function test_a_connect_timeout_outside_the_transfers_is_refused( mixed $seconds ): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://feeds-9.example/feed/', 'method' => 'GET', 'connect_timeout' => $seconds ] ) );

		$this->assert_error( 'invalid connect timeout https://feeds-9.example/feed/' );
	}

	/** A request naming a timeout bounds its whole transfer by it, in place of REQUEST_TIMEOUT. */
	public function test_a_request_naming_a_timeout_bounds_the_transfer(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->request_message( [ 'url' => 'https://proxy-4.example/chat', 'method' => 'POST', 'body' => '{}', 'timeout' => 97 ] ) );
		$this->fetch( $node, $this->request_message( [ 'url' => 'https://proxy-4.example/chat', 'method' => 'POST', 'body' => '{}', 'timeout' => 120 ] ) );

		$this->assertSame( 97000, $this->captured[0][ \CURLOPT_TIMEOUT_MS ] );
		$this->assertSame( 120000, $this->captured[1][ \CURLOPT_TIMEOUT_MS ], 'the ceiling itself is taken' );
	}

	public function test_a_request_naming_no_timeout_takes_request_timeout(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://proxy-4.example/chat', 'method' => 'GET', 'connect_timeout' => 11 ] ) );

		$this->assertSame( 30000, $this->captured[0][ \CURLOPT_TIMEOUT_MS ] );
	}

	/** @return array<string,array{0:mixed}> */
	public static function refused_timeout_provider(): array {
		return [
			'zero'             => [ 0 ],
			'negative'         => [ -6 ],
			'past the ceiling' => [ 121 ],
			'a numeric string' => [ '45' ],
			'a float'          => [ 4.5 ],
			'a boolean'        => [ true ],
		];
	}

	/** A timeout that is not whole seconds from 1 to 120 is refused before any transfer starts. */
	#[\PHPUnit\Framework\Attributes\DataProvider( 'refused_timeout_provider' )]
	public function test_a_timeout_outside_one_to_120_seconds_is_refused( mixed $seconds ): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://proxy-4.example/chat', 'method' => 'GET', 'timeout' => $seconds ] ) );

		$this->assert_error( 'invalid timeout https://proxy-4.example/chat' );
	}

	/** A connect timeout may run to the request's own timeout, past REQUEST_TIMEOUT. */
	public function test_a_connect_timeout_is_bounded_by_the_requests_timeout(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://proxy-4.example/chat', 'method' => 'GET', 'timeout' => 64, 'connect_timeout' => 64 ] ) );

		$this->assertSame( 64, $this->captured[0][ \CURLOPT_CONNECTTIMEOUT ] );
		$this->assertSame( 64000, $this->captured[0][ \CURLOPT_TIMEOUT_MS ] );
	}

	public function test_a_connect_timeout_past_the_requests_timeout_is_refused(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://proxy-4.example/chat', 'method' => 'GET', 'timeout' => 12, 'connect_timeout' => 13 ] ) );

		$this->assert_error( 'invalid connect timeout https://proxy-4.example/chat' );
	}

	/** The timeout is read first, so a bad one is what the refusal names, whatever the connect timeout. */
	public function test_an_invalid_timeout_is_refused_before_the_connect_timeout_is_read(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://proxy-4.example/chat', 'method' => 'GET', 'timeout' => 0, 'connect_timeout' => 'x' ] ) );

		$this->assert_error( 'invalid timeout https://proxy-4.example/chat' );
	}

	/** Pin the fake clock at $at, which a test moves on by reference. */
	private function pin_clock( float &$at ): void {
		Core::$clock = static function () use ( &$at ): float {
			return $at;
		};
	}

	/**
	 * A public-only request's hops share one deadline: each gets what remains,
	 * read when the hop starts, after the drain pinned its tick, and one due
	 * past the deadline never starts.
	 */
	public function test_a_chain_of_slow_redirects_shares_the_requests_deadline(): void {
		$at = 1900000000.0;
		$this->pin_clock( $at );
		$node = $this->curl();
		$this->fetch( $node, $this->public_only( 'https://slow-1.example/a', [ 'timeout' => 50 ] ) );
		$this->assertSame( 50000, $this->captured[0][ \CURLOPT_TIMEOUT_MS ] );

		$this->answer_with( 302, '', 'https://slow-2.example/b', '93.184.215.14' );
		$this->deliver_late( [ $this->done( $this->handles[0] ) ], static function () use ( &$at ): void {
			$at += 20.25;
		} );
		$this->assertSame( 29750, $this->captured[1][ \CURLOPT_TIMEOUT_MS ], 'the hop gets what remains' );

		$this->answer_with( 302, '', 'https://slow-3.example/c', '93.184.215.15' );
		$this->deliver_late( [ $this->done( $this->handles[1] ) ], static function () use ( &$at ): void {
			$at += 29.749;
		} );
		$this->assertSame( 1, $this->captured[2][ \CURLOPT_TIMEOUT_MS ], 'the last millisecond is still given' );

		$this->answer_with( 302, '', 'https://slow-4.example/d', '93.184.215.16' );
		$this->deliver_late( [ $this->done( $this->handles[2] ) ], static function () use ( &$at ): void {
			$at += 0.001;
		} );
		$this->assertCount( 3, $this->captured, 'no hop starts once the deadline has passed' );
		$this->assertSame( 'timed out https://slow-4.example/d', $this->only_emitted()[ Message::VALUE ] );
	}

	/** On a PHP without PREREQFUNCTION the blocking lookup is charged to the request's timeout. */
	public function test_a_lookup_before_the_transfer_is_charged_to_its_timeout(): void {
		$at = 1900000000.0;
		$this->pin_clock( $at );
		$this->resolve_slowly( $at, 2.5 );

		$this->fetch( $this->curl(), $this->public_only( 'https://slow-dns-1.example/a', [ 'timeout' => 9 ] ) );

		$this->assertSame( 6500, $this->captured[0][ \CURLOPT_TIMEOUT_MS ] );
	}

	public function test_a_lookup_outlasting_the_timeout_starts_no_transfer(): void {
		$at = 1900000000.0;
		$this->pin_clock( $at );
		$this->resolve_slowly( $at, 9.0 );

		$this->fetch( $this->curl(), $this->public_only( 'https://slow-dns-1.example/a', [ 'timeout' => 9 ] ) );

		$this->assert_error( 'timed out https://slow-dns-1.example/a' );
	}

	/** Run without PREREQFUNCTION, each lookup answering one public address $seconds after it was asked. */
	private function resolve_slowly( float &$at, float $seconds ): void {
		Curl_Node::$prereq_available = static fn (): bool => false;
		Curl_Node::$resolve          = static function ( string $host ) use ( &$at, $seconds ): array {
			$at += $seconds;
			return [ '93.184.215.14' ];
		};
	}

	/**
	 * Complete transfers inside a running drain loop, running $late inside the
	 * poll, after the drain pinned `Core::$now`, as a select wait would.
	 */
	private function deliver_late( array $rows, \Closure $late ): void {
		$delivered = false;
		Event_Framework::instance()->drain(
			static function () use ( $rows, $late, &$delivered ): bool {
				if ( ! $delivered ) {
					$delivered                  = true;
					Event_Framework::$curl_poll = static function () use ( $rows, $late ): array {
						$late();
						return $rows;
					};
					try {
						( new \ReflectionMethod( Event_Framework::class, 'drain_curl_multi' ) )->invoke( Event_Framework::instance() );
					} finally {
						Event_Framework::$curl_poll = null;
					}
				}
				return false;
			}
		);
	}

	/** Complete transfers inside a running drain loop, where a redirect's next hop may start. */
	private function deliver_in_loop( array $rows ): void {
		$delivered = false;
		Event_Framework::instance()->drain(
			function () use ( $rows, &$delivered ): bool {
				if ( ! $delivered ) {
					$delivered = true;
					$this->deliver_curl_rows( $rows );
				}
				return false;
			}
		);
	}

	/** A request a response chose: a public-only GET of the url, every name resolving to one public address unless a test says otherwise. */
	private function public_only( string $url, array $more = [] ): array {
		Curl_Node::$resolve ??= static fn ( string $host ): array => [ '93.184.215.14' ];
		return $this->request_message( [ 'url' => $url, 'method' => 'GET', 'public_only' => true, ...$more ] );
	}

	/**
	 * Run as on a PHP without `CURLOPT_PREREQFUNCTION`, answering each lookup
	 * from the list in turn and recording every host asked.
	 *
	 * @param list<list<string>> $answers Each lookup's addresses.
	 * @return \ArrayObject<int,string> The hosts asked, in order.
	 */
	private function without_prereq_resolving( array $answers ): \ArrayObject {
		Curl_Node::$prereq_available = static fn (): bool => false;
		$asked                       = new \ArrayObject();
		Curl_Node::$resolve = static function ( string $host ) use ( &$answers, $asked ): array {
			$asked[] = $host;
			return \array_shift( $answers ) ?? [];
		};
		return $asked;
	}

	/** The check dispatch $i hands libcurl to run once connected, before sending. */
	private function prereq_of( int $i ): \Closure {
		$prereq = $this->captured[ $i ][ \CURLOPT_PREREQFUNCTION ] ?? null;
		$this->assertInstanceOf( \Closure::class, $prereq, "dispatch {$i} checks before sending" );
		return $prereq;
	}

	/** A pinned transfer opens a connection of its own, since libcurl reuses one by host and port, never by pinned address. */
	public function test_a_pinned_public_only_transfer_takes_a_fresh_connection(): void {
		$this->without_prereq_resolving( [ [ '93.184.215.53' ] ] );

		$this->fetch( $this->curl(), $this->public_only( 'https://feed-53.example/feed/' ) );

		$this->assertTrue( $this->captured[0][ \CURLOPT_FRESH_CONNECT ] );
	}

	public function test_an_unpinned_transfer_reuses_connections(): void {
		$this->fetch( $this->curl(), $this->public_only( 'https://feed-54.example/feed/' ) );

		$this->assertArrayNotHasKey( \CURLOPT_FRESH_CONNECT, $this->captured[0] );
	}

	/** An empty proxy turns off every proxy, the environment's included, whose address both checks would read instead. */
	public function test_a_public_only_transfer_goes_through_no_proxy_the_environment_names(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->public_only( 'https://feed-55.example/feed/' ) );
		$this->fetch( $node, $this->request_message( [ 'url' => 'https://feed-56.example/feed/', 'method' => 'GET' ] ) );

		$this->assertSame( '', $this->captured[0][ \CURLOPT_PROXY ] );
		$this->assertArrayNotHasKey( \CURLOPT_PROXY, $this->captured[1] );
	}

	public function test_a_busy_node_refuses_a_public_only_request_before_any_lookup(): void {
		$node = $this->curl();
		for ( $i = 0; $i < Curl_Node::MAX_IN_FLIGHT; $i++ ) {
			$this->fetch( $node, $this->url_message( "https://busy-57.example/{$i}" ) );
		}
		$asked = $this->without_prereq_resolving( [ [ '93.184.215.57' ] ] );
		$this->captured = [];

		$this->fetch( $node, $this->public_only( 'https://feed-57.example/feed/' ) );

		$this->assertSame( [], $asked->getArrayCopy() );
		$this->assert_error( 'busy: 16 requests in flight https://feed-57.example/feed/' );
	}

	public function test_a_malformed_public_only_request_is_refused_before_any_lookup(): void {
		$asked = $this->without_prereq_resolving( [ [ '93.184.215.58' ] ] );

		$this->fetch( $this->curl(), $this->public_only( 'https://feed-58.example/feed/', [ 'method' => 'PATCH' ] ) );

		$this->assertSame( [], $asked->getArrayCopy() );
		$this->assert_error( 'invalid method PATCH https://feed-58.example/feed/' );
	}

	/** One connection the check refused keeps the transfer refused, whatever a later one reaches. */
	public function test_a_refusal_on_connect_is_never_lifted(): void {
		$this->fetch( $this->curl(), $this->public_only( 'https://rebind-59.example/feed/' ) );
		$prereq = $this->prereq_of( 0 );
		$prereq( $this->handles[0], '10.0.0.59', '10.0.0.2', 443, 50059 );

		$this->assertSame( \CURL_PREREQFUNC_ABORT, $prereq( $this->handles[0], '93.184.215.59', '10.0.0.2', 443, 50060 ) );
		$this->answer_with( 200, 'body-59', '', '93.184.215.59' );
		$this->deliver_in_loop( [ $this->done( $this->handles[0] ) ] );

		$this->assertSame( 'refused private address https://rebind-59.example/feed/', $this->only_emitted()[ Message::VALUE ] );
	}

	/** @return array<string,array{0:string}> */
	public static function non_global_address_provider(): array {
		return [
			'nat64 of loopback'        => [ '64:ff9b::7f00:1' ],
			'nat64 of link-local'      => [ '64:ff9b::a9fe:a9fe' ],
			'nat64 local-use'          => [ '64:ff9b:1::a9fe:a9fe' ],
			'site-local'               => [ 'fec0::1' ],
			'ipv4-mapped loopback'     => [ '::ffff:127.0.0.1' ],
			'ipv4-compatible loopback' => [ '::127.0.0.1' ],
			'6to4 of loopback'         => [ '2002:7f00:1::' ],
			'unspecified'              => [ '0.0.0.0' ],
			'shared'                   => [ '100.64.0.1' ],
			'ietf protocol'            => [ '192.0.0.1' ],
			'benchmarking'             => [ '198.18.0.1' ],
			'unique local'             => [ 'fc00::1' ],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider( 'non_global_address_provider' )]
	public function test_an_address_outside_the_global_ranges_is_refused( string $address ): void {
		$this->fetch( $this->curl(), $this->public_only( 'https://feed-60.example/feed/' ) );

		$this->assertSame( \CURL_PREREQFUNC_ABORT, ( $this->prereq_of( 0 ) )( $this->handles[0], $address, '10.0.0.2', 443, 50061 ) );
	}

	/** @return array<string,array{0:string}> */
	public static function global_address_provider(): array {
		return [
			'ipv4'           => [ '93.184.215.62' ],
			'ipv6'           => [ '2606:4700::1111' ],
			'nat64 of ipv4'  => [ '64:ff9b::808:808' ],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider( 'global_address_provider' )]
	public function test_an_address_in_the_global_ranges_is_reached( string $address ): void {
		$this->fetch( $this->curl(), $this->public_only( 'https://feed-62.example/feed/' ) );

		$this->assertSame( \CURL_PREREQFUNC_OK, ( $this->prereq_of( 0 ) )( $this->handles[0], $address, '10.0.0.2', 443, 50063 ) );
	}

	public function test_a_public_only_transfer_checks_the_connected_address_before_anything_is_sent(): void {
		$asked = new \ArrayObject();
		Curl_Node::$resolve = static function ( string $host ) use ( $asked ): array {
			$asked[] = $host;
			return [ '93.184.215.14' ];
		};
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://rebind-44.example/feed/', 'method' => 'GET', 'public_only' => true ] ) );

		$this->assertSame( [], $asked->getArrayCopy(), 'libcurl resolves; the worker looks nothing up' );
		$this->assertArrayNotHasKey( \CURLOPT_RESOLVE, $this->captured[0] );
		$this->assertSame( \CURL_PREREQFUNC_ABORT, ( $this->prereq_of( 0 ) )( $this->handles[0], '127.0.0.1', '10.0.0.2', 443, 50044 ) );

		$this->deliver_in_loop( [ $this->done( $this->handles[0], \CURLE_ABORTED_BY_CALLBACK ) ] );

		$this->assertSame( 'refused private address https://rebind-44.example/feed/', $this->only_emitted()[ Message::VALUE ] );
	}

	public function test_a_public_only_transfer_connected_to_a_public_address_is_sent(): void {
		$this->fetch( $this->curl(), $this->public_only( 'https://feed-45.example/feed/' ) );

		$this->assertSame( \CURL_PREREQFUNC_OK, ( $this->prereq_of( 0 ) )( $this->handles[0], '2606:4700::1111', '::1', 443, 50045 ) );
		$this->answer_with( 200, '<rss>feed-45</rss>', '', '2606:4700::1111' );
		$this->deliver_in_loop( [ $this->done( $this->handles[0] ) ] );

		$this->assertSame( '<rss>feed-45</rss>', $this->only_emitted()[ Message::VALUE ] );
	}

	/** The check is on the address libcurl connected to, so a name that rebinds after any lookup is still caught. */
	public function test_a_rebound_public_only_transfer_is_refused_on_the_address_it_reached(): void {
		$this->fetch( $this->curl(), $this->public_only( 'https://rebind-46.example/feed/' ) );
		$prereq = $this->prereq_of( 0 );

		$this->assertSame( \CURL_PREREQFUNC_OK, $prereq( $this->handles[0], '93.184.215.46', '10.0.0.2', 443, 50046 ) );
		$this->assertSame( \CURL_PREREQFUNC_ABORT, $prereq( $this->handles[0], '169.254.169.254', '10.0.0.2', 80, 50047 ), 'a reused or new connection is checked again' );
	}

	public function test_a_public_only_hop_checks_its_own_connected_address(): void {
		$this->fetch( $this->curl(), $this->public_only( 'https://feed-48.example/feed/' ) );
		$this->answer_with( 302, '', 'https://moved-48.example/rss', '93.184.215.48' );

		$this->deliver_in_loop( [ $this->done( $this->handles[0] ) ] );

		$this->assertSame( 'https://moved-48.example/rss', $this->captured[1][ \CURLOPT_URL ] );
		$this->assertSame( \CURL_PREREQFUNC_ABORT, ( $this->prereq_of( 1 ) )( $this->handles[1], '192.168.4.48', '10.0.0.2', 443, 50048 ) );
	}

	public function test_a_request_not_marked_public_only_carries_no_prereq_check(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://feed-49.example/feed/', 'method' => 'GET' ] ) );

		$this->assertArrayNotHasKey( \CURLOPT_PREREQFUNCTION, $this->captured[0] );
	}

	public function test_without_prereq_a_transfer_carries_no_prereq_check(): void {
		$this->without_prereq_resolving( [ [ '93.184.215.50' ] ] );

		$this->fetch( $this->curl(), $this->public_only( 'https://feed-50.example/feed/' ) );

		$this->assertArrayNotHasKey( \CURLOPT_PREREQFUNCTION, $this->captured[0] );
		$this->assertSame( [ '+feed-50.example:443:93.184.215.50' ], $this->captured[0][ \CURLOPT_RESOLVE ] );
	}

	public function test_without_prereq_an_ipv6_only_host_is_reached_pinned(): void {
		$this->without_prereq_resolving( [ [ '2606:4700::1111' ] ] );

		$this->fetch( $this->curl(), $this->public_only( 'https://v6-51.example/feed/' ) );

		$this->assertSame( [ '+v6-51.example:443:[2606:4700::1111]' ], $this->captured[0][ \CURLOPT_RESOLVE ] );
	}

	public function test_without_prereq_a_private_ipv6_address_is_refused(): void {
		$this->without_prereq_resolving( [ [ '2606:4700::1111', 'fd12:3456::52' ] ] );

		$this->fetch( $this->curl(), $this->public_only( 'https://v6-52.example/feed/' ) );

		$this->assert_error( 'refused private address https://v6-52.example/feed/' );
	}

	public function test_a_public_only_name_resolving_to_loopback_is_refused_with_no_request_sent(): void {
		$asked = $this->without_prereq_resolving( [ [ '127.0.0.1' ] ] );

		$this->fetch( $this->curl(), $this->public_only( 'https://rebind-31.example/feed/' ) );

		$this->assert_error( 'refused private address https://rebind-31.example/feed/' );
		$this->assertSame( [ 'rebind-31.example' ], $asked->getArrayCopy() );
	}

	public function test_a_public_only_name_with_any_private_address_is_refused(): void {
		$this->without_prereq_resolving( [ [ '93.184.215.14', '10.0.0.32' ] ] );

		$this->fetch( $this->curl(), $this->public_only( 'https://split-32.example/feed/' ) );

		$this->assert_error( 'refused private address https://split-32.example/feed/' );
	}

	public function test_a_public_only_name_that_resolves_to_nothing_is_refused(): void {
		$this->without_prereq_resolving( [ [] ] );

		$this->fetch( $this->curl(), $this->public_only( 'https://gone-33.example/feed/' ) );

		$this->assert_error( 'unresolved host https://gone-33.example/feed/' );
	}

	public function test_a_public_only_transfer_is_pinned_to_the_address_it_checked(): void {
		$this->without_prereq_resolving( [ [ '93.184.215.34', '93.184.215.35' ], [ '93.184.215.36' ] ] );
		$node = $this->curl();

		$this->fetch( $node, $this->public_only( 'https://Pin-34.example./feed/' ) );
		$this->fetch( $node, $this->public_only( 'http://pin-36.example:8080/feed/' ) );

		$this->assertSame( [ '+pin-34.example.:443:93.184.215.34', '+pin-34.example:443:93.184.215.34' ], $this->captured[0][ \CURLOPT_RESOLVE ], 'libcurl matches a rooted name only by its own spelling' );
		$this->assertSame( [ '+pin-36.example:8080:93.184.215.36' ], $this->captured[1][ \CURLOPT_RESOLVE ] );
	}

	/** The name is looked up once, so an answer that changes after the check never reaches libcurl. */
	public function test_a_rebind_after_the_check_still_connects_to_the_pinned_public_address(): void {
		$asked = $this->without_prereq_resolving( [ [ '93.184.215.37' ], [ '127.0.0.1' ] ] );

		$this->fetch( $this->curl(), $this->public_only( 'https://rebind-37.example/feed/' ) );
		$this->answer_with( 200, '<rss>pinned-37</rss>', '', '93.184.215.37' );
		$this->deliver_in_loop( [ $this->done( $this->handles[0] ) ] );

		$this->assertSame( [ 'rebind-37.example' ], $asked->getArrayCopy(), 'one lookup, never a second' );
		$this->assertSame( [ '+rebind-37.example:443:93.184.215.37' ], $this->captured[0][ \CURLOPT_RESOLVE ] );
		$this->assertSame( '<rss>pinned-37</rss>', $this->only_emitted()[ Message::VALUE ] );
	}

	public function test_a_public_only_hop_is_resolved_and_refused_before_it_is_sent(): void {
		$asked = $this->without_prereq_resolving( [ [ '93.184.215.38' ], [ '169.254.169.254' ] ] );
		$this->fetch( $this->curl(), $this->public_only( 'https://feed-38.example/feed/' ) );
		$this->answer_with( 302, '', 'https://rebind-39.example/feed', '93.184.215.38' );

		$this->deliver_in_loop( [ $this->done( $this->handles[0] ) ] );

		$this->assertCount( 1, $this->captured, 'the hop is never sent' );
		$this->assertSame( [ 'feed-38.example', 'rebind-39.example' ], $asked->getArrayCopy() );
		$this->assertSame( 'refused private address https://rebind-39.example/feed', $this->only_emitted()[ Message::VALUE ] );
	}

	public function test_a_public_only_hop_is_pinned_to_its_own_checked_address(): void {
		$this->without_prereq_resolving( [ [ '93.184.215.40' ], [ '93.184.215.41' ] ] );
		$this->fetch( $this->curl(), $this->public_only( 'https://feed-40.example/feed/' ) );
		$this->answer_with( 301, '', 'https://moved-41.example/rss', '93.184.215.40' );

		$this->deliver_in_loop( [ $this->done( $this->handles[0] ) ] );

		$this->assertSame( [ '+moved-41.example:443:93.184.215.41' ], $this->captured[1][ \CURLOPT_RESOLVE ] );
	}

	public function test_a_public_only_address_literal_is_neither_looked_up_nor_pinned(): void {
		$asked = $this->without_prereq_resolving( [] );

		$this->fetch( $this->curl(), $this->public_only( 'http://93.184.215.42/feed-42' ) );

		$this->assertSame( [], $asked->getArrayCopy() );
		$this->assertArrayNotHasKey( \CURLOPT_RESOLVE, $this->captured[0] );
	}

	public function test_a_request_not_marked_public_only_is_never_looked_up(): void {
		$asked = $this->without_prereq_resolving( [] );

		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://feed-43.example/feed/', 'method' => 'GET' ] ) );

		$this->assertSame( [], $asked->getArrayCopy() );
		$this->assertArrayNotHasKey( \CURLOPT_RESOLVE, $this->captured[0] );
	}

	/** The result seam answering one status, body, Location and connected address. */
	private function answer_with( int $code, string $body, string $redirect, string $ip ): void {
		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => $code, 'body' => $body, 'redirect' => $redirect, 'ip' => $ip ];
	}

	/** @return array<string,array{0:string,1:string}> */
	public static function refused_public_only_host_provider(): array {
		return [
			'link-local metadata' => [ 'http://169.254.169.254/latest/meta-data/', 'refused private address http://169.254.169.254/latest/meta-data/' ],
			'loopback'            => [ 'http://127.0.0.1:8080/feed-4', 'refused private address http://127.0.0.1:8080/feed-4' ],
			'private ten'         => [ 'https://10.20.30.40/feed-5', 'refused private address https://10.20.30.40/feed-5' ],
			'ipv6 loopback'       => [ 'http://[::1]/feed-6', 'refused private address http://[::1]/feed-6' ],
			'ipv4-mapped'         => [ 'http://[::ffff:10.0.0.7]/feed-7', 'refused private address http://[::ffff:10.0.0.7]/feed-7' ],
			'single label'        => [ 'http://intranet-8/feed-8', 'refused single-label host http://intranet-8/feed-8' ],
			'single label rooted' => [ 'http://intranet-9./feed-9', 'refused single-label host http://intranet-9./feed-9' ],
			'decimal address'     => [ 'http://2130706433/feed-10', 'refused single-label host http://2130706433/feed-10' ],
			'short dotted'        => [ 'http://127.1/feed-11', 'refused numeric host http://127.1/feed-11' ],
			'hex dotted'          => [ 'http://0x7f.0.0.1/feed-12', 'refused numeric host http://0x7f.0.0.1/feed-12' ],
		];
	}

	/** A public-only request naming a private, loopback, link-local or reserved address, or a name that is not held by any DNS root, never starts a transfer. */
	#[\PHPUnit\Framework\Attributes\DataProvider( 'refused_public_only_host_provider' )]
	public function test_a_public_only_request_refuses_a_host_that_is_not_public( string $url, string $refusal ): void {
		$this->fetch( $this->curl(), $this->public_only( $url ) );

		$this->assert_error( $refusal );
	}

	public function test_a_public_only_request_to_a_public_host_answers_its_body(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->public_only( 'https://feed-3.example/feed/' ) );
		$this->fetch( $node, $this->public_only( 'http://93.184.215.14/feed-13' ) );
		$this->answer_with( 200, '<rss>feed-3</rss>', '', '93.184.215.14' );

		$this->deliver_in_loop( [ $this->done( $this->handles[0] ), $this->done( $this->handles[1] ) ] );

		$this->assertSame( [ 'https://feed-3.example/feed/', 'http://93.184.215.14/feed-13' ], \array_column( $this->captured, \CURLOPT_URL ) );
		$this->assertSame( [ Message::TM_BYTESTREAM, Message::TM_BYTESTREAM ], \array_column( $this->sink->captured, Message::TYPE ) );
		$this->assertSame( [ '<rss>feed-3</rss>', '<rss>feed-3</rss>' ], \array_column( $this->sink->captured, Message::VALUE ) );
		$this->assertSame( 'key-2297', $this->sink->captured[0][ Message::KEY ] );
	}

	public function test_a_public_only_request_whose_name_resolved_to_loopback_answers_no_body(): void {
		$this->fetch( $this->curl(), $this->public_only( 'https://rebind-14.example/feed/' ) );
		$this->answer_with( 200, 'secret-from-loopback-14', '', '127.0.0.1' );

		$this->deliver_in_loop( [ $this->done( $this->handles[0] ) ] );

		$out = $this->only_emitted();
		$this->assertSame( Message::TM_ERROR, $out[ Message::TYPE ] );
		$this->assertSame( 'refused private address https://rebind-14.example/feed/', $out[ Message::VALUE ] );
	}

	public function test_a_public_only_request_that_reported_no_address_answers_no_body(): void {
		$this->fetch( $this->curl(), $this->public_only( 'https://quiet-15.example/feed/' ) );
		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 200, 'body' => 'body-15', 'redirect' => '' ];

		$this->deliver_in_loop( [ $this->done( $this->handles[0] ) ] );

		$this->assertSame( 'refused private address https://quiet-15.example/feed/', $this->only_emitted()[ Message::VALUE ] );
	}

	public function test_a_request_not_marked_public_only_is_not_guarded(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->request_message( [ 'url' => 'http://127.0.0.1:8080/status-16', 'method' => 'GET' ] ) );
		$this->answer_with( 200, 'status-16', '', '127.0.0.1' );

		$this->deliver_in_loop( [ $this->done( $this->handles[0] ) ] );

		$this->assertTrue( $this->captured[0][ \CURLOPT_FOLLOWLOCATION ] );
		$this->assertSame( 'status-16', $this->only_emitted()[ Message::VALUE ] );
	}

	/** @return array<string,array{0:mixed}> */
	public static function refused_public_only_flag_provider(): array {
		return [
			'a string' => [ 'yes' ],
			'a number' => [ 1 ],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider( 'refused_public_only_flag_provider' )]
	public function test_a_public_only_flag_that_is_not_a_boolean_is_refused( mixed $flag ): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://feed-3.example/feed/', 'method' => 'GET', 'public_only' => $flag ] ) );

		$this->assert_error( 'invalid public_only https://feed-3.example/feed/' );
	}

	/** Through a proxy the connected address is the proxy's address, so the host's address could not be checked. */
	public function test_a_public_only_request_through_a_proxy_is_refused(): void {
		$this->fetch( $this->curl(), $this->public_only( 'https://feed-3.example/feed/', [ 'proxy' => 'socks5h://proxy-5.example:1080' ] ) );

		$this->assert_error( 'refused proxy on a public-only request https://feed-3.example/feed/' );
	}

	public function test_a_public_only_request_follows_each_redirect_itself_checking_every_hop(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->public_only( 'https://feed-3.example/feed/', [ 'connect_timeout' => 9 ] ) );
		$this->assertFalse( $this->captured[0][ \CURLOPT_FOLLOWLOCATION ], 'libcurl follows nothing a check could miss' );
		$this->answer_with( 301, '', 'https://moved-17.example/rss', '93.184.215.14' );

		$this->deliver_in_loop( [ $this->done( $this->handles[0] ) ] );

		$this->assertSame( [], $this->sink->captured, 'a hop answers nothing' );
		$this->assertCount( 2, $this->captured );
		$this->assertSame( 'https://moved-17.example/rss', $this->captured[1][ \CURLOPT_URL ] );
		$this->assertSame( 9, $this->captured[1][ \CURLOPT_CONNECTTIMEOUT ], 'the hop runs the same request' );
		$this->assertFalse( $this->captured[1][ \CURLOPT_FOLLOWLOCATION ] );

		$this->answer_with( 200, '<rss>moved-17</rss>', '', '93.184.215.15' );
		$this->deliver_in_loop( [ $this->done( $this->handles[1] ) ] );

		$out = $this->only_emitted();
		$this->assertSame( Message::TM_BYTESTREAM, $out[ Message::TYPE ] );
		$this->assertSame( '<rss>moved-17</rss>', $out[ Message::VALUE ] );
		$this->assertSame( 'key-2297', $out[ Message::KEY ], 'the answer is a copy of the first request' );
	}

	/** libcurl drops `Authorization` when a redirect leaves the origin, and so does the node's own hop. */
	public function test_a_public_only_hop_carries_a_credential_only_on_the_origin_it_started_on(): void {
		$this->seed_group();
		$node = $this->curl( 'crawl-g7' );
		$this->fetch( $node, $this->public_only( 'https://north-31.example:8443/deep/x-24' ) );
		$this->answer_with( 302, '', 'https://north-31.example:8443/deep/x-25', '93.184.215.14' );
		$this->deliver_in_loop( [ $this->done( $this->handles[0] ) ] );
		$this->answer_with( 307, '', 'https://south-52.example/y-26', '93.184.215.14' );
		$this->deliver_in_loop( [ $this->done( $this->handles[1] ) ] );
		$this->answer_with( 302, '', 'https://north-31.example:8443/deep/x-27', '93.184.215.14' );
		$this->deliver_in_loop( [ $this->done( $this->handles[2] ) ] );

		$this->assertSame( 'https://south-52.example/y-26', $this->captured[2][ \CURLOPT_URL ] );
		$this->assertSame( [ 1, 1, 0, 1 ], [ \count( $this->authorization_of( 0 ) ), \count( $this->authorization_of( 1 ) ), \count( $this->authorization_of( 2 ) ), \count( $this->authorization_of( 3 ) ) ], 'south-52 has its own entry, yet a hop off the first origin carries none' );
		$this->assertSame( [ 'Authorization: Basic ' . \base64_encode( 'svc-n31:pw-n58' ) ], $this->authorization_of( 3 ), 'back on it, its own' );
	}

	public function test_a_public_only_redirect_to_a_private_address_is_refused_before_it_is_fetched(): void {
		$this->fetch( $this->curl(), $this->public_only( 'https://feed-3.example/feed/' ) );
		$this->answer_with( 302, '', 'http://169.254.169.254/latest/meta-data/', '93.184.215.14' );

		$this->deliver_in_loop( [ $this->done( $this->handles[0] ) ] );

		$this->assertCount( 1, $this->captured, 'the hop never starts' );
		$this->assertSame( 'refused private address http://169.254.169.254/latest/meta-data/', $this->only_emitted()[ Message::VALUE ] );
	}

	public function test_a_public_only_hop_whose_name_resolved_to_a_private_address_answers_no_body(): void {
		$this->fetch( $this->curl(), $this->public_only( 'https://feed-3.example/feed/' ) );
		$this->answer_with( 302, '', 'https://rebind-18.example/feed', '93.184.215.14' );
		$this->deliver_in_loop( [ $this->done( $this->handles[0] ) ] );
		$this->answer_with( 200, 'secret-from-ten-18', '', '10.0.0.18' );

		$this->deliver_in_loop( [ $this->done( $this->handles[1] ) ] );

		$this->assertSame( 'refused private address https://rebind-18.example/feed', $this->only_emitted()[ Message::VALUE ] );
	}

	public function test_a_public_only_post_redirected_by_a_303_follows_as_a_get(): void {
		$this->fetch( $this->curl(), $this->public_only( 'https://api-19.example/q', [ 'method' => 'POST', 'body' => '{"q":19}' ] ) );
		$this->answer_with( 303, '', 'https://api-19.example/answer', '93.184.215.14' );

		$this->deliver_in_loop( [ $this->done( $this->handles[0] ) ] );

		$this->assertTrue( $this->captured[1][ \CURLOPT_HTTPGET ] );
		$this->assertArrayNotHasKey( \CURLOPT_POSTFIELDS, $this->captured[1] );
		$this->assertArrayNotHasKey( \CURLOPT_HTTPHEADER, $this->captured[1], 'no JSON Content-Type rides a GET' );
	}

	public function test_a_public_only_post_redirected_by_a_307_keeps_its_method_and_body(): void {
		$this->fetch( $this->curl(), $this->public_only( 'https://api-19.example/q', [ 'method' => 'POST', 'body' => '{"q":20}' ] ) );
		$this->answer_with( 307, '', 'https://api-20.example/q', '93.184.215.14' );

		$this->deliver_in_loop( [ $this->done( $this->handles[0] ) ] );

		$this->assertTrue( $this->captured[1][ \CURLOPT_POST ] );
		$this->assertSame( '{"q":20}', $this->captured[1][ \CURLOPT_POSTFIELDS ] );
	}

	public function test_a_public_only_request_follows_at_most_max_redirects(): void {
		$this->fetch( $this->curl(), $this->public_only( 'https://loop-21.example/0' ) );
		for ( $hop = 0; $hop <= Curl_Node::MAX_REDIRECTS; $hop++ ) {
			$this->answer_with( 302, '', 'https://loop-21.example/' . ( $hop + 1 ), '93.184.215.14' );
			$this->deliver_in_loop( [ $this->done( $this->handles[ $hop ] ) ] );
		}

		$this->assertCount( Curl_Node::MAX_REDIRECTS + 1, $this->captured );
		$this->assertSame( 'redirects past ' . Curl_Node::MAX_REDIRECTS . ' https://loop-21.example/' . Curl_Node::MAX_REDIRECTS, $this->only_emitted()[ Message::VALUE ] );
	}

	public function test_a_public_only_request_following_none_answers_its_location(): void {
		$node = $this->curl();
		$node->follow_redirects( false );
		$this->fetch( $node, $this->public_only( 'https://feed-3.example/feed/' ) );
		$this->answer_with( 301, '', 'http://10.0.0.22/feed', '93.184.215.14' );

		$this->deliver_in_loop( [ $this->done( $this->handles[0] ) ] );

		$out = $this->only_emitted();
		$this->assertSame( Message::TM_RESPONSE, $out[ Message::TYPE ], 'the sender marks the Location public-only when it fetches it' );
		$this->assertSame( 'http://10.0.0.22/feed', $out[ Message::VALUE ] );
	}

	public function test_a_public_only_redirect_from_a_private_address_answers_no_location(): void {
		$node = $this->curl();
		$node->follow_redirects( false );
		$this->fetch( $node, $this->public_only( 'https://rebind-23.example/feed/' ) );
		$this->answer_with( 301, '', 'https://elsewhere-23.example/', '192.168.0.23' );

		$this->deliver_in_loop( [ $this->done( $this->handles[0] ) ] );

		$this->assertSame( 'refused private address https://rebind-23.example/feed/', $this->only_emitted()[ Message::VALUE ] );
	}

	public function test_a_request_naming_no_proxy_sets_none(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->request_message( [ 'url' => 'https://mcp-8.example/v1', 'method' => 'POST', 'body' => '{}' ] ) );
		$this->fetch( $node, $this->url_message( 'https://mcp-8.example/feed' ) );

		$this->assertArrayNotHasKey( \CURLOPT_PROXY, $this->captured[0] );
		$this->assertArrayNotHasKey( \CURLOPT_PROXY, $this->captured[1] );
	}

	/** @return array<string,array{0:mixed,1:string}> */
	public static function refused_proxy_provider(): array {
		$url = 'https://mcp-8.example/v1';
		return [
			'ftp scheme'      => [ 'ftp://proxy-5.example:21', "invalid proxy {$url}" ],
			'socks4 scheme'   => [ 'socks4://proxy-5.example:1080', "invalid proxy {$url}" ],
			'no scheme'       => [ 'proxy-5.example:8080', "invalid proxy {$url}" ],
			'no port'         => [ 'socks5h://proxy-5.example', "invalid proxy {$url}" ],
			'no host'         => [ 'socks5h://:8080', "invalid proxy {$url}" ],
			'a path'          => [ 'socks5h://proxy-5.example:8080/tunnel', "invalid proxy {$url}" ],
			'a query'         => [ 'http://proxy-5.example:3128?x=1', "invalid proxy {$url}" ],
			'empty'           => [ '', "invalid proxy {$url}" ],
			'not a string'    => [ [ 'socks5h://proxy-5.example:8080' ], "invalid proxy {$url}" ],
			'userinfo'        => [ 'socks5h://svc-77:pw-proxy-91@proxy-5.example:8080', "invalid proxy carrying userinfo {$url}" ],
			'user alone'      => [ 'http://svc-77@proxy-5.example:3128', "invalid proxy carrying userinfo {$url}" ],
			'carriage return' => [ "socks5h://proxy-5.example:8080\r", "proxy carries CR or LF {$url}" ],
			'line feed'       => [ "socks5h://proxy-5.example:8080\nHost: x", "proxy carries CR or LF {$url}" ],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider( 'refused_proxy_provider' )]
	public function test_a_proxy_that_is_not_a_bare_socks_or_http_origin_is_refused( mixed $proxy, string $expected ): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://mcp-8.example/v1', 'method' => 'POST', 'body' => '{}', 'proxy' => $proxy ] ) );

		$this->assert_error( $expected );
		$this->assertStringNotContainsString( 'pw-proxy-91', $expected );
	}

	/**
	 * Feed header lines to dispatch $i's header callback, as libcurl does,
	 * then complete it with $code and $body.
	 *
	 * @param list<string> $lines Header lines, each with its CRLF.
	 */
	private function answer_with_headers( int $i, array $lines, string $body, int $code = 200 ): void {
		foreach ( $lines as $line ) {
			$this->assertSame( \strlen( $line ), $this->captured[ $i ][ \CURLOPT_HEADERFUNCTION ]( $this->handles[ $i ], $line ) );
		}
		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => $code, 'body' => $body, 'redirect' => '' ];
		$this->deliver_curl_rows( [ $this->done( $this->handles[ $i ] ) ] );
	}

	/**
	 * A request naming response headers answers a TM_STRUCT copy of itself,
	 * `{ body, headers }`: each named header by its lowercased name, matched
	 * in any case, its first value trimmed and cut to 256 bytes; one the
	 * answer never sent is left out, and an unnamed one is never read.
	 */
	public function test_named_response_headers_answer_with_the_body(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://mcp-8.example/v1', 'method' => 'POST', 'body' => '{}', 'response_headers' => [ 'Mcp-Session-Id', 'X-Trace-71', 'X-Absent-4' ] ] ) );

		$this->answer_with_headers(
			0,
			[ "HTTP/1.1 200 OK\r\n", "mcp-session-ID:   sess-7731-heron  \r\n", "Mcp-Session-Id: second-ignored\r\n", "X-Unnamed-9: never\r\n", 'X-TRACE-71: ' . \str_repeat( 'r', 300 ) . "\r\n", "\r\n" ],
			'{"jsonrpc":"2.0","id":1}'
		);

		$out = $this->only_emitted();
		$this->assertSame( Message::TM_STRUCT, $out[ Message::TYPE ] );
		$this->assertSame(
			[
				'body'    => '{"jsonrpc":"2.0","id":1}',
				'headers' => [
					'mcp-session-id' => 'sess-7731-heron',
					'x-trace-71'     => \str_repeat( 'r', 256 ),
				],
			],
			$out[ Message::VALUE ]
		);
		$this->assertSame( [ 'asker-5519/reply', 'corr-6081', 'key-2297', 'fetched-4402' ], [ $out[ Message::FROM ], $out[ Message::ID ], $out[ Message::KEY ], $out[ Message::TO ] ] );
	}

	/** A redirect hop's headers give way to the final answer's. */
	public function test_the_final_answers_headers_replace_a_redirect_hops(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://mcp-8.example/v1', 'method' => 'GET', 'response_headers' => [ 'Mcp-Session-Id' ] ] ) );

		$this->answer_with_headers( 0, [ "HTTP/1.1 302 Found\r\n", "Mcp-Session-Id: hop-6610\r\n", "\r\n", "HTTP/2 200\r\n", "Mcp-Session-Id: final-8802\r\n", "\r\n" ], 'ok-5' );

		$this->assertSame( [ 'body' => 'ok-5', 'headers' => [ 'mcp-session-id' => 'final-8802' ] ], $this->only_emitted()[ Message::VALUE ] );
	}

	/** A header after the final head's blank line, a chunked trailer, is never read. */
	public function test_a_trailer_is_never_read_as_a_response_header(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://mcp-8.example/v1', 'method' => 'GET', 'response_headers' => [ 'Mcp-Session-Id', 'X-Late-5' ] ] ) );

		$this->answer_with_headers( 0, [ "HTTP/1.1 200 OK\r\n", "Mcp-Session-Id: head-3301\r\n", "\r\n", "X-Late-5: trailer-9\r\n", "\r\n" ], 'chunked' );

		$this->assertSame( [ 'mcp-session-id' => 'head-3301' ], $this->only_emitted()[ Message::VALUE ]['headers'] );
	}

	/** A status of 400 or more answers its TM_ERROR as before, whatever headers were named. */
	public function test_an_error_status_answers_its_tm_error_unchanged(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://mcp-8.example/v1', 'method' => 'POST', 'body' => '{}', 'response_headers' => [ 'Mcp-Session-Id' ] ] ) );

		$this->answer_with_headers( 0, [ "HTTP/1.1 404 Not Found\r\n", "Mcp-Session-Id: gone-3\r\n" ], 'missing' , 404 );

		$out = $this->only_emitted();
		$this->assertSame( Message::TM_ERROR, $out[ Message::TYPE ] );
		$this->assertSame( 'HTTP 404 https://mcp-8.example/v1', $out[ Message::VALUE ] );
	}

	/** A request that does not name any response headers reads none, and answers its body as a TM_BYTESTREAM. */
	public function test_a_request_naming_no_response_headers_answers_as_before(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->request_message( [ 'url' => 'https://mcp-8.example/v1', 'method' => 'POST', 'body' => '{}' ] ) );
		$this->fetch( $node, $this->url_message( 'https://mcp-8.example/feed-3' ) );

		$this->assertArrayNotHasKey( \CURLOPT_HEADERFUNCTION, $this->captured[0] );
		$this->assertArrayNotHasKey( \CURLOPT_HEADERFUNCTION, $this->captured[1] );
		Curl_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 200, 'body' => 'plain-4410', 'redirect' => '' ];
		$this->deliver_curl_rows( [ $this->done( $this->handles[0] ) ] );
		$this->assertSame( [ Message::TM_BYTESTREAM, 'plain-4410' ], [ $this->sink->captured[0][ Message::TYPE ], $this->sink->captured[0][ Message::VALUE ] ] );
	}

	/** @return array<string,array{0:mixed,1:string}> */
	public static function refused_response_headers_provider(): array {
		$url = 'https://mcp-8.example/v1';
		return [
			'not a list'        => [ [ 'name' => 'Mcp-Session-Id' ], "invalid response headers {$url}" ],
			'a string'          => [ 'Mcp-Session-Id', "invalid response headers {$url}" ],
			'nine names'        => [ [ 'A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7', 'A-8', 'A-9' ], "invalid response headers {$url}" ],
			'not a string'      => [ [ [ 'Mcp-Session-Id' ] ], "invalid response headers {$url}" ],
			'a space'           => [ [ 'Mcp Session' ], "invalid response headers {$url}" ],
			'a colon'           => [ [ 'Mcp-Session-Id:' ], "invalid response headers {$url}" ],
			'empty'             => [ [ '' ], "invalid response headers {$url}" ],
			'a line feed'       => [ [ "Mcp-Session-Id\n" ], "invalid response headers {$url}" ],
			'host'              => [ [ 'hOsT' ], "refused response header hOsT {$url}" ],
			'connection'        => [ [ 'Connection' ], "refused response header Connection {$url}" ],
			'cookie'            => [ [ 'Cookie' ], "refused response header Cookie {$url}" ],
			'set-cookie'        => [ [ 'SET-COOKIE' ], "refused response header SET-COOKIE {$url}" ],
			'authorization'     => [ [ 'authorization' ], "refused response header authorization {$url}" ],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider( 'refused_response_headers_provider' )]
	public function test_a_response_header_that_could_carry_a_secret_is_refused( mixed $names, string $expected ): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://mcp-8.example/v1', 'method' => 'POST', 'body' => '{}', 'response_headers' => $names ] ) );

		$this->assert_error( $expected );
	}

	/** Eight names are allowed. */
	public function test_eight_response_headers_are_read(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://mcp-8.example/v1', 'method' => 'GET', 'response_headers' => [ 'A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7', 'A-8' ] ] ) );

		$this->answer_with_headers( 0, [ "A-8: eighth-58\r\n" ], 'b' );

		$this->assertSame( [ 'a-8' => 'eighth-58' ], $this->only_emitted()[ Message::VALUE ]['headers'] );
	}

	/** The header the vault's credential for the origin rides in is refused, in any case. */
	public function test_the_vault_credentials_own_header_is_refused(): void {
		$this->seed_vault( 'mcp-6', [ 'url' => 'https://mcp-6.example', 'auth_password' => 'vault-key-6604', 'auth_header' => 'X-Api-Key', 'group' => 'crawl-g7' ] );

		$this->fetch( $this->curl( 'crawl-g7' ), $this->request_message( [ 'url' => 'https://mcp-6.example/v1', 'method' => 'POST', 'body' => '{}', 'response_headers' => [ 'Mcp-Session-Id', 'x-api-KEY' ] ] ) );

		$this->assert_error( 'refused response header x-api-KEY beside a vault credential https://mcp-6.example/v1' );
	}

	public function test_requests_and_urls_share_the_in_flight_cap(): void {
		$node = $this->curl();
		for ( $i = 1; $i <= 8; $i++ ) {
			$this->fetch( $node, $this->url_message( "http://mixed.example:8090/u-{$i}" ) );
			$this->fetch( $node, $this->request_message( [ 'url' => "http://mixed.example:8090/r-{$i}", 'method' => 'POST', 'body' => '{}' ] ) );
		}
		$this->assertCount( 16, $this->captured );

		$this->fetch( $node, $this->request_message( [ 'url' => 'http://mixed.example:8090/r-17', 'method' => 'GET' ] ) );

		$this->assertCount( 16, $this->captured );
		$this->assertSame( 'busy: 16 requests in flight http://mixed.example:8090/r-17', $this->only_emitted()[ Message::VALUE ] );
	}

	public function test_a_fill_turned_away_as_busy_is_not_read_first(): void {
		$node = $this->curl();
		for ( $i = 1; $i <= 16; $i++ ) {
			$this->fetch( $node, $this->url_message( "http://full.example:8090/n-{$i}" ) );
		}

		$this->fetch( $node, $this->request_message( [ 'url' => 'https://full.example/q-17', 'method' => 'PATCH' ] ) );

		$this->assertSame( 'busy: 16 requests in flight https://full.example/q-17', $this->only_emitted()[ Message::VALUE ] );
	}

	public function test_a_fill_outside_an_event_loop_is_not_read_first(): void {
		$this->seed_vault_servers(
			[
				'twin-b' => [ 'url' => 'https://twin-12.example/b', 'auth_username' => 'svc-b', 'auth_password' => 'pw-b', 'group' => 'crawl-g7' ],
				'twin-a' => [ 'url' => 'https://twin-12.example/a', 'auth_username' => 'svc-a', 'auth_password' => 'pw-a', 'group' => 'crawl-g7' ],
			]
		);

		$this->curl( 'crawl-g7' )->fill( $this->request_message( [ 'url' => 'https://twin-12.example/q-5', 'method' => 'PATCH' ] ) );

		$this->assert_error( 'no event loop https://twin-12.example/q-5' );
	}

	public function test_a_request_outside_an_event_loop_starts_nothing(): void {
		$this->curl()->fill( $this->request_message( [ 'url' => 'https://idle-loop.example/q-58', 'method' => 'POST', 'body' => '{}' ] ) );

		$this->assert_error( 'no event loop https://idle-loop.example/q-58' );
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

	public function test_a_url_carrying_userinfo_outside_an_event_loop_is_refused_unechoed(): void {
		$this->curl()->fill( $this->url_message( 'https://svc-14:pw-81@idle-14.example/page-9' ) );

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

	public function test_lends_credential_answers_true_for_a_group_entry_on_the_origin(): void {
		$this->seed_group();

		$this->assertTrue( Curl_Node::lends_credential( 'crawl-g7', 'https://north-31.example:8443/deep/q-8' ) );
		$this->assertTrue( Curl_Node::lends_credential( 'crawl-g7', 'HTTPS://SOUTH-52.example/r-4' ) );
	}

	public function test_lends_credential_answers_true_for_two_entries_on_one_origin(): void {
		$this->seed_vault_servers(
			[
				'twin-b' => [ 'url' => 'https://twin-12.example/b', 'auth_username' => 'svc-b', 'auth_password' => 'pw-b', 'group' => 'crawl-g7' ],
				'twin-a' => [ 'url' => 'https://twin-12.example/a', 'auth_username' => 'svc-a', 'auth_password' => 'pw-a', 'group' => 'crawl-g7' ],
			]
		);

		$this->assertTrue( Curl_Node::lends_credential( 'crawl-g7', 'https://twin-12.example/page-5' ) );
	}

	public function test_lends_credential_answers_false_for_an_origin_with_no_group_entry(): void {
		$this->seed_group();

		$this->assertFalse( Curl_Node::lends_credential( 'crawl-g7', 'https://stranger-77.example/z-3' ), 'no entry on the origin' );
		$this->assertFalse( Curl_Node::lends_credential( 'crawl-g7', 'https://north-31.example/other-port-4' ), 'another port is another origin' );
		$this->assertFalse( Curl_Node::lends_credential( 'crawl-g7', 'http://south-52.example/plain-6' ), 'another scheme is another origin' );
	}

	public function test_lends_credential_answers_false_for_an_entry_in_another_group(): void {
		$this->seed_group();

		$this->assertFalse( Curl_Node::lends_credential( 'elsewhere-9', 'https://south-52.example/y-2' ) );
	}

	public function test_lends_credential_answers_false_with_no_group(): void {
		$this->seed_group();

		$this->assertFalse( Curl_Node::lends_credential( '', 'https://south-52.example/y-2' ) );
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
