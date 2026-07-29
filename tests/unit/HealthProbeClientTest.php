<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Health_Checks;
use Newspack_Nodes\Health_Probe_Client;
use Newspack_Nodes\Internal_Request_Token;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;

#[CoversClass( Health_Probe_Client::class )]
class HealthProbeClientTest extends TestCase {

	private bool $saved_verify_spawn_tls;

	protected function setUp(): void {
		parent::setUp();
		$this->saved_verify_spawn_tls = Core::$verify_spawn_tls;
		Core::$verify_spawn_tls       = false;
	}

	protected function tearDown(): void {
		Health_Probe_Client::$http_call = null;
		Health_Probe_Client::$clock     = null;
		Core::$verify_spawn_tls         = $this->saved_verify_spawn_tls;
		parent::tearDown();
	}

	/** @return array{id:string,label:string,status:string,messages:array<int,string>} */
	private function valid_result(): array {
		return [
			'id'       => Health_Checks::CACHE_ID,
			'label'    => Health_Checks::CACHE_LABEL,
			'status'   => Health_Checks::STATUS_GOOD,
			'messages' => [ 'Cache backend APCu probe 8843 succeeded.' ],
		];
	}

	public function test_health_probe_client_class_exists(): void {
		$this->assertTrue( \class_exists( 'Newspack_Nodes\\Health_Probe_Client' ) );
	}

	public function test_posts_a_purpose_token_with_bounded_options(): void {
		$now           = 3_000_027;
		$captured_url  = null;
		$captured_args = null;
		$valid         = $this->valid_result();
		Health_Probe_Client::$clock = static fn (): int => $now;
		Health_Probe_Client::$http_call = static function ( string $url, array $args ) use ( &$captured_url, &$captured_args, $valid ): array {
			$captured_url  = $url;
			$captured_args = $args;
			return [
				'response' => [ 'code' => 200 ],
				'body'     => \wp_json_encode( $valid ),
			];
		};

		$result = Health_Probe_Client::cache_backend();

		$this->assertSame( $valid, $result );
		$this->assertSame( 'http://localhost/wp-json/newspack-nodes/v1/health/cache', $captured_url );
		$this->assertIsArray( $captured_args );
		$this->assertSame( 5, $captured_args['timeout'] );
		$this->assertSame( 0, $captured_args['redirection'] );
		$this->assertSame( 2048, $captured_args['limit_response_size'] );
		$this->assertSame( Core::$verify_spawn_tls, $captured_args['sslverify'] );
		$this->assertSame( [ 'token' ], \array_keys( $captured_args['body'] ) );
		$this->assertMatchesRegularExpression( '/\A[a-f0-9]{64}\z/', $captured_args['body']['token'] );
		$this->assertTrue(
			Internal_Request_Token::validate(
				Internal_Request_Token::PURPOSE_HEALTH_CACHE,
				$captured_args['body']['token'],
				$now,
				\wp_salt( 'nonce' )
			)
		);
	}

	#[DataProvider( 'malformed_results' )]
	public function test_rejects_malformed_results_without_echoing_response_data(
		mixed $payload,
		?string $marker,
		bool $encode
	): void {
		$body = $encode ? \wp_json_encode( $payload ) : $payload;
		Health_Probe_Client::$http_call = static fn ( string $url, array $args ): array => [
			'response' => [ 'code' => 200 ],
			'body'     => $body,
		];

		$result = Health_Probe_Client::cache_backend();

		$keys = \array_keys( $result );
		\sort( $keys );
		$this->assertSame( [ 'id', 'label', 'messages', 'status' ], $keys );
		$this->assertSame( Health_Checks::CACHE_ID, $result['id'] );
		$this->assertSame( Health_Checks::CACHE_LABEL, $result['label'] );
		$this->assertSame( Health_Checks::STATUS_RECOMMENDED, $result['status'] );
		$this->assertCount( 1, $result['messages'] );
		$this->assertStringContainsString( 'Could not verify the web cache backend', $result['messages'][0] );
		$this->assertStringNotContainsString( 'worker respawn', $result['messages'][0] );
		if ( null !== $marker ) {
			$this->assertStringNotContainsString( $marker, $result['messages'][0] );
		}
	}

	public static function malformed_results(): iterable {
		$valid = [
			'id'       => Health_Checks::CACHE_ID,
			'label'    => Health_Checks::CACHE_LABEL,
			'status'   => Health_Checks::STATUS_GOOD,
			'messages' => [ 'Valid cache result 8843.' ],
		];

		yield 'wrong id' => [
			\array_replace( $valid, [ 'id' => 'ATTACKER_ID_8843' ] ),
			'ATTACKER_ID_8843',
			true,
		];
		yield 'wrong label' => [
			\array_replace( $valid, [ 'label' => 'ATTACKER_LABEL_8843' ] ),
			'ATTACKER_LABEL_8843',
			true,
		];
		yield 'wrong status' => [
			\array_replace( $valid, [ 'status' => 'ATTACKER_STATUS_8843' ] ),
			'ATTACKER_STATUS_8843',
			true,
		];
		yield 'extra field' => [
			\array_replace( $valid, [ 'extra' => 'ATTACKER_EXTRA_8843' ] ),
			'ATTACKER_EXTRA_8843',
			true,
		];
		yield 'missing field' => [
			[
				'id'       => Health_Checks::CACHE_ID,
				'label'    => Health_Checks::CACHE_LABEL,
				'status'   => Health_Checks::STATUS_GOOD,
			],
			null,
			true,
		];
		yield 'id type' => [ \array_replace( $valid, [ 'id' => 8_843 ] ), null, true ];
		yield 'label type' => [ \array_replace( $valid, [ 'label' => 8_843 ] ), null, true ];
		yield 'status type' => [ \array_replace( $valid, [ 'status' => 8_843 ] ), null, true ];
		yield 'messages type' => [
			\array_replace( $valid, [ 'messages' => 'ATTACKER_MESSAGES_8843' ] ),
			'ATTACKER_MESSAGES_8843',
			true,
		];
		yield 'associative messages' => [
			\array_replace( $valid, [ 'messages' => [ 'first' => 'ATTACKER_ASSOC_8843' ] ] ),
			'ATTACKER_ASSOC_8843',
			true,
		];
		yield 'message type' => [ \array_replace( $valid, [ 'messages' => [ 8_843 ] ] ), null, true ];
		yield 'multiple messages' => [
			\array_replace( $valid, [ 'messages' => [ 'ATTACKER_MULTI_8843_A', 'ATTACKER_MULTI_8843_B' ] ] ),
			'ATTACKER_MULTI_8843',
			true,
		];
		yield 'empty message' => [ \array_replace( $valid, [ 'messages' => [ '' ] ] ), null, true ];
		yield 'newline' => [
			\array_replace( $valid, [ 'messages' => [ "ATTACKER_NEWLINE_8843\nFAIL injected" ] ] ),
			'ATTACKER_NEWLINE_8843',
			true,
		];
		yield 'escape' => [
			\array_replace( $valid, [ 'messages' => [ "ATTACKER_ESCAPE_8843\x1b[31m" ] ] ),
			'ATTACKER_ESCAPE_8843',
			true,
		];
		yield 'del' => [
			\array_replace( $valid, [ 'messages' => [ "ATTACKER_DEL_8843\x7f" ] ] ),
			'ATTACKER_DEL_8843',
			true,
		];
		yield 'c1 control' => [
			\array_replace( $valid, [ 'messages' => [ "ATTACKER_C1_8843\u{009b}31m" ] ] ),
			'ATTACKER_C1_8843',
			true,
		];
		yield 'line separator' => [
			\array_replace( $valid, [ 'messages' => [ "ATTACKER_LINE_SEPARATOR_8843\u{2028}FAIL injected" ] ] ),
			'ATTACKER_LINE_SEPARATOR_8843',
			true,
		];
		yield 'paragraph separator' => [
			\array_replace( $valid, [ 'messages' => [ "ATTACKER_PARAGRAPH_SEPARATOR_8843\u{2029}FAIL injected" ] ] ),
			'ATTACKER_PARAGRAPH_SEPARATOR_8843',
			true,
		];
		yield 'oversized' => [
			\array_replace( $valid, [ 'messages' => [ 'ATTACKER_OVERSIZED_8843' . \str_repeat( 'z', 513 ) ] ] ),
			'ATTACKER_OVERSIZED_8843',
			true,
		];
		yield 'invalid utf8' => [
			"{\"id\":\"cache-backend\",\"label\":\"Cache backend\",\"status\":\"good\",\"messages\":[\"ATTACKER_UTF8_8843\xff\"]}",
			'ATTACKER_UTF8_8843',
			false,
		];
		yield 'root list' => [ [ 'ATTACKER_LIST_8843' ], 'ATTACKER_LIST_8843', true ];
		yield 'root scalar' => [ 'ATTACKER_SCALAR_8843', 'ATTACKER_SCALAR_8843', true ];
		yield 'invalid json' => [ '{"ATTACKER_JSON_8843":', 'ATTACKER_JSON_8843', false ];
		yield 'empty body' => [ '', null, false ];
	}

	#[DataProvider( 'valid_statuses' )]
	public function test_accepts_each_allowed_status_and_the_message_byte_limit(
		string $status,
		string $message
	): void {
		$expected = \array_replace(
			$this->valid_result(),
			[
				'status'   => $status,
				'messages' => [ $message ],
			]
		);
		Health_Probe_Client::$http_call = static fn ( string $url, array $args ): array => [
			'response' => [ 'code' => 200 ],
			'body'     => \wp_json_encode( $expected ),
		];

		$this->assertSame( $expected, Health_Probe_Client::cache_backend() );
	}

	public static function valid_statuses(): iterable {
		yield 'good at 512 bytes' => [ Health_Checks::STATUS_GOOD, \str_repeat( 'g', 512 ) ];
		yield 'recommended' => [ Health_Checks::STATUS_RECOMMENDED, 'Cache probe recommendation 8843.' ];
		yield 'critical' => [ Health_Checks::STATUS_CRITICAL, 'Cache probe critical result 8843.' ];
	}

	#[DataProvider( 'transport_errors' )]
	public function test_transport_errors_are_classified_without_echoing_details(
		string $detail,
		string $expected_fragment,
		bool $mentions_spawn
	): void {
		Health_Probe_Client::$http_call = static fn ( string $url, array $args ): \WP_Error =>
			new \WP_Error( 'http_request_failed', $detail );

		$result  = Health_Probe_Client::cache_backend();
		$message = $result['messages'][0];

		$this->assertSame( Health_Checks::CACHE_ID, $result['id'] );
		$this->assertSame( Health_Checks::CACHE_LABEL, $result['label'] );
		$this->assertSame( Health_Checks::STATUS_RECOMMENDED, $result['status'] );
		$this->assertStringContainsString( $expected_fragment, $message );
		$this->assertStringNotContainsString( $detail, $message );
		$this->assertSame( $mentions_spawn, \str_contains( $message, 'worker respawn' ) );
	}

	public static function transport_errors(): iterable {
		yield 'dns' => [
			'cURL error 6: Could not resolve host ATTACKER_DNS_8843.invalid',
			'DNS, connection, or TLS failed',
			true,
		];
		yield 'connect' => [
			'cURL error 7: Failed to connect ATTACKER_CONNECT_8843',
			'DNS, connection, or TLS failed',
			true,
		];
		yield 'tls' => [
			'cURL error 60: SSL certificate problem ATTACKER_TLS_8843',
			'DNS, connection, or TLS failed',
			true,
		];
		yield 'timeout' => [
			'cURL error 28: Operation timed out ATTACKER_TIMEOUT_8843',
			'health request timed out',
			false,
		];
		yield 'generic' => [
			'ATTACKER_GENERIC_ERROR_8843',
			'loopback request failed',
			false,
		];
	}

	public function test_curl_timeout_with_connect_wording_does_not_warn_about_respawn(): void {
		$detail = 'cURL error 28: Failed to connect to localhost port 443: Operation timed out';
		Health_Probe_Client::$http_call = static fn ( string $url, array $args ): \WP_Error =>
			new \WP_Error( 'http_request_failed', $detail );

		$result  = Health_Probe_Client::cache_backend();
		$message = $result['messages'][0];

		$this->assertSame( Health_Checks::STATUS_RECOMMENDED, $result['status'] );
		$this->assertStringContainsString( 'health request timed out', $message );
		$this->assertStringNotContainsString( 'normal worker respawn', $message );
		$this->assertStringNotContainsString( 'impaired', $message );
		$this->assertStringNotContainsString( $detail, $message );
	}

	public function test_non_http_transport_value_is_locally_classified_as_malformed(): void {
		Health_Probe_Client::$http_call = static fn ( string $url, array $args ): string =>
			'ATTACKER_RAW_RESPONSE_8843';

		$result  = Health_Probe_Client::cache_backend();
		$message = $result['messages'][0];

		$this->assertSame( Health_Checks::STATUS_RECOMMENDED, $result['status'] );
		$this->assertStringContainsString( 'malformed HTTP response', $message );
		$this->assertStringNotContainsString( 'ATTACKER_RAW_RESPONSE_8843', $message );
		$this->assertStringNotContainsString( 'worker respawn', $message );
	}

	public function test_non_integer_http_code_is_locally_classified_without_echoing_detail(): void {
		Health_Probe_Client::$http_call = static fn ( string $url, array $args ): array => [
			'headers'       => [],
			'body'          => '{"ATTACKER_HTTP_CODE_BODY_8843":true}',
			'response'      => [
				'code'    => "500\nFAIL injected",
				'message' => 'Injected failure 8843',
			],
			'cookies'       => [],
			'filename'      => null,
			'http_response' => null,
		];

		$result  = Health_Probe_Client::cache_backend();
		$message = $result['messages'][0];

		$this->assertSame( Health_Checks::CACHE_ID, $result['id'] );
		$this->assertSame( Health_Checks::CACHE_LABEL, $result['label'] );
		$this->assertSame( Health_Checks::STATUS_RECOMMENDED, $result['status'] );
		$this->assertStringContainsString( 'malformed HTTP response', $message );
		$this->assertStringNotContainsString( "\n", $message );
		$this->assertStringNotContainsString( 'FAIL injected', $message );
		$this->assertStringNotContainsString( 'ATTACKER_HTTP_CODE_BODY_8843', $message );
	}

	public function test_non_string_http_body_is_locally_classified_without_type_error(): void {
		Health_Probe_Client::$http_call = static fn ( string $url, array $args ): array => [
			'headers'       => [],
			'body'          => [ 'ATTACKER_HTTP_BODY_ARRAY_8843' ],
			'response'      => [
				'code'    => 200,
				'message' => 'OK',
			],
			'cookies'       => [],
			'filename'      => null,
			'http_response' => null,
		];

		try {
			$result = Health_Probe_Client::cache_backend();
		} catch ( \TypeError ) {
			$this->fail( 'Array response bodies must be locally classified without a TypeError.' );
		}

		$this->assertSame( Health_Checks::CACHE_ID, $result['id'] );
		$this->assertSame( Health_Checks::CACHE_LABEL, $result['label'] );
		$this->assertSame( Health_Checks::STATUS_RECOMMENDED, $result['status'] );
		$this->assertStringContainsString( 'malformed response body', $result['messages'][0] );
		$this->assertStringNotContainsString( 'ATTACKER_HTTP_BODY_ARRAY_8843', $result['messages'][0] );
	}

	#[DataProvider( 'http_errors' )]
	public function test_http_errors_override_untrusted_bodies(
		int $code,
		string $expected_fragment,
		bool $mentions_spawn
	): void {
		$untrusted = \array_replace(
			$this->valid_result(),
			[ 'messages' => [ 'ATTACKER_HTTP_BODY_8843' ] ]
		);
		Health_Probe_Client::$http_call = static fn ( string $url, array $args ): array => [
			'response' => [ 'code' => $code ],
			'body'     => \wp_json_encode( $untrusted ),
		];

		$result  = Health_Probe_Client::cache_backend();
		$message = $result['messages'][0];

		$this->assertSame( Health_Checks::CACHE_ID, $result['id'] );
		$this->assertSame( Health_Checks::CACHE_LABEL, $result['label'] );
		$this->assertSame( Health_Checks::STATUS_RECOMMENDED, $result['status'] );
		$this->assertStringContainsString( $expected_fragment, $message );
		$this->assertStringNotContainsString( 'ATTACKER_HTTP_BODY_8843', $message );
		$this->assertSame( $mentions_spawn, \str_contains( $message, 'worker respawn' ) );
	}

	public static function http_errors(): iterable {
		yield 'redirect' => [ 301, 'unsafe redirect (HTTP 301)', false ];
		yield 'authentication' => [ 401, 'HTTP authentication rejected', true ];
		yield 'health token' => [ 403, 'purpose-specific token', false ];
		yield 'mixed versions' => [ 404, 'CLI and web plugin versions may differ', false ];
		yield 'server error' => [ 500, 'health route returned HTTP 500', false ];
	}
}
