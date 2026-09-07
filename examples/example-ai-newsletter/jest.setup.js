/* eslint-env jest */
import '@testing-library/jest-dom';

// @longform
// FAIL any test that emits a console.warn or console.error, with one
// exemption. `Core.stderr()` and `printLessOften()`, in
// ../../src/runtime/core.js, route node faults, rate-limited logs and
// dropped-message notices through console.warn — the only console call that
// file makes — stamping each line `YYYY-MM-DD HH:MM:SS <zone> <argv0>: `. A
// warn carrying that prefix is discarded unread, so the substrate's own spam
// never fails a test exercising a fault path. Every other console.warn and
// EVERY console.error (React `act(...)` warnings, third-party deprecations,
// genuine errors) is recorded, and afterEach throws the first. Throwing there
// rather than inside the mock keeps React's render and commit from swallowing
// the throw or cascading into confusing secondary failures, and the captured
// Error preserves the call site.
//
// A test asserting on console output installs its own `jest.spyOn( console,
// … )`. jest.spyOn hands back the mock already in place rather than layering
// a second one, so the test's implementation replaces the recorder's, and
// afterEach's one restore per channel returns the real console.

/**
 * The `Core.stderr()` line prefix. The zone token is held to the shapes
 * `Intl.DateTimeFormat` emits under `timeZoneName: 'short'` — a bare `\S+`
 * there would match any `<date> <time> <word> <word>: ` warning and discard
 * it, which is the gate swallowing the lines it exists to report.
 */
const SUBSTRATE_STDERR =
	/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d (?:UTC|GMT[+-][\d:]+|[A-Z]{2,5}) \S+: /;

let violations = [];

/**
 * Build the mock implementation for one console channel.
 *
 * @param {string} channel 'warn' or 'error'; also names the violation.
 * @return {Function} What to install on `console[ channel ]`.
 */
const record =
	( channel ) =>
	( ...args ) => {
		if (
			'warn' === channel &&
			'string' === typeof args[ 0 ] &&
			SUBSTRATE_STDERR.test( args[ 0 ] )
		) {
			return;
		}
		violations.push(
			new Error(
				`Unexpected console.${ channel }: ${ args
					.map( String )
					.join( ' ' ) }`
			)
		);
	};

beforeEach( () => {
	violations = [];
	jest.spyOn( console, 'warn' ).mockImplementation( record( 'warn' ) );
	jest.spyOn( console, 'error' ).mockImplementation( record( 'error' ) );
} );

afterEach( () => {
	const captured = violations;
	violations = [];
	if ( jest.isMockFunction( console.warn ) ) {
		console.warn.mockRestore();
	}
	if ( jest.isMockFunction( console.error ) ) {
		console.error.mockRestore();
	}
	if ( captured.length ) {
		throw captured[ 0 ];
	}
} );

/**
 * jsdom supplies neither TextEncoder nor TextDecoder, and its `crypto` carries
 * `getRandomValues` but no `subtle`. The command signer reaches TextEncoder
 * through the `utf8ToBytes` in @noble/hashes and mints its nonce from
 * `getRandomValues`, so a missing `subtle` is the tell that `crypto` is
 * jsdom's and the whole object gives way to Node's webcrypto. These are
 * Node's own implementations rather than stubs, so the suite exercises the
 * primitives the browser will run.
 */
const { TextEncoder, TextDecoder } = require( 'util' );
const { webcrypto } = require( 'crypto' );
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;
if ( ! global.crypto?.subtle ) {
	// jsdom's crypto is a getter with no setter; assignment cannot replace it.
	Object.defineProperty( global, 'crypto', {
		value: webcrypto,
		configurable: true,
		writable: true,
	} );
}

// @longform
// Every emitter holds until authenticated, which is what production does —
// `Node.command()` returns null and `FetcherNode.fill()` returns early when
// `readyToMint()` is false — so the harness authenticates too, or every poll
// test asserts silence. `__setAuthFetch` stands in for the POST /auth round
// trip.
const auth = require( '../../src/runtime/command-auth' );
beforeEach( async () => {
	auth.forgetSession();
	auth.__setAuthFetch( async () => ( {
		handle: 'e2e11111e2e22222e2e33333e2e44444',
		key: 'jest-harness-session-key',
		expires_in: 3600,
		now: Math.floor( Date.now() / 1000 ),
	} ) );
	await auth.ensureSession();
} );
