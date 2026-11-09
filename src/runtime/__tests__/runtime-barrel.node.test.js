/* @jest-environment node */

/**
 * The runtime barrel loads where there is no `window` — a node-environment
 * suite, a build script — so a module that reads the page at load must ask
 * whether there is one first.
 */

test( 'the runtime barrel imports with no window', () => {
	expect( typeof window ).toBe( 'undefined' );
	const runtime = require( '@newspack-nodes/runtime' );
	expect( typeof runtime.sendQueuedWrites ).toBe( 'function' );
	expect( typeof runtime.commandTransport ).toBe( 'function' );
} );
