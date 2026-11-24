/**
 * useForceRows — the force canvas's poller: while enabled it asks
 * `dump_metadata -s`, the whole graph and every sidecar's row, and hands back
 * the answer about the scope shown, the interpreter's row among them.
 */

import { act, renderHook } from '@testing-library/react';
import { FORCE_POLLER, useForceRows } from '../useForceRows';
import { SIDECAR_POLLER } from '../useSidecarRows';
import { ForceRowsNode } from '../../nodes/force-rows-node';
import { CommandInterpreterNode } from '../../../runtime/command-interpreter-node';
import { Core } from '../../../runtime/core';
import { MetadataNode } from '../../../runtime/metadata-node';
import {
	newMessage,
	FROM,
	TO,
	TYPE,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
} from '../../../runtime/message';

/** A scope's identity, as the console spells one. */
const SCOPE = 'quay.p3|view|quay';

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

const flush = () => act( async () => {} );

/**
 * Answer the poller as the Router hands it a reply.
 *
 * @param {Object} map     The `dump_metadata` reply map.
 * @param {string} [scope] The scope the reply names.
 */
function answer( map, scope = SCOPE ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ TO ] = encodeURIComponent( scope );
	m[ VALUE ] = { payload: map };
	act( () => Core.node( FORCE_POLLER ).fill( m ) );
}

/** The vat, its lid, and the backbone, as `dump_metadata -s` answers. */
const VAT = {
	_header: { pwd: 'quay.p3/_output' },
	_router: { class: 'Router', counter: 99 },
	_command_interpreter: { class: 'CommandInterpreter', counter: 57 },
	'vat-2290': {
		class: 'Vat',
		counter: 3,
		sidecars: [ { name: 'vat-2290:lid', class: 'Table' } ],
	},
	'vat-2290:lid': { class: 'Table', counter: 412, owner: 'vat-2290' },
};

const counts = ( graph ) =>
	Object.fromEntries( graph.nodes.map( ( n ) => [ n.id, n.count ] ) );

describe( 'useForceRows', () => {
	it( 'asks for the graph and every sidecar as it mounts, on the live grid', async () => {
		renderHook( () => useForceRows( true, SCOPE ) );
		await flush();
		expect( sent ).toHaveLength( 1 );
		expect( sent[ 0 ][ VALUE ] ).toMatchObject( {
			name: 'dump_metadata',
			arguments: [ '-s' ],
		} );
		expect( sent[ 0 ][ FROM ] ).toBe(
			`${ FORCE_POLLER }/${ encodeURIComponent( SCOPE ) }`
		);
		expect( FORCE_POLLER ).not.toBe( SIDECAR_POLLER );
		const poller = Core.node( FORCE_POLLER );
		expect( poller ).toBeInstanceOf( ForceRowsNode );
		expect( poller.interval_ms ).toBe( 2000 );
	} );

	it( 'hands back every row but the Router’s', () => {
		const { result } = renderHook( () => useForceRows( true, SCOPE ) );
		expect( result.current ).toEqual( { rows: null, snapshot: null } );
		answer( VAT );
		expect( counts( result.current.rows ) ).toEqual( {
			_command_interpreter: 57,
			'vat-2290': 3,
			'vat-2290:lid': 412,
		} );
		expect( result.current.snapshot ).toBe( result.current.rows );
	} );

	/**
	 * A reply of so many canvas nodes, the Vault_Group and its child among
	 * them, beside the backbone, thirty-one sidecars and one of theirs.
	 *
	 * @param {number} count Canvas nodes.
	 * @return {Object} The reply map.
	 */
	const replyOf = ( count ) => {
		const pins = Array.from( { length: 31 }, ( _, i ) => ( {
			name: `bolt-0:pin-${ i }`,
			class: 'Pin',
		} ) );
		const cap = { name: 'bolt-0:pin-0:cap', class: 'Cap' };
		const bolts = Array.from( { length: count - 2 }, ( _, i ) => [
			`bolt-${ i }`,
			{ class: 'Bolt' },
		] );
		return {
			...VAT,
			'vat-2290': { class: 'Vault_Group' },
			'vat-2290:lid': { class: 'Curl', owner: 'vat-2290' },
			...Object.fromEntries( bolts ),
			'bolt-0': { class: 'Bolt', sidecars: pins },
			...Object.fromEntries(
				pins.map( ( pin ) => [ pin.name, { class: 'Pin' } ] )
			),
			'bolt-0:pin-0': { class: 'Pin', sidecars: [ cap ] },
			[ cap.name ]: { class: 'Cap', owner: 'bolt-0:pin-0' },
		};
	};

	it.each( [
		[ 200, 2000 ],
		[ 201, 5000 ],
	] )( 'paces itself on %i canvas nodes, at %i ms', ( count, ms ) => {
		const poller = () => Core.node( FORCE_POLLER );
		renderHook( () => useForceRows( true, SCOPE ) );
		answer( replyOf( count ) );
		expect( poller().snapshot.nodes ).toHaveLength( count + 33 );
		expect( poller().interval_ms ).toBe( ms );

		const canvas = new MetadataNode();
		canvas.publish(
			Object.fromEntries(
				Object.entries( replyOf( count ) ).filter(
					( [ name ] ) => ! name.startsWith( 'bolt-0:' )
				)
			)
		);
		expect( poller().interval_ms ).toBe( canvas.pollIntervalMs );
	} );

	it( 'keeps the snapshot of the last reply through a patch of its rows', () => {
		const { result } = renderHook( () => useForceRows( true, SCOPE ) );
		answer( VAT );
		const { snapshot } = result.current;
		act( () =>
			Core.node( FORCE_POLLER ).optimisticPatch( 'vat-2290', {
				counter: 640,
			} )
		);
		expect( counts( result.current.rows )[ 'vat-2290' ] ).toBe( 640 );
		expect( result.current.snapshot ).toBe( snapshot );
	} );

	it( 'drops its rows with the scope they are about, and a late answer too', async () => {
		const { result, rerender } = renderHook(
			( { scope } ) => useForceRows( true, scope ),
			{ initialProps: { scope: SCOPE } }
		);
		answer( VAT );
		rerender( { scope: 'mill.p1|view|mill' } );
		expect( result.current ).toEqual( { rows: null, snapshot: null } );
		answer( VAT );
		expect( result.current.rows ).toBeNull();
		answer( { 'saw-18': { counter: 71 } }, 'mill.p1|view|mill' );
		expect( counts( result.current.rows ) ).toEqual( { 'saw-18': 71 } );
		await flush();
	} );

	it( 'mounts nothing while it is off, and leaves with it', async () => {
		const { result, rerender, unmount } = renderHook(
			( { enabled } ) => useForceRows( enabled, SCOPE ),
			{ initialProps: { enabled: false } }
		);
		await flush();
		expect( Core.node( FORCE_POLLER ) ).toBeNull();
		expect( sent ).toHaveLength( 0 );

		rerender( { enabled: true } );
		answer( VAT );
		rerender( { enabled: false } );
		expect( Core.node( FORCE_POLLER ) ).toBeNull();
		expect( result.current ).toEqual( { rows: null, snapshot: null } );

		rerender( { enabled: true } );
		expect( Core.node( FORCE_POLLER ) ).not.toBeNull();
		unmount();
		expect( Core.node( FORCE_POLLER ) ).toBeNull();
	} );
} );

describe( 'ForceRowsNode', () => {
	it( 'is registered under its make_node name', () => {
		require( '../../nodes/register' );
		expect( CommandInterpreterNode.includeNodes.ForceRows ).toBe(
			ForceRowsNode
		);
	} );

	it( 'hides the Router alone, and leaves what its base hides', () => {
		expect( [ ...ForceRowsNode.prototype.hidden ] ).toEqual( [
			'_router',
		] );
		expect( MetadataNode.prototype.hidden.size ).toBe( 2 );
		expect( Object.hasOwn( new ForceRowsNode(), 'hidden' ) ).toBe( false );
	} );
} );
