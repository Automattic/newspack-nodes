import apiFetch from '@wordpress/api-fetch';
import {
	signCommand,
	ensureSession,
	hasSession,
	renewSession,
	forgetSession,
	readyToMint,
	authGeneration,
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

	// The generation is what turns every auth-shaped failure into one signal a
	// reconciled loader can depend on, instead of a per-call-site retry.
	it( 'bumps the auth generation when the session is renewed', () => {
		const before = authGeneration();

		renewSession();
		expect( authGeneration() ).toBe( before + 1 );

		renewSession();
		expect( authGeneration() ).toBe( before + 2 );
	} );

	it( 'keeps the generation stable while nothing invalidates', async () => {
		await ensureSession();
		const settled = authGeneration();

		await ensureSession();
		signCommand( aCommand() );

		expect( authGeneration() ).toBe( settled );
	} );

	// /auth was the one request that could not recover from a stale nonce: it
	// 403s, throws, and burns the re-auth backoff — so the session cannot be
	// re-minted at the one moment it must be.
	it( 'renews a stale REST nonce and retries /auth once', async () => {
		__setAuthFetch( null ); // exercise the real postAuth
		const previousEndpoint = apiFetch.nonceEndpoint;
		const previousMiddleware = apiFetch.nonceMiddleware;
		window.NewspackNodesData = {
			restUrl: 'https://example.test/wp-json/',
			nonce: 'STALE-AUTH-NONCE-8823',
		};
		apiFetch.nonceEndpoint =
			'https://example.test/wp-admin/admin-ajax.php?action=rest-nonce';
		apiFetch.nonceMiddleware = { nonce: 'STALE-AUTH-NONCE-8823' };
		global.fetch = jest
			.fn()
			.mockResolvedValueOnce( {
				ok: false,
				status: 403,
				text: () =>
					Promise.resolve(
						JSON.stringify( { code: 'rest_cookie_invalid_nonce' } )
					),
			} )
			.mockResolvedValueOnce( {
				ok: true,
				text: () => Promise.resolve( 'FRESH-AUTH-NONCE-4471' ),
			} )
			.mockResolvedValueOnce( {
				ok: true,
				json: () =>
					Promise.resolve( {
						handle: 'ffff9999ffff9999ffff9999ffff9999',
						key: 'session-after-renewal-5512',
						expires_in: 3600,
					} ),
			} );

		try {
			const issued = await ensureSession();

			// The session must come from the RETRY, not the first response.
			expect( issued?.key ).toBe( 'session-after-renewal-5512' );
			expect( global.fetch ).toHaveBeenCalledTimes( 3 );
			expect( global.fetch.mock.calls[ 2 ][ 1 ].headers ).toEqual(
				expect.objectContaining( {
					'X-WP-Nonce': 'FRESH-AUTH-NONCE-4471',
				} )
			);
		} finally {
			delete global.fetch;
			delete window.NewspackNodesData;
			apiFetch.nonceEndpoint = previousEndpoint;
			apiFetch.nonceMiddleware = previousMiddleware;
		}
	} );

	// The server tells us the lifetime; discarding it meant the only way to
	// learn a session had died was to have a command refused — and that command
	// was lost. 900 is distinct from the 3600 default, so a hard-coded TTL fails.
	it( 'treats a session past its issued lifetime as absent', async () => {
		let clockMs = 1_000_000;
		__setBackoffClock( () => clockMs );
		__setAuthFetch( async () => ( {
			handle: HANDLE,
			key: KEY,
			expires_in: 900,
		} ) );

		await ensureSession();
		expect( hasSession() ).toBe( true );

		clockMs += 899 * 1000;
		expect( hasSession() ).toBe( true );

		clockMs += 2 * 1000; // now past 900s
		expect( hasSession() ).toBe( false );

		__setBackoffClock( null );
	} );

	it( 're-auths once a session has aged out', async () => {
		let clockMs = 5_000_000;
		let issued = 0;
		__setBackoffClock( () => clockMs );
		__setAuthFetch( async () => {
			issued++;
			return { handle: HANDLE, key: `key-${ issued }`, expires_in: 900 };
		} );

		await ensureSession();
		clockMs += 901 * 1000;
		const second = await ensureSession();

		expect( issued ).toBe( 2 );
		expect( second?.key ).toBe( 'key-2' );

		__setBackoffClock( null );
	} );

	// Emitters gate on readyToMint(), so it must see the expiry hasSession()
	// does — otherwise every tick mints a command the server will refuse.
	it( 'refuses to mint on an expired session', async () => {
		let clockMs = 9_000_000;
		__setBackoffClock( () => clockMs );
		__setAuthFetch( async () => ( {
			handle: HANDLE,
			key: KEY,
			expires_in: 900,
		} ) );

		await ensureSession();
		expect( readyToMint() ).toBe( true );

		clockMs += 901 * 1000;
		expect( readyToMint() ).toBe( false );

		__setBackoffClock( null );
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
 * the transport is already async so it simply awaits.
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

		// The server no longer recognizes the handle.
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

/**
 * The real /auth transport. Every other suite swaps it out via __setAuthFetch,
 * so without these the POST itself — the nonce guard, the non-2xx throw, the
 * JSON hand-back — ships unexercised.
 */
describe( 'postAuth transport', () => {
	const DATA = { restUrl: '/wp-json/', nonce: 'NONCE' };

	beforeEach( () => {
		forgetSession();
		__setAuthFetch( null ); // exercise the real POST
		window.NewspackNodesData = { ...DATA };
	} );

	afterEach( () => {
		forgetSession();
		__setAuthFetch( null );
		delete window.NewspackNodesData;
		delete global.fetch;
	} );

	it( 'POSTs to /auth with the WP nonce and keeps the issued session', async () => {
		global.fetch = jest.fn().mockResolvedValue( {
			ok: true,
			json: async () => ( {
				handle: HANDLE,
				key: KEY,
				expires_in: 3600,
				now: 1771000000,
			} ),
		} );

		await ensureSession();

		expect( global.fetch ).toHaveBeenCalledWith(
			'/wp-json/newspack-nodes/v1/auth',
			{ method: 'POST', headers: { 'X-WP-Nonce': 'NONCE' } }
		);
		expect( hasSession() ).toBe( true );
	} );

	/** No nonce, nothing to trade: don't POST into the dark. */
	it( 'does not POST at all without a nonce', async () => {
		window.NewspackNodesData = { restUrl: '/wp-json/', nonce: '' };
		global.fetch = jest.fn();

		await ensureSession();

		expect( global.fetch ).not.toHaveBeenCalled();
		expect( hasSession() ).toBe( false );
	} );

	it( 'treats a non-2xx as a failure and stays sessionless', async () => {
		global.fetch = jest
			.fn()
			.mockResolvedValue( { ok: false, status: 403 } );

		await ensureSession();

		expect( hasSession() ).toBe( false );
	} );
} );

/**
 * A server that ANSWERS but hands back nothing usable is not the same as an
 * unreachable one: the round trip counts as attempted, so an unsigned command
 * is now worth a diagnostic, and the backoff arms so we don't re-ask per tick.
 */
describe( 'an answered but unusable /auth', () => {
	beforeEach( () => {
		forgetSession();
		__setBackoffClock( null );
	} );

	afterEach( () => {
		forgetSession();
		__setAuthFetch( null );
		__setBackoffClock( null );
	} );

	it( 'arms the backoff when the payload carries no handle or key', async () => {
		let attempts = 0;
		__setAuthFetch( async () => {
			attempts++;
			return { expires_in: 3600 }; // answered, but unusable
		} );

		await ensureSession();
		await ensureSession();

		expect( attempts ).toBe( 1 );
		expect( hasSession() ).toBe( false );
	} );

	it( 'reports an unsigned command once a server has answered', async () => {
		expectConsoleWarn( 'ERROR: no command session' );
		__setAuthFetch( async () => ( { expires_in: 3600 } ) );
		await ensureSession();
		const m = aCommand();

		signCommand( m );

		expect( m[ VALUE ].auth ).toBeUndefined();
	} );
} );
