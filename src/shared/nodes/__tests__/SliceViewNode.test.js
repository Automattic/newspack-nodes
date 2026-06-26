/**
 * SliceViewNode tests — the shared thin-view-node base every dashboard
 * rebuild's slice views extend. These exercise the base contract through a
 * concrete subclass: parse a 200 reply into the slice, surface a TM_ERROR
 * (string OR { message } payload), keep the prior slice on transient garbage,
 * and start with the subclass's empty slice.
 *
 * They also cover the OPTIONAL PendingReplies settle path: a subclass that
 * assigns `this.replies` (a PendingReplies) lets `fill()` settle an awaited
 * verb first and return; with no pending entry it falls through to the model
 * path, and a base with no `replies` behaves exactly as before.
 */

import {
	ID,
	VALUE,
	TYPE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	newMessage,
	Core,
} from '@newspack-nodes/runtime';
import { PendingReplies } from '@newspack-nodes/shared/pendingReplies';
import { SliceViewNode } from '../SliceViewNode';

beforeEach( () => Core.reset() );

// A concrete subclass owning a `sources` slice, mirroring the example's views.
class CountsView extends SliceViewNode {
	emptySlice() {
		return { sources: {} };
	}
}

function makeView() {
	const node = new CountsView();
	node.name = 'counts:view';
	return node;
}

function reply( payload ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ VALUE ] = { name: 'counts', payload };
	return m;
}

describe( 'SliceViewNode', () => {
	test( 'starts with the subclass empty slice', () => {
		expect( makeView().setStateCache.view ).toEqual( { sources: {} } );
	} );

	test( 'parses a 200 reply into the slice and publishes it', () => {
		const v = makeView();
		v.fill( reply( JSON.stringify( { sources: { releases: 2 } } ) ) );
		expect( v.setStateCache.view ).toEqual( { sources: { releases: 2 } } );
	} );

	test( 'surfaces a TM_ERROR with a STRING payload as a slice error', () => {
		const v = makeView();
		const m = reply( 'counts read failed' );
		m[ TYPE ] = TM_COMMAND | TM_RESPONSE | TM_ERROR;
		v.fill( m );
		expect( v.setStateCache.view.error ).toMatch( /counts read failed/ );
		expect( v.setStateCache.view.sources ).toEqual( {} );
	} );

	test( 'surfaces a TM_ERROR with an OBJECT { message } VALUE as a slice error', () => {
		const v = makeView();
		// A transport error (Router NOT_AVAILABLE) arrives as a bare object
		// VALUE whose .payload carries the readable message.
		const m = newMessage();
		m[ TYPE ] = TM_ERROR;
		m[ VALUE ] = { payload: { message: 'NOT_AVAILABLE' } };
		v.fill( m );
		expect( v.setStateCache.view.error ).toMatch( /NOT_AVAILABLE/ );
	} );

	test( 'a non-error unparseable string reply keeps the prior slice', () => {
		const v = makeView();
		v.fill( reply( JSON.stringify( { sources: { a: 1 } } ) ) );
		const garbage = newMessage();
		garbage[ TYPE ] = TM_COMMAND | TM_RESPONSE;
		garbage[ VALUE ] = 'not a json object';
		v.fill( garbage );
		expect( v.setStateCache.view ).toEqual( { sources: { a: 1 } } );
	} );

	describe( 'optional PendingReplies settle path', () => {
		test( 'settles an awaited reply and does NOT touch the model', async () => {
			const v = makeView();
			v.replies = new PendingReplies();
			const id = 'verb-1';
			const settled = new Promise( ( resolve, reject ) =>
				v.replies.add( id, resolve, reject )
			);
			const m = reply( JSON.stringify( { sources: { x: 9 } } ) );
			m[ ID ] = id;
			v.fill( m );
			// The reply was consumed by the settle path: the awaited Promise
			// resolves with VALUE.payload and the slice model is untouched.
			await expect( settled ).resolves.toBe(
				JSON.stringify( { sources: { x: 9 } } )
			);
			expect( v.setStateCache.view ).toEqual( { sources: {} } );
		} );

		test( 'falls through to the model path when no pending entry matches', () => {
			const v = makeView();
			v.replies = new PendingReplies();
			const m = reply( JSON.stringify( { sources: { b: 3 } } ) );
			m[ ID ] = 'unknown-id';
			v.fill( m );
			expect( v.setStateCache.view ).toEqual( { sources: { b: 3 } } );
		} );

		test( 'with no `replies` set, behaves exactly as the model path', () => {
			const v = makeView();
			const m = reply( JSON.stringify( { sources: { c: 7 } } ) );
			m[ ID ] = 'has-an-id-but-no-replies';
			v.fill( m );
			expect( v.setStateCache.view ).toEqual( { sources: { c: 7 } } );
		} );
	} );
} );
