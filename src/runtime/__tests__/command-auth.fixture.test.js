/**
 * Cross-language golden pin for command signing, browser side.
 *
 * The vectors in tests/fixtures/signatures.json are generated from PHP
 * Command_Auth (see tests/unit/SignatureParityTest.php). This suite drives the
 * browser's own mint — signCommand() — with each vector's key, clock and nonce,
 * and asserts it derives the committed signature.
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
import {
	signCommand,
	ensureSession,
	forgetSession,
	__setAuthFetch,
} from '../command-auth';
import { newMessage, TIMESTAMP, TYPE, VALUE } from '../message';

const fixture = JSON.parse(
	readFileSync(
		join( __dirname, '../../../tests/fixtures/signatures.json' ),
		'utf8'
	)
);

const HANDLE = 'aaaa1111bbbb2222cccc3333dddd4444';

/**
 * Mint and sign one vector's command with its clock and nonce pinned, and hand
 * back the `auth` block signCommand() stamped onto the envelope.
 *
 * @param {Object} vector One tests/fixtures/signatures.json vector.
 * @return {Promise<{message: Array, auth: Object}>} The signed message + auth.
 */
async function signVector( vector ) {
	forgetSession();
	__setAuthFetch( async () => ( {
		handle: HANDLE,
		key: vector.key,
		expires_in: 3600,
	} ) );
	await ensureSession();

	const message = newMessage();
	message[ TYPE ] = vector.type;
	message[ VALUE ] = { name: vector.name, arguments: vector.arguments };

	const nonceBytes = Uint8Array.from(
		vector.nonce.match( /../g ).map( ( byte ) => parseInt( byte, 16 ) )
	);
	const clock = jest.spyOn( Date, 'now' ).mockReturnValue( vector.ts * 1000 );
	const random = jest
		.spyOn( crypto, 'getRandomValues' )
		.mockImplementation( ( out ) => {
			out.set( nonceBytes );
			return out;
		} );
	try {
		signCommand( message );
	} finally {
		clock.mockRestore();
		random.mockRestore();
	}
	return { message, auth: message[ VALUE ].auth };
}

afterEach( () => {
	forgetSession();
	__setAuthFetch( null );
} );

describe( 'command signing parity with PHP', () => {
	it( 'derives the committed signature for every vector', async () => {
		expect( fixture.vectors.length ).toBeGreaterThan( 0 );

		for ( const [ index, vector ] of fixture.vectors.entries() ) {
			const { message, auth } = await signVector( vector );

			expect( auth.sig ).toBe( fixture.signatures[ index ] );
			// The signed inputs travel with the envelope, or nothing verifies.
			expect( auth.nonce ).toBe( vector.nonce );
			expect( auth.handle ).toBe( HANDLE );
			expect( message[ TIMESTAMP ] ).toBe( vector.ts );
		}
	} );

	/**
	 * The escaping bug this fixture exists to prevent: PHP's json_encode escapes
	 * `/` and non-ASCII by default, JSON.stringify escapes neither. A "tidy-up"
	 * on either side changes the canonical string, and this vector's committed
	 * signature stops matching.
	 */
	it( 'leaves slashes and non-ASCII unescaped in the signed canonical string', async () => {
		const index = fixture.vectors.findIndex( ( vector ) =>
			vector.arguments.some( ( arg ) =>
				arg.includes( '/tmp/newspack-nodes/logs/café.log' )
			)
		);
		expect( index ).toBeGreaterThanOrEqual( 0 );

		const { auth } = await signVector( fixture.vectors[ index ] );
		expect( auth.sig ).toBe( fixture.signatures[ index ] );
	} );
} );
