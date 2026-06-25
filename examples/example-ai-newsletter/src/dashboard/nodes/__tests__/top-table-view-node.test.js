/**
 * top-table:view tests — the thin view node that owns ONLY the top-items slice.
 * It parses a `top` reply ({"top":[…]}) and setStates it for <TopTable/>; it
 * never touches the counts or accumulated slices.
 */

import {
	VALUE,
	TYPE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	newMessage,
	Core,
} from '@newspack-nodes/runtime';
import { TopTableViewNode } from '../top-table-view-node';

beforeEach( () => Core.reset() );

function makeView() {
	const node = new TopTableViewNode();
	node.name = 'top-table:view';
	return node;
}

function topReply( payload ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ VALUE ] = { name: 'top', payload };
	return m;
}

const sampleTop = [
	{ source: 'releases', title: 'A', score: 9.5 },
	{ source: 'community', title: 'B', score: 4 },
];

describe( 'top-table:view', () => {
	test( 'starts with an empty top slice', () => {
		const v = makeView();
		expect( v.setStateCache.view ).toEqual( { top: [] } );
	} );

	test( 'parses a top reply into the top slice and publishes it', () => {
		const v = makeView();
		v.fill( topReply( JSON.stringify( { top: sampleTop } ) ) );
		expect( v.setStateCache.view ).toEqual( { top: sampleTop } );
	} );

	test( 'a later reply replaces the published slice', () => {
		const v = makeView();
		v.fill( topReply( JSON.stringify( { top: sampleTop } ) ) );
		v.fill( topReply( JSON.stringify( { top: [] } ) ) );
		expect( v.setStateCache.view ).toEqual( { top: [] } );
	} );

	test( 'surfaces a TM_ERROR reply as an error in the slice', () => {
		const v = makeView();
		const m = topReply( 'top read failed' );
		m[ TYPE ] = TM_COMMAND | TM_RESPONSE | TM_ERROR;
		v.fill( m );
		expect( v.setStateCache.view.error ).toMatch( /top read failed/ );
	} );

	test( 'ignores an unparseable payload (keeps the prior slice)', () => {
		const v = makeView();
		v.fill( topReply( JSON.stringify( { top: sampleTop } ) ) );
		v.fill( topReply( 'not json' ) );
		expect( v.setStateCache.view ).toEqual( { top: sampleTop } );
	} );
} );
