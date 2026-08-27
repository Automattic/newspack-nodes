/* eslint-env jest */
// Jest setup — adds @testing-library/jest-dom matchers (toBeInTheDocument, …)
// and FAILS any test that emits an unexpected console.warn or console.error
// (mirrors the sibling newspack-nodes setup).
import '@testing-library/jest-dom';

// The substrate's `Core.stderr()` / `printLessOften()` (../../src/runtime/core.js)
// route node faults, rate-limited logs, and dropped-message notices through
// console.warn (never console.error, to skip devtools' error counter), each line
// stamped `YYYY-MM-DD HH:MM:SS <ZONE> <argv0>: `. Those are expected spam on any test
// exercising a fault path, so warn lines matching that signature are dropped. EVERY
// other console.warn and EVERY console.error (React `act(...)` warnings, third-party
// deprecations, genuine errors) is recorded and re-thrown in afterEach, failing the
// test. Throwing in afterEach — not inside the mock — keeps React's render/commit
// from swallowing the throw or cascading into confusing secondary failures, and the
// captured Error preserves the call site.
//
// Tests that legitimately assert on console.warn/error install their own
// `jest.spyOn( console, … )`; that shadows the recorder for that test and the
// afterEach restore unwinds both.

// The Core.stderr() line prefix: ISO-ish date + the local zone + " <argv0>: ".
const SUBSTRATE_STDERR =
	/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d (?:UTC|GMT[+-][\d:]+|[A-Z]{2,5}) \S+: /;

let violations = [];

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
 * jsdom ships neither TextEncoder nor WebCrypto's subtle, both of which the
 * command signer needs. Node has real implementations — use those rather than a
 * stub, so the suite exercises the same primitives the browser will.
 */
const { TextEncoder, TextDecoder } = require( 'util' );
const { webcrypto } = require( 'crypto' );
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;
if ( ! global.crypto?.subtle ) {
	// jsdom exposes crypto as a read-only accessor, so plain assignment no-ops.
	Object.defineProperty( global, 'crypto', {
		value: webcrypto,
		configurable: true,
		writable: true,
	} );
}

// Every emitter holds until authenticated, which is what production does — so
// the harness authenticates too, or every poll test asserts silence.
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
