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

/* eslint-env jest */
// @longform
// Jest setup — FAIL any test that emits an UNEXPECTED console.warn/error, and
// fail any test that DECLARED an expected console message that never fired.
//
// `Core.stderr()` / `printLessOften()` (src/runtime/core.js) route node faults,
// rate-limited logs, and dropped-message notices through console.warn (never
// console.error, to skip devtools' error counter), each line stamped
// `YYYY-MM-DD HH:MM:SS UTC <argv0>: `. A test that legitimately exercises a
// fault path must DECLARE the message it expects:
//
//     expectConsoleWarn( 'Router: dropped message not addressed' );
//
// The declared text is matched against the warn line with the substrate
// `stderr` prefix stripped (so tests assert the message, not the timestamp).
// Anything not declared — every other console.warn, EVERY console.error
// (React `act(...)` warnings, third-party deprecations, genuine errors) — is
// recorded and re-thrown in afterEach, failing the test. Throwing in afterEach
// (not inside the mock) keeps React's render/commit from swallowing the throw,
// and the captured Error preserves the call site.
//
// Tests that prefer to assert via their own `jest.spyOn( console|Core, … )`
// still can; that shadows the recorder and the afterEach restore unwinds both.

// The Core.stderr() line prefix: ISO-ish date + " UTC <argv0>: ".
const SUBSTRATE_STDERR = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC \S+: /;

let violations = [];
let expectedWarns = [];

// @longform
// Declare a console.warn a test legitimately produces. The actual warn
// line, with the substrate `stderr` timestamp prefix stripped, must START
// WITH the declared text — so a test asserts the stable, meaningful part of
// the message and ignores only the trailing dynamic data (the FROM
// breadcrumb, a payload, an offending path). Suppresses exactly the declared
// warnings and fails afterEach if a declared message never fires.
global.expectConsoleWarn = ( message ) => {
	expectedWarns.push( { message: String( message ).trim(), matched: false } );
};

const bareLine = ( arg ) =>
	'string' === typeof arg ? arg.replace( SUBSTRATE_STDERR, '' ).trim() : '';

const record =
	( channel ) =>
	( ...args ) => {
		if ( 'warn' === channel ) {
			const bare = bareLine( args[ 0 ] );
			const exp = expectedWarns.find(
				( e ) => ! e.matched && bare.startsWith( e.message )
			);
			if ( exp ) {
				exp.matched = true;
				return;
			}
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
	expectedWarns = [];
	jest.spyOn( console, 'warn' ).mockImplementation( record( 'warn' ) );
	jest.spyOn( console, 'error' ).mockImplementation( record( 'error' ) );
} );

afterEach( () => {
	const captured = violations;
	const unmet = expectedWarns.filter( ( e ) => ! e.matched );
	violations = [];
	expectedWarns = [];
	if ( jest.isMockFunction( console.warn ) ) {
		console.warn.mockRestore();
	}
	if ( jest.isMockFunction( console.error ) ) {
		console.error.mockRestore();
	}
	if ( captured.length ) {
		throw captured[ 0 ];
	}
	if ( unmet.length ) {
		throw new Error(
			`Declared console.warn never emitted: ${ unmet[ 0 ].message }`
		);
	}
} );
