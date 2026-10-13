/**
 * useSidecarRows — the one poller of the owned nodes the console shows: it
 * asks `dump_metadata -o` for each owner at once, the owners riding on FROM,
 * the first ask leaving on the mount, and hands back the answer twice: the
 * graph an optimistic edit may patch, and the snapshot only a reply writes.
 */

import { act, renderHook } from '@testing-library/react';
import { SIDECAR_POLLER, useSidecarRows } from '../useSidecarRows';
import { Core } from '../../../runtime/core';
import {
	newMessage,
	FROM,
	TO,
	TYPE,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
} from '../../../runtime/message';

const OWNERS = [ 'crawl-4471:seen', 'vat-2290' ];

/** What reached `_cwd`, the scope a worker would answer from. */
let sent;

beforeEach( () => {
	jest.useFakeTimers();
	Core.reset();
	sent = [];
	Core.registerNode( '_cwd', {
		name: '_cwd',
		fill: ( m ) => sent.push( m ),
	} );
} );

afterEach( () => {
	jest.useRealTimers();
} );

/**
 * Answer the poller as the Router hands it a reply.
 *
 * @param {Object} map     The `dump_metadata` reply map.
 * @param {string} subject The subject the reply names.
 */
function answer( map, subject ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ TO ] = encodeURIComponent( subject );
	m[ VALUE ] = { payload: map };
	act( () => Core.node( SIDECAR_POLLER ).fill( m ) );
}

/** The vat and the lid it owns, as `dump_metadata -o vat-2290` answers. */
const VAT = {
	'vat-2290': {
		class: 'Node',
		counter: 3,
		sidecars: [ { name: 'vat-2290:lid', class: 'Table' } ],
	},
	'vat-2290:lid': { class: 'Table', counter: 412, owner: 'vat-2290' },
};

describe( 'useSidecarRows', () => {
	it( 'asks for every owner at once, by name, as it mounts', async () => {
		renderHook( () => useSidecarRows( OWNERS ) );
		await act( async () => {} );
		expect( sent ).toHaveLength( 1 );
		expect( sent[ 0 ][ VALUE ] ).toMatchObject( {
			name: 'dump_metadata',
			arguments: [ '-o', ...OWNERS ],
		} );
		expect( sent[ 0 ][ FROM ] ).toBe(
			`${ SIDECAR_POLLER }/${ encodeURIComponent( OWNERS.join( ' ' ) ) }`
		);
	} );

	it( 'hands back the rows of the answer about these owners', () => {
		const { result } = renderHook( () => useSidecarRows( OWNERS ) );
		expect( result.current ).toEqual( {
			graph: null,
			snapshot: null,
			answered: [],
		} );
		answer( VAT, 'vat-2290' );
		expect( result.current.graph ).toBeNull();
		answer(
			{ ...VAT, 'crawl-4471:seen': { class: 'Table', counter: 9083 } },
			OWNERS.join( ' ' )
		);
		expect( result.current.graph.nodes.map( ( n ) => n.count ) ).toEqual( [
			3, 412, 9083,
		] );
		expect( result.current.answered ).toEqual( [
			'crawl-4471:seen',
			'vat-2290',
			'vat-2290:lid',
		] );
		expect( result.current.snapshot ).toBe(
			Core.node( SIDECAR_POLLER ).snapshot
		);
	} );

	it( 'asks the same poller anew, keeping each row the new owners cover', async () => {
		const { result, rerender } = renderHook(
			( { owners } ) => useSidecarRows( owners ),
			{ initialProps: { owners: [ 'vat-2290' ] } }
		);
		await act( async () => {} );
		answer( VAT, 'vat-2290' );
		const poller = Core.node( SIDECAR_POLLER );
		rerender( { owners: [ 'vat-2290:lid' ] } );
		await act( async () => {} );
		expect( Core.node( SIDECAR_POLLER ) ).toBe( poller );
		expect( sent[ sent.length - 1 ][ VALUE ].arguments ).toEqual( [
			'-o',
			'vat-2290:lid',
		] );
		expect( result.current.graph.nodes ).toEqual( [
			expect.objectContaining( { id: 'vat-2290:lid', count: 412 } ),
		] );
		expect( result.current.answered ).toEqual( [ 'vat-2290:lid' ] );
		answer( { 'vat-2290:lid': { counter: 9 } }, 'vat-2290' );
		expect( result.current.graph.nodes[ 0 ].count ).toBe( 412 );
		answer( { 'vat-2290:lid': { counter: 8125 } }, 'vat-2290:lid' );
		expect( result.current.graph.nodes[ 0 ].count ).toBe( 8125 );
	} );

	it( 'mounts nothing for no owners', async () => {
		const { result } = renderHook( () => useSidecarRows( [] ) );
		await act( async () => {} );
		expect( Core.node( SIDECAR_POLLER ) ).toBeFalsy();
		expect( sent ).toHaveLength( 0 );
		expect( result.current ).toEqual( {
			graph: null,
			snapshot: null,
			answered: [],
		} );
	} );
} );
