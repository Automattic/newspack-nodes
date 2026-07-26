import {
	signCommand,
	ensureSession,
	hasSession,
	renewSession,
	forgetSession,
	__setAuthFetch,
	__setBackoffClock,
} from '../command-auth';
import {
	newMessage,
	TIMESTAMP,
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
			return {
				handle: HANDLE,
				key: KEY,
				expires_in: 3600,
				now: 1771000000,
			};
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

		await ensureSession();
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

/**
 * The minter signs TIMESTAMP, so ingress can no longer re-anchor a skewed
 * client's clock — the signature covers it. /auth reports the server's clock
 * instead and the minter aligns to it, which preserves the skew tolerance the
 * old ingress re-stamp provided.
 */
describe( 'clock alignment', () => {
	const SERVER_NOW = 1771000000;

	beforeEach( () => {
		forgetSession();
		__setAuthFetch( async () => ( {
			handle: HANDLE,
			key: KEY,
			expires_in: 3600,
			now: SERVER_NOW,
		} ) );
	} );

	afterEach( () => {
		forgetSession();
		__setAuthFetch( null );
	} );

	it( 'stamps a server-aligned timestamp, not the local clock', async () => {
		await ensureSession();
		const m = aCommand();
		m[ TIMESTAMP ] = 1; // a wildly wrong local clock

		signCommand( m );

		expect( Math.abs( m[ TIMESTAMP ] - SERVER_NOW ) ).toBeLessThan( 5 );
	} );
} );

/**
 * Nothing mints until authenticated, and the page recovers on its own if the
 * server forgets the session — evicted from the cache, or restarted.
 *
 * A mint is synchronous, so it cannot wait. The EMITTERS wait instead:
 * `hasSession()` gates the poll ticks (they retry on the next tick anyway), and
 * `CommandClient.send()` is already async so it simply awaits.
 */
describe( 'authentication gates minting, and recovers', () => {
	beforeEach( () => {
		forgetSession();
	} );

	afterEach( () => {
		forgetSession();
		__setAuthFetch( null );
		__setBackoffClock( null );
	} );

	it( 'reports no session before /auth resolves', () => {
		expect( hasSession() ).toBe( false );
	} );

	it( 'reports a session once established', async () => {
		__setAuthFetch( async () => ( {
			handle: HANDLE,
			key: KEY,
			expires_in: 3600,
			now: 1771000000,
		} ) );

		await ensureSession();

		expect( hasSession() ).toBe( true );
	} );

	/** Eviction or a restart: the server forgets, so the client must re-auth. */
	it( 're-authenticates after the server forgets the session', async () => {
		let issued = 0;
		__setAuthFetch( async () => {
			issued++;
			return {
				handle: `${ issued }`.repeat( 32 ).slice( 0, 32 ),
				key: `key-${ issued }`,
				expires_in: 3600,
				now: 1771000000,
			};
		} );
		await ensureSession();
		const first = hasSession();

		// The server no longer recognises the handle.
		renewSession();
		expect( hasSession() ).toBe( false );
		// Renewal arms a cooldown; recovery lands on the first tick past it.
		__setBackoffClock( () => Date.now() + 60_000 );
		await ensureSession();
		__setBackoffClock( null );

		expect( first ).toBe( true );
		expect( issued ).toBe( 2 );
		expect( hasSession() ).toBe( true );
	} );
} );

/**
 * A session the server refuses must not spin. Renewing clears it — so pollers
 * skip and send() waits — and a failed re-auth backs off, so a persistently
 * broken session costs one /auth per window rather than one per tick. Without
 * this the browser hammered the server at ~150 req/s.
 */
describe( 'renewal backs off', () => {
	beforeEach( () => {
		forgetSession();
		__setBackoffClock( null );
	} );

	afterEach( () => {
		forgetSession();
		__setAuthFetch( null );
		__setBackoffClock( null ); // else the next test's "advance" is a no-op
	} );

	it( 'does not re-POST /auth while backing off from a failure', async () => {
		let attempts = 0;
		__setAuthFetch( async () => {
			attempts++;
			throw new Error( 'HTTP 503' );
		} );

		await ensureSession();
		await ensureSession();
		await ensureSession();

		expect( attempts ).toBe( 1 );
		expect( hasSession() ).toBe( false );
	} );

	it( 'retries once the backoff window passes', async () => {
		let attempts = 0;
		__setAuthFetch( async () => {
			attempts++;
			throw new Error( 'HTTP 503' );
		} );

		await ensureSession();
		__setBackoffClock( () => Date.now() + 60_000 );
		await ensureSession();

		expect( attempts ).toBe( 2 );
	} );

	/**
	 * A session the server ISSUES and then still refuses would otherwise loop at
	 * the poll rate: refuse → renew → re-auth → refuse. Renewal arms the cooldown
	 * so the loop widens instead of running flat out.
	 */
	it( 'arms the cooldown when a live session is renewed', async () => {
		let attempts = 0;
		__setAuthFetch( async () => {
			attempts++;
			return {
				handle: HANDLE,
				key: KEY,
				expires_in: 3600,
				now: 1771000000,
			};
		} );
		await ensureSession();

		renewSession();
		await ensureSession();

		expect( attempts ).toBe( 1 );
		expect( hasSession() ).toBe( false );
	} );

	it( 'clears the backoff once a session is obtained', async () => {
		let attempts = 0;
		__setAuthFetch( async () => {
			attempts++;
			if ( 1 === attempts ) {
				throw new Error( 'HTTP 503' );
			}
			return {
				handle: HANDLE,
				key: KEY,
				expires_in: 3600,
				now: 1771000000,
			};
		} );

		await ensureSession();
		__setBackoffClock( () => Date.now() + 60_000 );
		await ensureSession();
		__setBackoffClock( null );

		expect( hasSession() ).toBe( true );
	} );
} );
