/* eslint-env jest */
// Jest setup — suppress ONLY the runtime's own stderr noise during tests.
//
// `Core.stderr()` / `printLessOften()` / `printLeastOften()` (src/runtime/core.js)
// route node faults, rate-limited logs, and dropped-message notices to
// console.warn (not console.error, to skip devtools' error counter), each line
// stamped `YYYY-MM-DD HH:MM:SS UTC <argv0>: …`. Those are expected output spam on
// any test that exercises a fault path. Suppress ONLY lines matching that
// signature — every other console.warn (third-party deprecations, anything
// unexpected) passes through so real problems still surface. console.error is
// left fully intact, so React `act(...)` warnings and genuine errors surface.
//
// Tests that assert on console.warn create their own `jest.spyOn` — that layers
// on top of this and keeps working; the afterEach restore unwinds both.

const realWarn = console.warn.bind( console );
// The Core.stderr() line prefix: ISO-ish date + " UTC <argv0>: ".
const SUBSTRATE_STDERR = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC \S+: /;

beforeEach( () => {
	jest.spyOn( console, 'warn' ).mockImplementation( ( ...args ) => {
		if (
			'string' === typeof args[ 0 ] &&
			SUBSTRATE_STDERR.test( args[ 0 ] )
		) {
			return;
		}
		realWarn( ...args );
	} );
} );

afterEach( () => {
	if ( jest.isMockFunction( console.warn ) ) {
		console.warn.mockRestore();
	}
} );
