/**
 * useLayout — canvas positions over `layouts get` / `layouts save`, both on the
 * batched router tick.
 *
 * The get and the save own separate nodes: they can be outstanding at the same
 * time, and a node carries one command. That separation is what keeps each
 * reply unambiguous with nothing to correlate.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { Core, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { useLayout } from '../useLayout';

// Distinct from every default so a wrong-field read fails rather than coincides.
const POSITIONS = { greeter: [ 41, 97 ] };
const FETCHED = { name: 'demo', positions: POSITIONS };

let replyFor;

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	replyFor = jest.fn( () => FETCHED );
	installFakeCommandWire( ( m ) => replyFor( m ) );
} );

it( 'asks for a topology layout and hands the answer to onFetched', async () => {
	const onFetched = jest.fn();
	const { result } = renderHook( () => useLayout( { onFetched } ) );

	act( () => {
		result.current.fetchLayout( 'demo' );
	} );

	await waitFor( () => expect( onFetched ).toHaveBeenCalledTimes( 1 ), {
		timeout: 4000,
	} );
	expect( replyFor.mock.calls[ 0 ][ 0 ][ VALUE ] ).toMatchObject( {
		name: 'get',
		arguments: [ 'demo' ],
	} );
	expect( onFetched.mock.calls[ 0 ][ 0 ] ).toMatchObject( {
		result: FETCHED,
		args: [ 'demo' ],
	} );
} );

// A topology with no saved layout is refused, and that IS the answer: the
// canvas auto-fits. Retrying it would ask forever for something never there.
it( 'reports a refused layout once, naming what it asked for', async () => {
	replyFor.mockImplementation( () => new Error( 'no layout for demo' ) );
	const onFetched = jest.fn();
	const { result } = renderHook( () => useLayout( { onFetched } ) );

	act( () => {
		result.current.fetchLayout( 'demo' );
	} );

	await waitFor( () => expect( onFetched ).toHaveBeenCalledTimes( 1 ), {
		timeout: 4000,
	} );
	expect( onFetched.mock.calls[ 0 ][ 0 ].result ).toBeNull();
	expect( onFetched.mock.calls[ 0 ][ 0 ].args ).toEqual( [ 'demo' ] );

	await new Promise( ( r ) => setTimeout( r, 2200 ) );
	expect( onFetched ).toHaveBeenCalledTimes( 1 );
}, 15000 );

it( 'sends the positions as one JSON token and reports the save', async () => {
	const onSaved = jest.fn();
	const { result } = renderHook( () => useLayout( { onSaved } ) );

	act( () => {
		result.current.saveLayout( { name: 'demo', positions: POSITIONS } );
	} );

	await waitFor( () => expect( onSaved ).toHaveBeenCalledTimes( 1 ), {
		timeout: 4000,
	} );
	expect( replyFor.mock.calls[ 0 ][ 0 ][ VALUE ] ).toMatchObject( {
		name: 'save',
		arguments: [ 'demo', JSON.stringify( POSITIONS ) ],
	} );
} );

// A get and a save in flight together is the case an op-id would have been
// invented for; separate nodes make it a non-question.
it( 'keeps a get and a save apart while both are outstanding', async () => {
	const onFetched = jest.fn();
	const onSaved = jest.fn();
	replyFor.mockImplementation( ( m ) =>
		'get' === m[ VALUE ].name ? FETCHED : { name: 'demo', positions: {} }
	);
	const { result } = renderHook( () => useLayout( { onFetched, onSaved } ) );

	act( () => {
		result.current.fetchLayout( 'demo' );
		result.current.saveLayout( { name: 'demo', positions: POSITIONS } );
	} );

	await waitFor( () => expect( onSaved ).toHaveBeenCalledTimes( 1 ), {
		timeout: 4000,
	} );
	expect( onFetched.mock.calls[ 0 ][ 0 ].result ).toEqual( FETCHED );
	expect( onSaved.mock.calls[ 0 ][ 0 ].result ).toEqual( {
		name: 'demo',
		positions: {},
	} );
} );
