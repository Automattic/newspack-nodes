<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Supervisor;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Supervisor::class )]
class SupervisorTest extends TestCase {
	public function test_spawn_token_uses_hmac_with_window(): void {
		$s = new Supervisor( '/tmp', 'NONCE_SALT_FOR_TEST' );
		$now = 1000000;
		$token = $s->generate_spawn_token( $now );
		$this->assertSame( 64, strlen( $token ) );
	}

	public function test_spawn_token_rotates_per_10s_window(): void {
		$s = new Supervisor( '/tmp', 'NONCE_SALT_FOR_TEST' );
		$t1 = $s->generate_spawn_token( 1000000 );
		$t2 = $s->generate_spawn_token( 1000005 );
		$t3 = $s->generate_spawn_token( 1000015 );
		$this->assertSame( $t1, $t2 );
		$this->assertNotSame( $t1, $t3 );
	}

	public function test_validate_spawn_token_accepts_current_window(): void {
		$s = new Supervisor( '/tmp', 'NONCE_SALT_FOR_TEST' );
		$now = 1000000;
		$token = $s->generate_spawn_token( $now );
		$this->assertTrue( $s->validate_spawn_token( $token, $now ) );
	}

	public function test_validate_spawn_token_accepts_previous_window(): void {
		$s = new Supervisor( '/tmp', 'NONCE_SALT_FOR_TEST' );
		$prev_token = $s->generate_spawn_token( 1000000 );
		$this->assertTrue( $s->validate_spawn_token( $prev_token, 1000012 ) );
	}

	public function test_validate_spawn_token_rejects_two_windows_old(): void {
		$s = new Supervisor( '/tmp', 'NONCE_SALT_FOR_TEST' );
		$old_token = $s->generate_spawn_token( 1000000 );
		$this->assertFalse( $s->validate_spawn_token( $old_token, 1000025 ) );
	}
}
