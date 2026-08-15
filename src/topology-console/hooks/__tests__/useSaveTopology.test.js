/**
 * useSaveTopology — `topologies save` as a one-shot on the batched tick.
 *
 * What this pins is the whole point of the conversion: the write rides the
 * router tick rather than minting its own POST from a button callback, it goes
 * exactly ONCE, and the reply is addressed back to the node that sent it — no
 * ID, no KEY, nothing to correlate.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { Core, ID, KEY, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { useSaveTopology } from '../useSaveTopology';

// Distinct from every default so a wrong-field read fails rather than coincides.
const SAVED = { name: 'demo', path: '/user/demo.tsl', shadows_stock: false };
const REASON = 'unknown node type "Bogus" at line 3';

let replyFor;

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	replyFor = jest.fn( () => SAVED );
	installFakeCommandWire( ( m ) => replyFor( m ) );
} );

it( 'sends save on the tick, once, with no ID and no KEY', async () => {
	const onDone = jest.fn();
	const { result } = renderHook( () => useSaveTopology( onDone ) );

	act( () => {
		result.current.save( { name: 'demo', tsl: 'make_node Echo e' } );
	} );

	await waitFor( () => expect( onDone ).toHaveBeenCalledTimes( 1 ), {
		timeout: 4000,
	} );
	expect( replyFor ).toHaveBeenCalledTimes( 1 );
	const sent = replyFor.mock.calls[ 0 ][ 0 ];
	expect( sent[ VALUE ].name ).toBe( 'save' );
	expect( sent[ VALUE ].arguments ).toEqual( [ 'demo', 'make_node Echo e' ] );
	expect( sent[ ID ] ).toBe( '' );
	expect( sent[ KEY ] ).toBe( '' );
	expect( onDone.mock.calls[ 0 ][ 0 ].result ).toEqual( SAVED );
} );

it( 'hands a verb refusal to onDone rather than a result', async () => {
	replyFor.mockImplementation( () => new Error( REASON ) );
	const onDone = jest.fn();
	const { result } = renderHook( () => useSaveTopology( onDone ) );

	act( () => {
		result.current.save( { name: 'bad', tsl: '' } );
	} );

	await waitFor( () => expect( onDone ).toHaveBeenCalledTimes( 1 ), {
		timeout: 4000,
	} );
	expect( onDone.mock.calls[ 0 ][ 0 ].error ).toContain( REASON );
	expect( onDone.mock.calls[ 0 ][ 0 ].result ).toBeNull();
} );

it( 'returns a stable save callback across renders', () => {
	const { result, rerender } = renderHook( () => useSaveTopology() );
	const first = result.current.save;
	rerender();
	expect( result.current.save ).toBe( first );
} );
