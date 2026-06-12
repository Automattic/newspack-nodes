/* eslint-env jest */
// Jest setup — silence the runtime's stderr noise during tests.
//
// `Core.stderr()` (src/runtime/core.js) deliberately routes to `console.warn`
// (not `console.error`, to skip devtools' error counter) for the browser REPL;
// in jsdom that's just output spam on every test that exercises a node fault,
// rate-limited log, or dropped message. Suppress `console.warn` output per test
// (restored after each so spies don't stack). `console.error` is left intact, so
// React `act(...)` warnings and genuine test errors still surface.
//
// Tests that assert on `console.warn` create their own `jest.spyOn` — that layers
// on top of this and keeps working; the afterEach restore unwinds both.

beforeEach( () => {
	jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
} );

afterEach( () => {
	if ( jest.isMockFunction( console.warn ) ) {
		console.warn.mockRestore();
	}
} );
