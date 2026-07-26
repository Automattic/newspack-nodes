/**
 * Cross-language golden pin for command signing, browser side.
 *
 * The vectors in tests/fixtures/signatures.json are generated from PHP
 * Command_Auth (see tests/unit/SignatureParityTest.php). This suite asserts the
 * browser's WebCrypto signer derives the same signature from the same inputs.
 *
 * TYPE is carried in the vectors but deliberately NOT signed — it is envelope,
 * like TO and FROM — so a caller may OR flags in after the mint.
 *
 * A canonicalization difference between the two languages produces a signature
 * that never verifies. The server does log it — `verification failed: signature
 * mismatch` — but neither language's own suite can catch it, because each is
 * internally consistent and both stay green. Only a shared fixture can.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { canonical, hmacHex } from '../command-auth';

const fixture = JSON.parse(
	readFileSync(
		join( __dirname, '../../../tests/fixtures/signatures.json' ),
		'utf8'
	)
);

describe( 'command signing parity with PHP', () => {
	it( 'derives the committed signature for every vector', async () => {
		expect( fixture.vectors.length ).toBeGreaterThan( 0 );

		for ( const [ index, vector ] of fixture.vectors.entries() ) {
			const string = canonical(
				vector.ts,
				vector.name,
				vector.arguments,
				vector.nonce
			);
			const signature = await hmacHex( string, vector.key );

			expect( signature ).toBe( fixture.signatures[ String( index ) ] );
		}
	} );

	/**
	 * The escaping bug this fixture exists to prevent: PHP's json_encode escapes
	 * `/` and non-ASCII by default, JSON.stringify escapes neither. Pin the
	 * canonical string itself so a future "tidy-up" on either side is caught.
	 */
	it( 'leaves slashes and non-ASCII unescaped in the canonical string', () => {
		const string = canonical(
			1771000000,
			'make_node',
			[ 'Log', 'x', '/tmp/newspack-nodes/logs/café.log' ],
			'a1b2c3d4e5f60718293a4b5c6d7e8f90'
		);

		expect( string ).toContain( '/tmp/newspack-nodes/logs/café.log' );
		expect( string ).not.toContain( '\\/' );
		expect( string ).not.toContain( '\\u' );
	} );
} );
