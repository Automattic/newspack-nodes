/**
 * useSaveTopology — mints `topologies.save` FROM its own Request node.
 *
 * What this pins is the whole point of the conversion: the command carries no
 * ID and no KEY, because the reply is addressed back to the minting node.
 */

import { renderHook, act } from '@testing-library/react';
import { Core } from '@newspack-nodes/runtime';
import { useSaveTopology } from '../useSaveTopology';
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
const SAVED = { name: 'demo', path: '/user/demo.tsl', shadows_stock: false };
const REASON = 'unknown node type "Bogus" at line 3';

const capture = () => {
	const node = Core.node( 'topologies:save' );
	const sent = [];
	node.sink = { fill: ( m ) => sent.push( m ) };
	return { node, sent };
};

const reply = ( payload ) => {
	const m = newMessage();
	m[ VALUE ] = { name: 'save', payload };
	return m;
};

const errorReply = ( text ) => {
	const m = reply( text );
	m[ TYPE ] = TM_COMMAND | TM_ERROR;
	return m;
};

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
} );

it( 'returns a stable callback across renders', () => {
	const { result, rerender } = renderHook( () => useSaveTopology() );
	const first = result.current;
	rerender();
	expect( result.current ).toBe( first );
} );

it( 'mints save FROM its own node, with no ID and no KEY', () => {
	const { result } = renderHook( () => useSaveTopology() );
	const { sent } = capture();

	act( () => {
		// Never replied to; the teardown rejection is expected, not a failure.
		result
			.current( { name: 'demo', tsl: 'make_node Echo e' } )
			.catch( () => {} );
	} );

	expect( sent ).toHaveLength( 1 );
	expect( sent[ 0 ][ FROM ] ).toBe( 'topologies:save' );
	expect( sent[ 0 ][ TO ] ).toBe( '_http/topologies' );
	expect( sent[ 0 ][ VALUE ].name ).toBe( 'save' );
	expect( sent[ 0 ][ VALUE ].arguments ).toEqual( [
		'demo',
		'make_node Echo e',
	] );
	expect( sent[ 0 ][ ID ] ).toBe( '' );
	expect( sent[ 0 ][ KEY ] ).toBe( '' );
} );

it( 'resolves with the reply payload', async () => {
	const { result } = renderHook( () => useSaveTopology() );
	const { node } = capture();

	let pending;
	act( () => {
		pending = result.current( { name: 'demo', tsl: 'x' } );
		node.fill( reply( SAVED ) );
	} );

	await expect( pending ).resolves.toEqual( SAVED );
} );

it( 'rejects a verb error with its message', async () => {
	const { result } = renderHook( () => useSaveTopology() );
	const { node } = capture();

	let pending;
	act( () => {
		pending = result.current( { name: 'bad', tsl: '' } );
		node.fill( errorReply( REASON ) );
	} );

	await expect( pending ).rejects.toThrow( REASON );
} );
