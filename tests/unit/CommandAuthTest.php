<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Tests\TestCase;
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
		$this->assertTrue( Command_Auth::verify( $m, 1000, 1000 ) );
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
		$this->assertTrue( Command_Auth::verify( $m, 1000, 1000 ) );
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
		$this->assertFalse( Command_Auth::verify( $m, 1000, 1000 ) );
	}

	public function test_verify_rejects_tampered_arguments(): void {
		$m = $this->command();
		$m[ Message::TIMESTAMP ] = 1000;
		Command_Auth::sign( $m );
		$m[ Message::VALUE ]['arguments'] = [ 'Tee', 'evil' ];
		$this->assertFalse( Command_Auth::verify( $m, 1000, 1000 ) );
	}

	public function test_verify_rejects_signature_too_old(): void {
		$m = $this->command();
		$m[ Message::TIMESTAMP ] = 1000;
		Command_Auth::sign( $m );
		// 21s later — past the 20s acceptance window.
		$this->assertFalse( Command_Auth::verify( $m, 1021, 1021 ) );
	}

	public function test_verify_accepts_within_past_window(): void {
		$m = $this->command();
		$m[ Message::TIMESTAMP ] = 1000;
		Command_Auth::sign( $m );
		// 19s later — still inside the 20s window.
		$this->assertTrue( Command_Auth::verify( $m, 1019, 1019 ) );
	}

	public function test_verify_rejects_future_signature_beyond_skew(): void {
		$m = $this->command();
		$m[ Message::TIMESTAMP ] = 1000;
		Command_Auth::sign( $m );
		// Verifier clock 11s behind the signer — beyond the 10s skew tolerance.
		$this->assertFalse( Command_Auth::verify( $m, 989, 989 ) );
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
		$this->assertTrue( Command_Auth::verify( $m, 1000, 1000 ), 'first use accepted' );
		$this->assertFalse( Command_Auth::verify( $m, 1000, 1000 ), 'replay rejected' );
	}

	public function test_verify_rejects_missing_auth_envelope(): void {
		$m = $this->command(); // never signed
		$this->assertFalse( Command_Auth::verify( $m, 1000, 1000 ) );
	}

	public function test_verify_rejects_garbled_auth(): void {
		$m = $this->command();
		$m[ Message::VALUE ]['auth'] = [ 'ts' => 1000 ]; // missing sig + nonce
		$this->assertFalse( Command_Auth::verify( $m, 1000, 1000 ) );
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
		$this->assertFalse( Command_Auth::verify( $m, 1000, 1000 ) );
		$this->assertStringContainsString( 'memcache', \strtolower( $captured ) );
	}

	public function test_verifier_closure_verifies_with_real_clock(): void {
		$m = $this->command();
		$m[ Message::TIMESTAMP ] = \time(); // real clock: verify() compares against time() with no $now pin
		Command_Auth::sign( $m );
		$verify = Command_Auth::verifier();
		$this->assertTrue( $verify( new Command_Interpreter_Node(), $m ) );
	}

	public function test_verifier_judges_freshness_against_the_pinned_core_clock(): void {
		Core::$clock = static fn (): float => 1_900_000_000.0;
		try {
			$m                       = $this->command();
			$m[ Message::TIMESTAMP ] = 1_900_000_000;
			Command_Auth::sign( $m );
			$verify = Command_Auth::verifier();
			$this->assertTrue( $verify( new Command_Interpreter_Node(), $m ) );
		} finally {
			Core::$clock = null;
		}
	}

	public function test_verifier_closure_accepts_in_process_local_without_signature(): void {
		// LOCAL can't cross IPC, so a verifier trusts its own in-process commands.
		$m = $this->command(); // unsigned
		$m[ Message::LOCAL ] = true;
		$verify = Command_Auth::verifier();
		$this->assertTrue( $verify( new Command_Interpreter_Node(), $m ) );
	}

	public function test_verifier_closure_rejects_unsigned_wire_command(): void {
		$m = $this->command(); // no LOCAL, no auth — as an IPC command would arrive
		$verify = Command_Auth::verifier();
		$this->assertFalse( $verify( new Command_Interpreter_Node(), $m ) );
	}

	public function test_non_command_value_without_name_is_rejected_by_verify(): void {
		$m                   = Message::new_message();
		$m[ Message::VALUE ] = 'not a command struct';
		$this->assertFalse( Command_Auth::verify( $m, 1000, 1000 ) );
	}

	public function test_nonce_ttl_outlives_full_acceptance_window(): void {
		// The nonce entry is claimed at first-verify time; it must outlive the full
		// past+future acceptance span or a clock-skewed verifier reopens replay.
		$this->assertGreaterThan(
			Command_Auth::MAX_PAST_S + Command_Auth::MAX_FUTURE_S,
			Command_Auth::NONCE_TTL_S
		);
	}

	/**
	 * TYPE is deliberately NOT signed — it is envelope, like TO and FROM, and
	 * Tachikoma's Command::sign covers `id:timestamp:name:arguments:payload` for
	 * the same reason. Leaving it out is what lets a mint sign at build time
	 * rather than after every flag has been OR'd in.
	 *
	 * That is safe because re-typing cannot change WHAT RUNS: name and arguments
	 * are signed. A tamperer can only make the message stop being a command (it
	 * is then never interpreted), make it fail the request-command predicate (it
	 * is then refused), or toggle TM_NOREPLY. None of those reach a verb.
	 */
	public function test_retyping_a_signed_command_does_not_change_what_runs(): void {
		$m                       = $this->command();
		$m[ Message::TIMESTAMP ] = 1000;
		Command_Auth::sign( $m );

		$m[ Message::TYPE ] = Message::TM_COMMAND | Message::TM_STRUCT;
		$this->assertTrue( Command_Auth::verify( $m, 1000, 1000 ), 'flags are not signed' );

		// The semantics are, and that is the property that matters.
		$value              = $m[ Message::VALUE ];
		$value['arguments'] = [ 'Tee', 'evil' ];
		$m[ Message::VALUE ] = $value;
		$this->assertFalse( Command_Auth::verify( $m, 1000, 1000 ) );
	}

	/** Adding TM_RESPONSE does not sneak past: the predicate refuses it outright. */
	public function test_a_retyped_response_is_refused_by_the_predicate(): void {
		$m                       = $this->command();
		$m[ Message::TIMESTAMP ] = 1000;
		Command_Auth::sign( $m );
		$m[ Message::TYPE ] = Message::TM_COMMAND | Message::TM_RESPONSE;

		$this->assertFalse( Command_Auth::verify( $m, 1000, 1000 ) );
	}

	/**
	 * Each refusal `verifier()` logs, keyed by the reason it names, beside a
	 * command shaped to earn it at clock 1790077460.
	 *
	 * @return array<string,array{0:string,1:\Closure():array<int,mixed>}>
	 */
	public static function refusals(): array {
		$signed = static function ( int $ts, array $args = [ 'feed7746' ] ): array {
			$m                       = Message::new_message();
			$m[ Message::TYPE ]      = Message::TM_COMMAND;
			$m[ Message::FROM ]      = '_output/feed7746';
			$m[ Message::TIMESTAMP ] = $ts;
			$m[ Message::VALUE ]     = [ 'name' => 'uptime', 'arguments' => $args ];
			Command_Auth::sign( $m );
			return $m;
		};
		return [
			'wrong type'         => [ 'wrong type', static function () use ( $signed ): array {
				$m                       = $signed( 1790077460 );
				$m[ Message::TIMESTAMP ] = 'feed7746';
				return $m;
			} ],
			'bad envelope'       => [ 'bad envelope', static function () use ( $signed ): array {
				$m = $signed( 1790077460 );
				unset( $m[ Message::VALUE ]['auth']['nonce'] );
				return $m;
			} ],
			'stale timestamp'    => [ 'timestamp out of range', static fn (): array => $signed( 1790077460 - 3600 ) ],
			'invalid signature'  => [ 'invalid signature', static function () use ( $signed ): array {
				$m = $signed( 1790077460 );
				$m[ Message::VALUE ]['arguments'] = [ "\xB1\x46" ];
				return $m;
			} ],
			'signature mismatch' => [ 'signature mismatch', static function () use ( $signed ): array {
				$m = $signed( 1790077460 );
				$m[ Message::VALUE ]['name'] = 'feed7746';
				return $m;
			} ],
		];
	}

	/**
	 * A refusal's reason reaches the error log and nothing a caller reads:
	 * not the stderr sink, which is a `/command` body, an SSE stream or a
	 * worker's IPC output, and not the `dmesg` ring a READ verb prints.
	 *
	 * @param string                       $reason  What the log line names.
	 * @param \Closure():array<int,mixed> $command Builds the refused command.
	 */
	#[\PHPUnit\Framework\Attributes\DataProvider( 'refusals' )]
	public function test_a_refusal_reason_reaches_the_error_log_alone( string $reason, \Closure $command ): void {
		Core::$clock = static fn (): float => 1790077460.0;
		$sunk        = [];
		Core::set_stderr_handler( static function ( string $text ) use ( &$sunk ): void {
			$sunk[] = $text;
		} );
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( 'feed7746-ci' );
		$log = (string) \tempnam( \sys_get_temp_dir(), 'nodes-refusal-' );
		$old = \ini_set( 'error_log', $log );
		try {
			$this->assertFalse( ( Command_Auth::verifier() )( $interpreter, $command() ) );
		} finally {
			\ini_set( 'error_log', false === $old ? '' : $old );
			$interpreter->remove_node();
		}
		$logged = (string) \file_get_contents( $log );
		\unlink( $log );

		$this->assertStringContainsString( "feed7746-ci: WARNING: verification failed: {$reason}", $logged );
		$this->assertSame( [], $sunk, 'the stderr sink' );
		$this->assertSame( [], \preg_grep( '/verification failed/', Core::$recent_log ), 'the dmesg ring' );
	}

	public function test_sign_refuses_unencodable_arguments(): void {
		// Invalid UTF-8 makes wp_json_encode return false; signing must fail closed
		// (no auth) rather than collapse onto an HMAC('') collision.
		$m = $this->command( 'make_node', [ "\xB1\x31" ] );
		$m[ Message::TIMESTAMP ] = 1000;
		Command_Auth::sign( $m );
		$this->assertArrayNotHasKey( 'auth', $m[ Message::VALUE ] );
		$this->assertFalse( Command_Auth::verify( $m, 1000, 1000 ) );
	}
	/**
	 * wp_salt() distrusts the raw constant: it substitutes a DB-generated value
	 * when NONCE_SALT is undefined or still the shipped placeholder. Reading the
	 * constant would bypass that, so on an install whose salts were never
	 * generated the signing key — and the spawn token keyed the same way — would
	 * be globally computable. Vault uses the same idiom.
	 */
	public function test_the_signing_key_comes_from_wp_salt_not_the_raw_constant(): void {
		$secret = new \ReflectionMethod( Command_Auth::class, 'secret' );

		$this->assertSame(
			\hash_hmac( 'sha256', 'nodes-command-v1', \wp_salt( 'nonce' ) ),
			$secret->invoke( null )
		);
	}

}
