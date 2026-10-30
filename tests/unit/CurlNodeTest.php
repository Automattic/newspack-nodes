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
	 * the origin, so a credential in any other header follows no redirect.
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
		$this->assertSame( 65536, Curl_Node::MAX_BODY_BYTES );
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://api.cap-6.example/x', 'method' => 'POST', 'body' => \str_repeat( 'y', 65536 ) ] ) );

		$this->assertSame( 65536, \strlen( $this->captured[0][ \CURLOPT_POSTFIELDS ] ) );
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
	 * A request carrying header lines of its own follows no redirect, since
	 * any of them may be a credential libcurl would carry along, and a 3xx
	 * answers as the credential guard's does, naming no value.
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

	/** A DELETE follows no redirect, so its method is never sent to another url. */
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

	/** A request naming no response headers reads none and answers its body as a TM_BYTESTREAM. */
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
