/**
 * useDeleteTopology — mints `topologies.delete` FROM its own Request node.
 *
 * The reply is addressed back here, so the command carries no ID and no KEY.
 */

import { renderHook, act } from '@testing-library/react';
import { Core } from '@newspack-nodes/runtime';
import { useDeleteTopology } from '../useDeleteTopology';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	ID,
	KEY,
	VALUE,
	TM_COMMAND,
	TM_ERROR,
} from '../../../runtime/message';

// Distinct from every default so a wrong-field read fails rather than coincides.
const DELETED = { name: 'scratch', deleted: true };
const REASON = 'refusing to delete stock topology "combined"';

const capture = () => {
	const node = Core.node( 'topologies:delete' );
	const sent = [];
	node.sink = { fill: ( m ) => sent.push( m ) };
	return { node, sent };
};

const reply = ( payload ) => {
	const m = newMessage();
	m[ VALUE ] = { name: 'delete', payload };
	return m;
};

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
} );

it( 'returns a stable callback across renders', () => {
	const { result, rerender } = renderHook( () => useDeleteTopology() );
	const first = result.current;
	rerender();
	expect( result.current ).toBe( first );
} );

it( 'mints delete FROM its own node, with no ID and no KEY', () => {
	const { result } = renderHook( () => useDeleteTopology() );
	const { sent } = capture();

	act( () => {
		// Never replied to; the teardown rejection is expected, not a failure.
		result.current( { name: 'scratch' } ).catch( () => {} );
	} );

	expect( sent ).toHaveLength( 1 );
	expect( sent[ 0 ][ FROM ] ).toBe( 'topologies:delete' );
	expect( sent[ 0 ][ TO ] ).toBe( '_shell/_http/topologies' );
	expect( sent[ 0 ][ VALUE ].name ).toBe( 'delete' );
	expect( sent[ 0 ][ VALUE ].arguments ).toEqual( [ 'scratch' ] );
	expect( sent[ 0 ][ ID ] ).toBe( '' );
	expect( sent[ 0 ][ KEY ] ).toBe( '' );
} );

it( 'resolves with the reply payload', async () => {
	const { result } = renderHook( () => useDeleteTopology() );
	const { node } = capture();

	let pending;
	act( () => {
		pending = result.current( { name: 'scratch' } );
		node.fill( reply( DELETED ) );
	} );

	await expect( pending ).resolves.toEqual( DELETED );
} );

it( 'rejects a verb error with its message', async () => {
	const { result } = renderHook( () => useDeleteTopology() );
	const { node } = capture();

	let pending;
	act( () => {
		pending = result.current( { name: 'combined' } );
		const m = reply( REASON );
		m[ TYPE ] = TM_COMMAND | TM_ERROR;
		node.fill( m );
	} );

	await expect( pending ).rejects.toThrow( REASON );
} );
