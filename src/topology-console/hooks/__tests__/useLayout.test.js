/**
 * useLayout — canvas positions over `layouts.get` / `layouts.save`.
 *
 * The pin that matters: get and save are TWO nodes. A node carries one command,
 * so overlapping a fetch and a save on one node would need correlation; two
 * nodes need none. Their replies are told apart by which node they land on.
 */

import { renderHook, act } from '@testing-library/react';
import { Core } from '@newspack-nodes/runtime';
import { useLayout } from '../useLayout';
import { newMessage, FROM, TO, ID, KEY, VALUE } from '../../../runtime/message';

// Distinct from every default so a wrong-field read fails rather than coincides.
const POSITIONS = { 'firehose-in': { x: 317, y: -44 } };
const STORED = { name: 'combined', positions: POSITIONS };

const capture = ( name ) => {
	const node = Core.node( name );
	const sent = [];
	node.sink = { fill: ( m ) => sent.push( m ) };
	return { node, sent };
};

const reply = ( verb, payload ) => {
	const m = newMessage();
	m[ VALUE ] = { name: verb, payload };
	return m;
};

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
} );

it( 'returns stable callbacks across renders', () => {
	const { result, rerender } = renderHook( () => useLayout() );
	const first = result.current;
	rerender();
	expect( result.current ).toBe( first );
} );

it( 'mints get FROM the get node, with no ID and no KEY', () => {
	const { result } = renderHook( () => useLayout() );
	const { sent } = capture( 'layouts:get' );

	act( () => {
		// Never replied to; the teardown rejection is expected, not a failure.
		result.current.fetchLayout( 'combined' ).catch( () => {} );
	} );

	expect( sent ).toHaveLength( 1 );
	expect( sent[ 0 ][ FROM ] ).toBe( 'layouts:get' );
	expect( sent[ 0 ][ TO ] ).toBe( '_shell/_http/layouts' );
	expect( sent[ 0 ][ VALUE ].name ).toBe( 'get' );
	expect( sent[ 0 ][ VALUE ].arguments ).toEqual( [ 'combined' ] );
	expect( sent[ 0 ][ ID ] ).toBe( '' );
	expect( sent[ 0 ][ KEY ] ).toBe( '' );
} );

it( 'mints save FROM the save node with the positions as JSON', () => {
	const { result } = renderHook( () => useLayout() );
	const { sent } = capture( 'layouts:save' );

	act( () => {
		// Never replied to; the teardown rejection is expected, not a failure.
		result.current
			.saveLayout( { name: 'combined', positions: POSITIONS } )
			.catch( () => {} );
	} );

	expect( sent[ 0 ][ FROM ] ).toBe( 'layouts:save' );
	expect( sent[ 0 ][ VALUE ].arguments ).toEqual( [
		'combined',
		JSON.stringify( POSITIONS ),
	] );
} );

it( 'a get and a save in flight at once settle independently', async () => {
	const { result } = renderHook( () => useLayout() );
	const get = capture( 'layouts:get' );
	const save = capture( 'layouts:save' );

	let fetched;
	let saved;
	act( () => {
		fetched = result.current.fetchLayout( 'combined' );
		saved = result.current.saveLayout( {
			name: 'combined',
			positions: POSITIONS,
		} );
		// Replies land out of order; each node knows only its own.
		save.node.fill( reply( 'save', STORED ) );
		get.node.fill( reply( 'get', POSITIONS ) );
	} );

	await expect( fetched ).resolves.toEqual( POSITIONS );
	await expect( saved ).resolves.toEqual( STORED );
} );
