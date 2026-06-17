/**
 * useHostGraphResync — while the overlay is open, an EXTERNAL host graph change
 * (a host tab switch mounts a fresh exospine, which bumps graphGeneration) must
 * auto-run the same two-step the user used to click by hand: Reset Graph then
 * Reset Layout. The overlay's OWN reset (manual chip or this auto-resync) bumps
 * the generation too, so the hook must recognize its own bump and NOT loop.
 */

import { renderHook, act } from '@testing-library/react';
import { Core } from '../../runtime/core';
import { useHostGraphResync } from '../useHostGraphResync';

beforeEach( () => Core.reset() );

// resetGraph stand-in that bumps the generation, exactly like the real
// useGraphReset.resetGraph (removeNode-all + Core.bumpGraphGeneration + markDirty).
function bumpingResetGraph() {
	Core.bumpGraphGeneration();
}

describe( 'useHostGraphResync', () => {
	it( 'runs resetGraph then resetLayout when an EXTERNAL generation bump arrives', () => {
		const calls = [];
		const resetGraph = jest.fn( () => {
			calls.push( 'graph' );
			bumpingResetGraph();
		} );
		const resetLayout = jest.fn( () => calls.push( 'layout' ) );

		renderHook( () => useHostGraphResync( { resetGraph, resetLayout } ) );

		// A host tab switch: a fresh exospine bumps the shared generation.
		act( () => Core.bumpGraphGeneration() );

		expect( resetGraph ).toHaveBeenCalledTimes( 1 );
		expect( resetLayout ).toHaveBeenCalledTimes( 1 );
		// Graph reset before layout reset (matches the manual click order).
		expect( calls ).toEqual( [ 'graph', 'layout' ] );
	} );

	it( 'does NOT re-trigger on its own resetGraph-driven bump (no infinite loop)', () => {
		const resetGraph = jest.fn( () => bumpingResetGraph() );
		const resetLayout = jest.fn();

		renderHook( () => useHostGraphResync( { resetGraph, resetLayout } ) );

		// One external bump → exactly one resync. The resetGraph it runs bumps the
		// generation again, but that bump is self-caused and must be swallowed.
		act( () => Core.bumpGraphGeneration() );

		expect( resetGraph ).toHaveBeenCalledTimes( 1 );
		expect( resetLayout ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'resyncs again on a SECOND external host change', () => {
		const resetGraph = jest.fn( () => bumpingResetGraph() );
		const resetLayout = jest.fn();

		renderHook( () => useHostGraphResync( { resetGraph, resetLayout } ) );

		act( () => Core.bumpGraphGeneration() );
		act( () => Core.bumpGraphGeneration() );

		expect( resetGraph ).toHaveBeenCalledTimes( 2 );
		expect( resetLayout ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'does nothing when no generation change occurs', () => {
		const resetGraph = jest.fn();
		const resetLayout = jest.fn();

		renderHook( () => useHostGraphResync( { resetGraph, resetLayout } ) );

		expect( resetGraph ).not.toHaveBeenCalled();
		expect( resetLayout ).not.toHaveBeenCalled();
	} );

	it( 'unsubscribes on unmount — a later bump does not resync', () => {
		const resetGraph = jest.fn( () => bumpingResetGraph() );
		const resetLayout = jest.fn();

		const { unmount } = renderHook( () =>
			useHostGraphResync( { resetGraph, resetLayout } )
		);

		unmount();
		act( () => Core.bumpGraphGeneration() );

		expect( resetGraph ).not.toHaveBeenCalled();
		expect( resetLayout ).not.toHaveBeenCalled();
	} );

	it( 'the returned guarded resetGraph resets the graph once without an auto-resync loop', () => {
		const resetGraph = jest.fn( () => bumpingResetGraph() );
		const resetLayout = jest.fn();

		const { result } = renderHook( () =>
			useHostGraphResync( { resetGraph, resetLayout } )
		);

		// The manual chip clicks the guarded resetGraph: it bumps the generation,
		// but that bump is self-caused so the subscriber must NOT auto-resync (no
		// extra resetGraph, no resetLayout — the user chose Reset Graph alone).
		act( () => result.current.resetGraph() );

		expect( resetGraph ).toHaveBeenCalledTimes( 1 );
		expect( resetLayout ).not.toHaveBeenCalled();
	} );
} );
