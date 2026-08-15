/**
 * useDeleteTopology — `topologies delete` as a one-shot on the batched tick.
 *
 * A delete is the case that makes the one-shot contract load-bearing: replayed
 * on the next tick it would race its own "no such topology" refusal.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { Core, ID, KEY, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { useDeleteTopology } from '../useDeleteTopology';

// Distinct from every default so a wrong-field read fails rather than coincides.
const DELETED = { name: 'demo', stock_fallback: true };
const REASON = 'no user copy of demo';

let replyFor;

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	replyFor = jest.fn( () => DELETED );
	installFakeCommandWire( ( m ) => replyFor( m ) );
} );

it( 'sends delete on the tick, once, with no ID and no KEY', async () => {
	const onDone = jest.fn();
	const { result } = renderHook( () => useDeleteTopology( onDone ) );

	act( () => {
		result.current.remove( { name: 'demo' } );
	} );

	await waitFor( () => expect( onDone ).toHaveBeenCalledTimes( 1 ), {
		timeout: 4000,
	} );
	const sent = replyFor.mock.calls[ 0 ][ 0 ];
	expect( sent[ VALUE ].name ).toBe( 'delete' );
	expect( sent[ VALUE ].arguments ).toEqual( [ 'demo' ] );
	expect( sent[ ID ] ).toBe( '' );
	expect( sent[ KEY ] ).toBe( '' );
	expect( onDone.mock.calls[ 0 ][ 0 ] ).toMatchObject( {
		result: DELETED,
		args: [ 'demo' ],
	} );
} );

// The tick after the send must carry nothing: a second delete would answer
// with a refusal the operator never asked for.
it( 'never repeats the delete on a later tick', async () => {
	const { result } = renderHook( () => useDeleteTopology() );
	act( () => {
		result.current.remove( { name: 'demo' } );
	} );
	await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 1 ), {
		timeout: 4000,
	} );

	await new Promise( ( r ) => setTimeout( r, 2200 ) );
	expect( replyFor ).toHaveBeenCalledTimes( 1 );
} );

it( 'hands a verb refusal to onDone rather than a result', async () => {
	replyFor.mockImplementation( () => new Error( REASON ) );
	const onDone = jest.fn();
	const { result } = renderHook( () => useDeleteTopology( onDone ) );

	act( () => {
		result.current.remove( { name: 'demo' } );
	} );

	await waitFor( () => expect( onDone ).toHaveBeenCalledTimes( 1 ), {
		timeout: 4000,
	} );
	expect( onDone.mock.calls[ 0 ][ 0 ].error ).toContain( REASON );
	expect( onDone.mock.calls[ 0 ][ 0 ].result ).toBeNull();
} );
