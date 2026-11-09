/**
 * useTopologyManager's three fleet commands are writes: each declares that a
 * send still queued when the Overview unmounts, or the page is left, goes.
 */

import { renderHook, act } from '@testing-library/react';
import { Core } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { useTopologyManager } from '../useTopologyManager';

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	installFakeCommandWire( () => undefined );
} );

it( 'declares restart, activate and deactivate sent on removal', async () => {
	renderHook( () => useTopologyManager( { refreshMs: 60000 } ) );
	await act( async () => {} );
	expect(
		[
			'workers:restart',
			'topologies:activate',
			'topologies:deactivate',
		].map( ( scope ) => Core.node( `${ scope }:fetch` ).sends_on_removal )
	).toEqual( [ true, true, true ] );
} );
