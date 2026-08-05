<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;

/**
 * First contact with a spoke is itself a command, so it needs a session: /auth
 * must precede `discovery get`. And the credentials that authenticate to /auth
 * now bootstrap every session key, which is why the missing require_ssl check
 * lands in the same slice.
 */
#[CoversClass( Service_CI_Node::class )]
class ServiceCiSessionTest extends TestCase {

	private const HTTPS_SPOKE = 'https://spoke.example';
	private const PLAIN_SPOKE = 'http://spoke.example';

	private ?\Memcached $prev_memd = null;

	protected function setUp(): void {
		parent::setUp();
		$this->prev_memd = Core::$memd;
		Core::$memd      = new InMemoryMemcached();
		// This file exercises the handshake, so it must start with NO session.
		// The map is process-static and other suites seed the same destination.
		Command_Auth::forget_session( 'test-spoke' );
	}

	protected function tearDown(): void {
		HTTP_Out_Node::$http_call = null;
		Command_Auth::forget_session( 'test-spoke' );
		Core::$memd                 = $this->prev_memd;
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	/** Record every outbound call so ordering is assertable. */
	private function capture( array &$calls ): void {
		$self                       = $this;
		HTTP_Out_Node::$http_call = static function ( string $url, array $args ) use ( &$calls, $self ): array {
			$calls[] = [ 'url' => $url, 'args' => $args ];
			return \str_ends_with( $url, '/auth' )
				? [ 'response' => [ 'code' => 200 ], 'body' => (string) \wp_json_encode( Command_Auth::mint_session() ) ]
				: [ 'response' => [ 'code' => 200 ], 'body' => $self->reply_body( [ 'lag' => 7 ] ) ];
		};
	}

	public function reply_body( array $payload ): string {
		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$reply[ Message::VALUE ] = [ 'name' => 'get', 'payload' => $payload ];
		return Message::packed( $reply );
	}

	public function test_probe_authenticates_before_it_sends_a_command(): void {
		$calls = [];
		$this->capture( $calls );

		ServiceCITestProbe::probe_command_probe(
			[ 'url' => self::HTTPS_SPOKE, 'auth_username' => 'u', 'auth_password' => 'p' ],
			'discovery',
			'get'
		);

		$this->assertCount( 2, $calls, 'one /auth, then one /command' );
		$this->assertStringEndsWith( '/wp-json/newspack-nodes/v1/auth', $calls[0]['url'] );
		$this->assertStringEndsWith( '/wp-json/newspack-nodes/v1/command', $calls[1]['url'] );
	}

	public function test_the_probe_command_is_signed_under_the_issued_session(): void {
		$calls = [];
		$this->capture( $calls );

		ServiceCITestProbe::probe_command_probe(
			[ 'url' => self::HTTPS_SPOKE, 'auth_username' => 'u', 'auth_password' => 'p' ],
			'discovery',
			'get'
		);

		$issued  = \json_decode( (string) $calls[0]['args']['body'] ?? '', true );
		$sent    = Message::unpacked( (string) $calls[1]['args']['body'] );
		$this->assertIsArray( $sent[ Message::VALUE ]['auth'] ?? null, 'the probe must be signed' );
		$this->assertNotSame( '', $sent[ Message::VALUE ]['auth']['handle'] ?? '' );
	}

	/**
	 * The two data-plane consumers refuse a plaintext spoke; this path did not,
	 * and it is the one that puts the stored password on the wire.
	 */
	public function test_probe_refuses_a_plaintext_spoke_when_require_ssl_is_set(): void {
		$this->use_base_dir( $this->make_temp_dir(), [ 'vault_require_ssl' => true ] );
		$calls = [];
		$this->capture( $calls );

		$threw = false;
		try {
			ServiceCITestProbe::probe_command_probe(
				[ 'url' => self::PLAIN_SPOKE, 'auth_username' => 'u', 'auth_password' => 'p' ],
				'discovery',
				'get'
			);
		} catch ( \RuntimeException $e ) {
			$threw = true;
		}

		$this->assertTrue( $threw );
		$this->assertCount( 0, $calls, 'no credential may reach the wire' );
	}

	/** Distinct from the shipped default, so a hardcoded refusal fails this. */
	public function test_probe_allows_a_plaintext_spoke_when_require_ssl_is_off(): void {
		$this->use_base_dir( $this->make_temp_dir(), [ 'vault_require_ssl' => false ] );
		$calls = [];
		$this->capture( $calls );

		ServiceCITestProbe::probe_command_probe(
			[ 'url' => self::PLAIN_SPOKE, 'auth_username' => 'u', 'auth_password' => 'p' ],
			'discovery',
			'get'
		);

		$this->assertCount( 2, $calls );
	}
}
