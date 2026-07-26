import {
	signCommand,
	ensureSession,
	forgetSession,
	__setAuthFetch,
} from '../command-auth';
import {
	newMessage,
	TYPE,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	TM_NOREPLY,
	TM_BYTESTREAM,
} from '../message';

const HANDLE = 'aaaa1111bbbb2222cccc3333dddd4444';
const KEY = 'browser-session-key-4242';

function aCommand( type = TM_COMMAND ) {
	const m = newMessage();
	m[ TYPE ] = type;
	m[ VALUE ] = { name: 'help', arguments: [] };
	return m;
}

describe( 'browser command signing', () => {
	let calls;

	beforeEach( () => {
		calls = 0;
		forgetSession();
		__setAuthFetch( async () => {
			calls++;
			return { handle: HANDLE, key: KEY, expires_in: 3600 };
		} );
	} );

	afterEach( () => {
		forgetSession();
		__setAuthFetch( null );
	} );

	it( 'stamps a handle, nonce and signature onto a command', async () => {
		const m = aCommand();

		await ensureSession();
		signCommand( m );

		expect( m[ VALUE ].auth.handle ).toBe( HANDLE );
		expect( m[ VALUE ].auth.nonce ).toMatch( /^[0-9a-f]{32}$/ );
		expect( m[ VALUE ].auth.sig ).toMatch( /^[0-9a-f]{64}$/ );
	} );

	it( 'leaves the command semantics untouched', async () => {
		const m = aCommand();

		await ensureSession();
		signCommand( m );

		expect( m[ VALUE ].name ).toBe( 'help' );
		expect( m[ VALUE ].arguments ).toEqual( [] );
	} );

	/** TM_NOREPLY rides along; the HMAC covers TYPE so it must still sign. */
	it( 'signs a no-reply command', async () => {
		const m = aCommand( TM_COMMAND | TM_NOREPLY );

		await ensureSession();
		signCommand( m );

		expect( m[ VALUE ].auth ).toBeDefined();
	} );

	it.each( [
		[ 'a response', TM_COMMAND | TM_RESPONSE ],
		[ 'an error', TM_COMMAND | TM_ERROR ],
		[ 'a bytestream', TM_BYTESTREAM ],
	] )( 'does not sign %s', async ( _label, type ) => {
		const m = aCommand( type );

		await ensureSession();
		signCommand( m );

		expect( m[ VALUE ].auth ).toBeUndefined();
	} );

	/** One /auth round trip, not one per command — and not one per concurrent caller. */
	it( 'establishes the session once and reuses it', async () => {
		await Promise.all( [ ensureSession(), ensureSession() ] );
		await ensureSession();

		expect( calls ).toBe( 1 );
	} );

	/**
	 * No session, no signature — and no warning. Unsigned is a STATE here: the
	 * console mints local commands before /auth resolves and those never leave
	 * the browser. One that does cross is refused server-side, where the failure
	 * is logged. An unsigned command beats one that looks authorized.
	 */
	it( 'leaves the command unsigned when the session cannot be had', async () => {
		__setAuthFetch( async () => {
			throw new Error( 'HTTP 403' );
		} );
		const m = aCommand();

		await ensureSession().catch( () => {} );
		signCommand( m );

		expect( m[ VALUE ].auth ).toBeUndefined();
	} );

	it( 're-establishes the session after it is forgotten', async () => {
		await ensureSession();
		forgetSession();
		await ensureSession();

		expect( calls ).toBe( 2 );
	} );
} );
