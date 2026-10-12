/**
 * usePoller — one poller node mounted on the backbone for the life of a
 * view, asking its verb of `_cwd` at the live cadence and handing back the
 * field it publishes, filtered to the subject it asks about now.
 */

import { act, renderHook } from '@testing-library/react';
import { usePoller } from '../usePoller';
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
 * A reply as the Router hands it to the poller: the subject the poll rode on
 * FROM left as the remaining TO.
 *
 * @param {string}  name    The poller.
 * @param {*}       payload The reply body.
 * @param {?string} subject The subject it names, or null.
 */
function answer( name, payload, subject = null ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ TO ] = null === subject ? '' : encodeURIComponent( subject );
	m[ VALUE ] = { payload };
	act( () => Core.node( name ).fill( m ) );
}

const flush = () => act( async () => {} );

describe( 'usePoller', () => {
	it( 'mounts the class it names, asking its verb of _cwd at the live cadence', () => {
		renderHook( () =>
			usePoller( {
				name: 'kea:fetch',
				nodeClass: 'Metadata',
				verb: 'dump_metadata',
				args: [ 'kea-3307' ],
				field: 'metadata',
			} )
		);
		const poller = Core.node( 'kea:fetch' );
		expect( poller ).toBeInstanceOf( MetadataNode );
		expect( poller.verb ).toBe( 'dump_metadata' );
		expect( poller.pollArgs ).toEqual( [ 'kea-3307' ] );
		expect( poller.target ).toBe( '_cwd' );
		expect( poller.interval_ms ).toBe( 2000 );
	} );

	it( 'sends its first poll once, inside the Router tick it asks for', async () => {
		renderHook( () =>
			usePoller( {
				name: 'kea:fetch',
				verb: 'list_timers',
				args: [ '-s' ],
			} )
		);
		expect( sent ).toHaveLength( 0 );
		await flush();
		expect( sent ).toHaveLength( 1 );
		expect( sent[ 0 ][ VALUE ] ).toMatchObject( {
			name: 'list_timers',
			arguments: [ '-s' ],
		} );
	} );

	it( 'hands back the field it publishes, and drops the node on unmount', () => {
		const { result, unmount } = renderHook( () =>
			usePoller( { name: 'kea:fetch', verb: 'list_timers' } )
		);
		answer( 'kea:fetch', [ { name: 'tick-5520' } ] );
		expect( result.current.value ).toEqual( [ { name: 'tick-5520' } ] );
		unmount();
		expect( Core.node( 'kea:fetch' ) ).toBeNull();
	} );

	it( 'rides its subject on FROM and shows only the answer about it', async () => {
		const { result, rerender } = renderHook(
			( { subject } ) =>
				usePoller( {
					name: 'kea:fetch',
					nodeClass: 'Metadata',
					verb: 'dump_metadata',
					args: [ subject ],
					field: 'metadata',
					subject,
				} ),
			{ initialProps: { subject: 'kea-3307:lid' } }
		);
		await flush();
		expect( sent[ 0 ][ FROM ] ).toBe( 'kea:fetch/kea-3307%3Alid' );

		rerender( { subject: 'kea-3307:spout' } );
		expect( result.current.value ).toBeNull();
		answer(
			'kea:fetch',
			{ 'kea-3307:lid': { class: 'Table' } },
			'kea-3307:lid'
		);
		expect( result.current.value ).toBeNull();
		answer(
			'kea:fetch',
			{ 'kea-3307:spout': { class: 'Echo' } },
			'kea-3307:spout'
		);
		expect( result.current.value.nodes.map( ( n ) => n.id ) ).toEqual( [
			'kea-3307:spout',
		] );
	} );

	it( 'mounts nothing while disabled', () => {
		renderHook( () =>
			usePoller( {
				name: 'kea:fetch',
				verb: 'list_timers',
				enabled: false,
			} )
		);
		expect( Core.node( 'kea:fetch' ) ).toBeNull();
	} );

	it( 'polls again now, inside one tick, when asked', async () => {
		const { result } = renderHook( () =>
			usePoller( { name: 'kea:fetch', verb: 'list_profiles' } )
		);
		await flush();
		act( () => result.current.pollNow() );
		expect( sent ).toHaveLength( 1 );
		await flush();
		expect( sent ).toHaveLength( 2 );
	} );
} );
