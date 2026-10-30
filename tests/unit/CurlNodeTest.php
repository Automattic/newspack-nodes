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
			'unknown method'   => [ [ 'url' => $url, 'method' => 'DELETE' ], "invalid method DELETE {$url}" ],
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

	/** Run dispatch $i's pre-request callback as libcurl would on connecting to $ip. */
	private function connect_to( int $i, string $ip ): int {
		return $this->captured[ $i ][ \CURLOPT_PREREQFUNCTION ]( $this->handles[ $i ], $ip, '172.18.0.44', 8443, 51734 );
	}

	/** @return array<string,array{0:string}> One address per refused range family. */
	public static function refused_address_provider(): array {
		return [
			'this network 0/8'          => [ '0.41.7.3' ],
			'private 10/8'              => [ '10.9.8.7' ],
			'shared 100.64/10 low'      => [ '100.64.0.9' ],
			'shared 100.64/10 high'     => [ '100.127.255.254' ],
			'loopback 127/8'            => [ '127.3.4.5' ],
			'link-local 169.254/16'     => [ '169.254.169.254' ],
			'private 172.16/12'         => [ '172.31.200.4' ],
			'ietf 192.0.0/24'           => [ '192.0.0.170' ],
			'test-net-1 192.0.2/24'     => [ '192.0.2.77' ],
			'6to4 relay 192.88.99/24'   => [ '192.88.99.12' ],
			'private 192.168/16'        => [ '192.168.44.3' ],
			'benchmark 198.18/15'       => [ '198.19.250.1' ],
			'test-net-2 198.51.100/24'  => [ '198.51.100.81' ],
			'test-net-3 203.0.113/24'   => [ '203.0.113.200' ],
			'multicast 224/4'           => [ '239.255.255.250' ],
			'reserved 240/4'            => [ '250.1.2.3' ],
			'broadcast'                 => [ '255.255.255.255' ],
			'ipv6 loopback'             => [ '::1' ],
			'ipv6 unspecified'          => [ '::' ],
			'ipv6 unique local fc00::/7' => [ 'fd12:3456:789a::41' ],
			'ipv6 link-local fe80::/10' => [ 'febf::7' ],
			'ipv6 multicast ff00::/8'   => [ 'ff02::fb' ],
			'mapped loopback'           => [ '::ffff:127.0.0.9' ],
			'mapped private'            => [ '::ffff:10.20.30.40' ],
			'mapped shared'             => [ '::ffff:100.100.0.1' ],
			'not an address'            => [ 'nowhere-61' ],
			'ipv4-compatible, private'  => [ '::a00:41' ],
			'ipv4-compatible, public'   => [ '::5db8:d70e' ],
			'ipv4-translated, private'  => [ '::ffff:0:a00:42' ],
			'ipv4-translated, public'   => [ '::ffff:0:5db8:d70e' ],
			'nat64 64:ff9b::/96'        => [ '64:ff9b::a9fe:a9fe' ],
			'6to4 2002::/16'            => [ '2002:c0a8:2c03::9' ],
			'documentation 2001:db8::/32' => [ '2001:db8:85a3::7' ],
			'discard 100::/64'          => [ '100::4:2' ],
			'site-local fec0::/10'      => [ 'feff::9' ],
			'ietf 2001::/23 high'       => [ '2001:1ff::5' ],
			'teredo inside 2001::/23'   => [ '2001:0:4136:e378::3' ],
			'local nat64 64:ff9b:1::/48' => [ '64:ff9b:1:a9fe:a9:fe00::7' ],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider( 'refused_address_provider' )]
	public function test_a_private_or_reserved_address_aborts_the_request( string $ip ): void {
		$this->fetch( $this->curl(), $this->url_message( 'https://inside-71.example/admin-4' ) );

		$this->assertSame( \CURL_PREREQFUNC_ABORT, $this->connect_to( 0, $ip ) );
	}

	/** @return array<string,array{0:string}> Public addresses, several just past a refused range. */
	public static function public_address_provider(): array {
		return [
			'public ipv4'          => [ '93.184.215.14' ],
			'below 100.64/10'      => [ '100.63.255.255' ],
			'above 100.64/10'      => [ '100.128.0.1' ],
			'beside 192.0.2/24'    => [ '192.0.3.1' ],
			'above 198.18/15'      => [ '198.20.0.1' ],
			'below 224/4'          => [ '223.255.255.254' ],
			'public ipv6'          => [ '2606:4700:4700::1111' ],
			'mapped public ipv4'   => [ '::ffff:93.184.215.14' ],
			'nat64 public ipv4'    => [ '64:ff9b::5db8:d70e' ],
			'6to4 public ipv4'     => [ '2002:5db8:d70e::1' ],
			'above 2001::/23'      => [ '2001:200::1' ],
			'beside 2001:db8::/32' => [ '2001:db9::1' ],
			'beside 100::/64'      => [ '100:0:0:1::1' ],
			'beside 64:ff9b:1::/48' => [ '64:ff9b:2::5db8:d70e' ],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider( 'public_address_provider' )]
	public function test_a_public_address_proceeds( string $ip ): void {
		$this->fetch( $this->curl(), $this->url_message( 'https://outside-72.example/page-5' ) );

		$this->assertSame( \CURL_PREREQFUNC_OK, $this->connect_to( 0, $ip ) );
	}

	public function test_a_refused_address_answers_an_error_naming_it_and_the_url(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->url_message( 'https://inside-73.example/meta-9' ) );
		$this->connect_to( 0, '169.254.169.254' );

		$this->deliver_curl_rows( [ $this->done( $this->handles[0], \CURLE_ABORTED_BY_CALLBACK ) ] );

		$out = $this->only_emitted();
		$this->assertSame( Message::TM_ERROR, $out[ Message::TYPE ] );
		$this->assertSame( 'private address refused: 169.254.169.254 https://inside-73.example/meta-9', $out[ Message::VALUE ] );
		$this->assertSame( 'corr-6081', $out[ Message::ID ] );
		$this->assertSame( [], Event_Framework::instance()->handles_of( $node ) );
	}

	public function test_each_transfer_names_its_own_refused_address(): void {
		$node = $this->curl();
		$this->fetch( $node, $this->url_message( 'https://first-74.example/a' ) );
		$this->fetch( $node, $this->url_message( 'https://second-75.example/b' ) );
		$this->connect_to( 0, '10.74.0.1' );
		$this->connect_to( 1, 'fd00::75' );

		$this->deliver_curl_rows( [ $this->done( $this->handles[1], \CURLE_ABORTED_BY_CALLBACK ) ] );
		$this->deliver_curl_rows( [ $this->done( $this->handles[0], \CURLE_ABORTED_BY_CALLBACK ) ] );

		$this->assertSame(
			[ 'private address refused: fd00::75 https://second-75.example/b', 'private address refused: 10.74.0.1 https://first-74.example/a' ],
			\array_column( $this->sink->captured, Message::VALUE )
		);
	}

	/** A redirect hop to a private address is refused though the first hop was public. */
	public function test_a_redirect_hop_to_a_private_address_is_refused(): void {
		$this->fetch( $this->curl(), $this->url_message( 'https://hops-76.example/start' ) );

		$this->assertSame( \CURL_PREREQFUNC_OK, $this->connect_to( 0, '93.184.215.76' ) );
		$this->assertSame( \CURL_PREREQFUNC_ABORT, $this->connect_to( 0, '192.168.7.6' ) );
		$this->deliver_curl_rows( [ $this->done( $this->handles[0], \CURLE_ABORTED_BY_CALLBACK ) ] );

		$this->assertSame( 'private address refused: 192.168.7.6 https://hops-76.example/start', $this->only_emitted()[ Message::VALUE ] );
	}

	public function test_a_request_is_held_to_the_same_refusal(): void {
		$this->fetch( $this->curl(), $this->request_message( [ 'url' => 'https://gql-77.example/graphql', 'method' => 'POST', 'body' => '{}' ] ) );

		$this->assertSame( \CURL_PREREQFUNC_ABORT, $this->connect_to( 0, '127.0.0.77' ) );
	}

	public function test_allowing_private_addresses_sets_no_check(): void {
		$this->use_base_dir( $this->make_temp_dir(), [ 'curl_allow_private_addresses' => true ] );

		$this->fetch( $this->curl(), $this->url_message( 'http://internal-78.example:8090/feed' ) );

		$this->assertArrayNotHasKey( \CURLOPT_PREREQFUNCTION, $this->captured[0] );
	}

	public function test_without_the_pre_request_callback_every_fetch_is_refused(): void {
		Curl_Node::$prereq_available = static fn (): bool => false;

		$this->fetch( $this->curl(), $this->url_message( 'https://anywhere-79.example/x' ) );

		$this->assert_error( 'curl_allow_private_addresses is off and refusing a private address needs PHP 8.4 https://anywhere-79.example/x' );
	}

	public function test_without_the_callback_allowing_private_addresses_fetches(): void {
		$this->use_base_dir( $this->make_temp_dir(), [ 'curl_allow_private_addresses' => true ] );
		Curl_Node::$prereq_available = static fn (): bool => false;

		$this->fetch( $this->curl(), $this->url_message( 'http://internal-80.example:8090/feed' ) );

		$this->assertCount( 1, $this->captured );
		$this->assertSame( [], $this->sink->captured );
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
