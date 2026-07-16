<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;

#[CoversClass( Command_Auth::class )]
class CommandAuthTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		// Default the single-use seam to "always claimable" so window/HMAC logic
		// is what's under test; replay tests install their own stateful claim.
		Command_Auth::$claim_nonce = static fn ( string $nonce, int $ttl ): bool => true;
		$interpreter = new Command_Interpreter_Node;
		$interpreter->name( Node_Names::COMMAND_INTERPRETER );
	}

	protected function tearDown(): void {
		Command_Auth::$claim_nonce = null;
		Core::node( Node_Names::COMMAND_INTERPRETER )->remove_node();
		parent::tearDown();
	}

	/** Build a fresh TM_COMMAND with the canonical command VALUE. */
	private function command( string $name = 'make_node', array $args = [ 'Tee', 't' ] ): array {
		$m                    = Message::new_message();
		$m[ Message::TYPE ]   = Message::TM_COMMAND;
		$m[ Message::VALUE ]  = [ 'name' => $name, 'arguments' => $args ];
		return $m;
	}

	public function test_sign_injects_auth_envelope_and_preserves_command(): void {
		$m = $this->command();
		$m[ Message::TIMESTAMP ] = 1000;
		Command_Auth::sign( $m );
		$v = $m[ Message::VALUE ];
		$this->assertSame( 'make_node', $v['name'] );
		$this->assertSame( [ 'Tee', 't' ], $v['arguments'] );
		$this->assertIsArray( $v['auth'] );
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{32}$/', $v['auth']['nonce'] );
		$this->assertIsString( $v['auth']['sig'] );
		$this->assertNotSame( '', $v['auth']['sig'] );
	}

	public function test_verify_accepts_freshly_signed_command(): void {
		$m = $this->command();
		$m[ Message::TIMESTAMP ] = 1000;
		Command_Auth::sign( $m );
		$this->assertTrue( Command_Auth::verify( $m, 1000 ) );
	}

	public function test_sign_and_verify_round_trip_a_noreply_command(): void {
		// Topology-load commands carry TM_COMMAND|TM_NOREPLY. The HMAC covers TYPE,
		// so sign must stamp (and verify accept) the combined type — otherwise every
		// worker's boot topology fails HMAC and refuses to load.
		$m                  = $this->command();
		$m[ Message::TYPE ] = Message::TM_COMMAND | Message::TM_NOREPLY;
		$m[ Message::TIMESTAMP ] = 1000;
		Command_Auth::sign( $m );
		$this->assertIsArray( $m[ Message::VALUE ]['auth'] );
		$this->assertTrue( Command_Auth::verify( $m, 1000 ) );
	}

	public function test_sign_is_a_noop_on_a_command_response(): void {
		// Responses/errors (TM_COMMAND|TM_RESPONSE, TM_COMMAND|TM_ERROR) are never
		// signed — only inbound commands are.
		$m                  = $this->command();
		$m[ Message::TYPE ] = Message::TM_COMMAND | Message::TM_RESPONSE;
		$m[ Message::TIMESTAMP ] = 1000;
		Command_Auth::sign( $m );
		$this->assertArrayNotHasKey( 'auth', $m[ Message::VALUE ] );
	}

	public function test_verify_rejects_tampered_name(): void {
		$m = $this->command();
		$m[ Message::TIMESTAMP ] = 1000;
		Command_Auth::sign( $m );
		$m[ Message::VALUE ]['name'] = 'remove_node';
		$this->assertFalse( Command_Auth::verify( $m, 1000 ) );
	}

	public function test_verify_rejects_tampered_arguments(): void {
		$m = $this->command();
		$m[ Message::TIMESTAMP ] = 1000;
		Command_Auth::sign( $m );
		$m[ Message::VALUE ]['arguments'] = [ 'Tee', 'evil' ];
		$this->assertFalse( Command_Auth::verify( $m, 1000 ) );
	}

	public function test_verify_rejects_signature_too_old(): void {
		$m = $this->command();
		$m[ Message::TIMESTAMP ] = 1000;
		Command_Auth::sign( $m );
		// 21s later — past the 20s acceptance window.
		$this->assertFalse( Command_Auth::verify( $m, 1021 ) );
	}

	public function test_verify_accepts_within_past_window(): void {
		$m = $this->command();
		$m[ Message::TIMESTAMP ] = 1000;
		Command_Auth::sign( $m );
		// 19s later — still inside the 20s window.
		$this->assertTrue( Command_Auth::verify( $m, 1019 ) );
	}

	public function test_verify_rejects_future_signature_beyond_skew(): void {
		$m = $this->command();
		$m[ Message::TIMESTAMP ] = 1000;
		Command_Auth::sign( $m );
		// Verifier clock 11s behind the signer — beyond the 10s skew tolerance.
		$this->assertFalse( Command_Auth::verify( $m, 989 ) );
	}

	public function test_verify_rejects_replayed_nonce(): void {
		// Stateful single-use seam: first claim true, subsequent false.
		$seen = [];
		Command_Auth::$claim_nonce = static function ( string $nonce, int $ttl ) use ( &$seen ): bool {
			if ( isset( $seen[ $nonce ] ) ) {
				return false;
			}
			$seen[ $nonce ] = true;
			return true;
		};
		$m = $this->command();
		$m[ Message::TIMESTAMP ] = 1000;
		Command_Auth::sign( $m );
		$this->assertTrue( Command_Auth::verify( $m, 1000 ), 'first use accepted' );
		$this->assertFalse( Command_Auth::verify( $m, 1000 ), 'replay rejected' );
	}

	public function test_verify_rejects_missing_auth_envelope(): void {
		$m = $this->command(); // never signed
		$this->assertFalse( Command_Auth::verify( $m, 1000 ) );
	}

	public function test_verify_rejects_garbled_auth(): void {
		$m = $this->command();
		$m[ Message::VALUE ]['auth'] = [ 'ts' => 1000 ]; // missing sig + nonce
		$this->assertFalse( Command_Auth::verify( $m, 1000 ) );
	}

	public function test_verify_fails_closed_without_memcache(): void {
		// No claim seam, no Memcached handle → strict single-use can't be honored.
		Command_Auth::$claim_nonce = null;
		Core::$memd                = null;
		$captured                  = '';
		Core::set_stderr_handler( static function ( string $t ) use ( &$captured ): void {
			$captured .= $t;
		} );
		$m = $this->command();
		$m[ Message::TIMESTAMP ] = 1000;
		Command_Auth::sign( $m );
		$this->assertFalse( Command_Auth::verify( $m, 1000 ) );
		$this->assertStringContainsString( 'memcache', \strtolower( $captured ) );
	}

	public function test_verifier_closure_verifies_with_real_clock(): void {
		$m = $this->command();
		$m[ Message::TIMESTAMP ] = \time(); // real clock: verify() compares against time() with no $now pin
		Command_Auth::sign( $m );
		$verify = Command_Auth::verifier();
		$this->assertTrue( $verify( $m ) );
	}

	public function test_verifier_closure_accepts_in_process_local_without_signature(): void {
		// LOCAL can't cross IPC, so a verifier trusts its own in-process commands.
		$m = $this->command(); // unsigned
		$m[ Message::LOCAL ] = true;
		$verify = Command_Auth::verifier();
		$this->assertTrue( $verify( $m ) );
	}

	public function test_verifier_closure_rejects_unsigned_wire_command(): void {
		$m = $this->command(); // no LOCAL, no auth — as an IPC command would arrive
		$verify = Command_Auth::verifier();
		$this->assertFalse( $verify( $m ) );
	}

	public function test_non_command_value_without_name_is_rejected_by_verify(): void {
		$m                   = Message::new_message();
		$m[ Message::VALUE ] = 'not a command struct';
		$this->assertFalse( Command_Auth::verify( $m, 1000 ) );
	}

	public function test_nonce_ttl_outlives_full_acceptance_window(): void {
		// The nonce entry is claimed at first-verify time; it must outlive the full
		// past+future acceptance span or a clock-skewed verifier reopens replay.
		$this->assertGreaterThan(
			Command_Auth::MAX_PAST_S + Command_Auth::MAX_FUTURE_S,
			Command_Auth::NONCE_TTL_S
		);
	}

	public function test_verify_rejects_tampered_type(): void {
		// TYPE is part of the canonical, so re-typing a signed command breaks it.
		$m = $this->command();
		$m[ Message::TIMESTAMP ] = 1000;
		Command_Auth::sign( $m );
		$m[ Message::TYPE ] = Message::TM_COMMAND | Message::TM_STRUCT;
		$this->assertFalse( Command_Auth::verify( $m, 1000 ) );
	}

	public function test_sign_refuses_unencodable_arguments(): void {
		// Invalid UTF-8 makes wp_json_encode return false; signing must fail closed
		// (no auth) rather than collapse onto an HMAC('') collision.
		$m = $this->command( 'make_node', [ "\xB1\x31" ] );
		$m[ Message::TIMESTAMP ] = 1000;
		Command_Auth::sign( $m );
		$this->assertArrayNotHasKey( 'auth', $m[ Message::VALUE ] );
		$this->assertFalse( Command_Auth::verify( $m, 1000 ) );
	}
}
