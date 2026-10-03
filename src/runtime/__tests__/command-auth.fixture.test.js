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
 * @param {Object}           vector              One tests/fixtures/signatures.json vector.
 * @param {Object}           [opts]
 * @param {number}           [opts.clockSeconds] The local clock while signing; the vector's own by default.
 * @param {?(string|number)} [opts.at]           A TIMESTAMP the message carries forged, if any.
 * @param {?Array}           [message]           A message to sign in place of the vector's own.
 * @return {Promise<{message: Array, auth: Object}>} The signed message + auth.
 */
async function signVector(
	vector,
	{ clockSeconds = vector.ts, at = null } = {},
	message = null
) {
	forgetSession();
	__setAuthFetch( async () => ( {
		handle: HANDLE,
		secret: vector.key,
		expires_in: 3600,
	} ) );
	await ensureSession();

	if ( null === message ) {
		message = newMessage();
		message[ TYPE ] = vector.type;
		message[ VALUE ] = { name: vector.name, arguments: vector.arguments };
	}
	if ( null !== at ) {
		message[ TIMESTAMP ] = at;
	}

	const nonceBytes = Uint8Array.from(
		vector.nonce.match( /../g ).map( ( byte ) => parseInt( byte, 16 ) )
	);
	const clock = jest
		.spyOn( Date, 'now' )
		.mockReturnValue( clockSeconds * 1000 );
	const random = jest
		.spyOn( crypto, 'getRandomValues' )
		.mockImplementation( ( out ) => {
			out.set( nonceBytes );
			return out;
		} );
	try {
		signCommand( message, null !== at );
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
	 * A forger's TIMESTAMP is signed as forged: the committed signature still
	 * derives with the local clock a day away.
	 */
	it( 'signs at the TIMESTAMP a forger hands it, not the local clock', async () => {
		const [ vector ] = fixture.vectors;
		const { message, auth } = await signVector( vector, {
			clockSeconds: vector.ts + 86400,
			at: vector.ts,
		} );

		expect( message[ TIMESTAMP ] ).toBe( vector.ts );
		expect( auth.sig ).toBe( fixture.signatures[ 0 ] );
	} );

	/**
	 * PHP signs and verifies `(int) $ts`, so a fractional TIMESTAMP signs as
	 * its whole seconds and travels untouched.
	 */
	it( 'signs a fractional TIMESTAMP at its whole seconds, as PHP does', async () => {
		const [ vector ] = fixture.vectors;
		const { message, auth } = await signVector( vector, {
			at: vector.ts + 0.75,
		} );

		expect( message[ TIMESTAMP ] ).toBe( vector.ts + 0.75 );
		expect( auth.sig ).toBe( fixture.signatures[ 0 ] );
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

/**
 * PHP's canonical() reads the name through Core::as_string() and the
 * arguments as `is_array ? array_values : []`, each element JSON-encoded as
 * it stands. A VALUE that PHP canonicalizes alike must sign alike here.
 */
describe( 'canonical() mirrors PHP casts', () => {
	const [ vector ] = fixture.vectors;
	const signValue = async ( value ) => {
		const message = newMessage();
		message[ TYPE ] = vector.type;
		message[ VALUE ] = value;
		const { auth } = await signVector( vector, {}, message );
		return auth.sig;
	};

	it( 'signs a true name as PHP\'s "1"', async () => {
		expect( await signValue( { name: true, arguments: [] } ) ).toBe(
			await signValue( { name: '1', arguments: [] } )
		);
	} );

	it( 'signs object arguments as their values', async () => {
		expect(
			await signValue( {
				name: vector.name,
				arguments: { a: 'Log', b: 'x', c: vector.arguments[ 2 ] },
			} )
		).toBe( fixture.signatures[ 0 ] );
	} );
} );
