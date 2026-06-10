/**
 * Pins the public consumption path: nodes' own build/jest must resolve the
 * `@newspack-nodes/shared` alias to its canonical src/shared, exactly the way
 * sibling consumers (event-logger-nodes, pyrobase) resolve it. Without this,
 * nodes' own React code dogfoods shared via relative paths while consumers use
 * the alias — and a third party reading nodes as the reference copies imports
 * that won't resolve in their plugin.
 */

import usePageVisibility from '@newspack-nodes/shared/hooks/usePageVisibility';

describe( '@newspack-nodes/shared alias', () => {
	it( 'resolves a shared hook subpath import', () => {
		expect( typeof usePageVisibility ).toBe( 'function' );
	} );
} );
