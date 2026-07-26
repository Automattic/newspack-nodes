<?php
/**
 * Cross-language golden pin for command signing. The committed vectors under
 * tests/fixtures/signatures.json are generated ONCE from PHP Command_Auth; this
 * test asserts PHP still reproduces them, and the jest suite
 * (src/runtime/__tests__/command-auth.fixture.test.js) asserts the browser's
 * WebCrypto signer reproduces the same signatures.
 *
 * Without this pin, a canonicalization difference produces a signature that
 * never verifies. The verifier does say so — `drop_message()` logs
 * `verification failed: signature mismatch` — but no SINGLE-language test can
 * catch it, because each language is internally consistent: PHP signs and
 * verifies with PHP, the browser with itself. Only a shared fixture crosses the
 * boundary. The slash/unicode escaping bug this file exists to prevent was
 * real — PHP's wp_json_encode() defaults escape both, JSON.stringify escapes
 * neither. The vectors deliberately include a path, non-ASCII, a quote, a
 * backslash and an empty argument list.
 *
 * Regenerate after an intentional change to the canonical string:
 *   NEWSPACK_NODES_REGEN_SIGNATURES=1 phpunit --filter SignatureParity
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Command_Auth::class )]
class SignatureParityTest extends TestCase {

	private const FIXTURE = __DIR__ . '/../fixtures/signatures.json';

	/**
	 * Inputs chosen to break a naive port: a filesystem path (slash escaping),
	 * non-ASCII (unicode escaping), embedded quote + backslash, and the empty
	 * argument list. The key is fixed so the vectors are reproducible.
	 *
	 * @return array<int,array{key:string,type:int,ts:int,name:string,arguments:list<string>,nonce:string}>
	 */
	private function vectors(): array {
		return [
			[
				'key'       => 'session-key-4242-4242-4242-4242',
				'type'      => Message::TM_COMMAND,
				'ts'        => 1771000000,
				'name'      => 'make_node',
				'arguments' => [ 'Log', 'x', '/tmp/newspack-nodes/logs/café.log' ],
				'nonce'     => 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
			],
			[
				'key'       => 'session-key-9999-9999-9999-9999',
				'type'      => Message::TM_COMMAND | Message::TM_NOREPLY,
				'ts'        => 1771000001,
				'name'      => 'connect_node',
				'arguments' => [],
				'nonce'     => 'ffffffffffffffffffffffffffffffff',
			],
			[
				'key'       => 'session-key-7777-7777-7777-7777',
				'type'      => Message::TM_COMMAND,
				'ts'        => 1771000002,
				'name'      => 'cmd',
				'arguments' => [ 'topologies', 'save', "a\\b \"quoted\" ünïcode / slash" ],
				'nonce'     => '0123456789abcdef0123456789abcdef',
			],
		];
	}

	/**
	 * Recompute a vector's signature through the SAME canonical shape production
	 * uses. Kept in the test rather than reaching into a private method so the
	 * fixture pins the wire contract, not an implementation detail.
	 *
	 * @param array{key:string,type:int,ts:int,name:string,arguments:list<string>,nonce:string} $v
	 */
	private function sign_vector( array $v ): string {
		$canonical = \wp_json_encode(
			[ $v['type'], $v['ts'], $v['name'], $v['arguments'], $v['nonce'] ],
			\JSON_UNESCAPED_SLASHES | \JSON_UNESCAPED_UNICODE
		);
		return \hash_hmac( 'sha256', (string) $canonical, $v['key'] );
	}

	public function test_php_reproduces_the_committed_signature_vectors(): void {
		$expected = [];
		foreach ( $this->vectors() as $i => $vector ) {
			$expected[ (string) $i ] = $this->sign_vector( $vector );
		}

		if ( '' !== (string) \getenv( 'NEWSPACK_NODES_REGEN_SIGNATURES' ) ) {
			\file_put_contents(
				self::FIXTURE,
				(string) \wp_json_encode(
					[ 'vectors' => $this->vectors(), 'signatures' => $expected ],
					\JSON_PRETTY_PRINT | \JSON_UNESCAPED_SLASHES | \JSON_UNESCAPED_UNICODE
				) . "\n"
			);
			$this->markTestIncomplete( 'regenerated tests/fixtures/signatures.json' );
		}

		$this->assertFileExists( self::FIXTURE, 'regenerate with NEWSPACK_NODES_REGEN_SIGNATURES=1' );
		$committed = \json_decode( (string) \file_get_contents( self::FIXTURE ), true );

		$this->assertSame( $this->vectors(), $committed['vectors'], 'the vectors themselves drifted' );
		$this->assertSame( $expected, $committed['signatures'] );
	}

	/**
	 * The production signer must agree with the fixture shape. A drift here means
	 * canonical() changed without the vectors being regenerated — every browser
	 * command would then be refused, logged as a signature mismatch, while both
	 * suites stayed green.
	 */
	public function test_the_production_signer_matches_the_fixture_shape(): void {
		$vector = $this->vectors()[0];
		Command_Auth::remember_session( 'parity-spoke', 'handle-for-parity', $vector['key'] );

		$m                       = Message::new_message();
		$m[ Message::TYPE ]      = $vector['type'];
		$m[ Message::TIMESTAMP ] = $vector['ts'];
		$m[ Message::VALUE ]     = [ 'name' => $vector['name'], 'arguments' => $vector['arguments'] ];
		Command_Auth::sign_for( 'parity-spoke', $m );

		$auth = $m[ Message::VALUE ]['auth'];
		// Same inputs but production's own random nonce, so recompute with it.
		$with_nonce          = $vector;
		$with_nonce['nonce'] = $auth['nonce'];

		$this->assertSame( $this->sign_vector( $with_nonce ), $auth['sig'] );

		Command_Auth::forget_session( 'parity-spoke' );
	}
}
