<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Internal_Request_Token;
use Newspack_Nodes\Supervisor;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Internal_Request_Token::class )]
class InternalRequestTokenTest extends TestCase {
	private const NOW  = 1_000_027;
	private const SALT = 'HEALTH_PLAN_SALT_7319';

	public function test_internal_request_token_class_exists(): void {
		$this->assertTrue(
			\class_exists( 'Newspack_Nodes\\Internal_Request_Token' ),
			'The pure internal-token helper must be autoloadable.'
		);
	}

	public function test_current_and_previous_health_windows_are_accepted(): void {
		$current = Internal_Request_Token::generate(
			Internal_Request_Token::PURPOSE_HEALTH_CACHE,
			self::NOW,
			self::SALT
		);
		$previous = Internal_Request_Token::generate(
			Internal_Request_Token::PURPOSE_HEALTH_CACHE,
			self::NOW - Internal_Request_Token::WINDOW_S,
			self::SALT
		);

		$this->assertTrue( Internal_Request_Token::validate(
			Internal_Request_Token::PURPOSE_HEALTH_CACHE,
			$current,
			self::NOW,
			self::SALT
		) );
		$this->assertTrue( Internal_Request_Token::validate(
			Internal_Request_Token::PURPOSE_HEALTH_CACHE,
			$previous,
			self::NOW,
			self::SALT
		) );
	}

	public function test_expired_and_future_health_windows_are_rejected(): void {
		$expired = Internal_Request_Token::generate(
			Internal_Request_Token::PURPOSE_HEALTH_CACHE,
			self::NOW - ( 2 * Internal_Request_Token::WINDOW_S ),
			self::SALT
		);
		$future = Internal_Request_Token::generate(
			Internal_Request_Token::PURPOSE_HEALTH_CACHE,
			self::NOW + Internal_Request_Token::WINDOW_S,
			self::SALT
		);

		$this->assertFalse( Internal_Request_Token::validate(
			Internal_Request_Token::PURPOSE_HEALTH_CACHE,
			$expired,
			self::NOW,
			self::SALT
		) );
		$this->assertFalse( Internal_Request_Token::validate(
			Internal_Request_Token::PURPOSE_HEALTH_CACHE,
			$future,
			self::NOW,
			self::SALT
		) );
	}

	public function test_spawn_and_health_tokens_are_not_interchangeable(): void {
		$spawn = Internal_Request_Token::generate(
			Internal_Request_Token::PURPOSE_SPAWN,
			self::NOW,
			self::SALT
		);

		$this->assertFalse( Internal_Request_Token::validate(
			Internal_Request_Token::PURPOSE_HEALTH_CACHE,
			$spawn,
			self::NOW,
			self::SALT
		) );
	}

	public function test_supervisor_spawn_token_wire_value_is_unchanged(): void {
		$supervisor = new Supervisor( '/tmp/token-test-7319', self::SALT );
		$window     = (int) \floor( self::NOW / 10 );
		$expected   = \hash_hmac(
			'sha256',
			"newspack_nodes_spawn:{$window}",
			self::SALT
		);

		$this->assertSame(
			$expected,
			Internal_Request_Token::generate(
				Internal_Request_Token::PURPOSE_SPAWN,
				self::NOW,
				self::SALT
			)
		);
		$this->assertSame( $expected, $supervisor->generate_spawn_token( self::NOW ) );
	}

	public function test_empty_required_inputs_fail_loudly(): void {
		$this->expectException( \InvalidArgumentException::class );
		Internal_Request_Token::generate( '', self::NOW, self::SALT );
	}

	public function test_empty_salt_fails_loudly(): void {
		$this->expectException( \InvalidArgumentException::class );
		Internal_Request_Token::generate(
			Internal_Request_Token::PURPOSE_HEALTH_CACHE,
			self::NOW,
			''
		);
	}
}
