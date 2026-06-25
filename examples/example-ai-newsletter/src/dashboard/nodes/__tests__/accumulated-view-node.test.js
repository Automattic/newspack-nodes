/**
 * accumulated:view tests — the thin view node that owns ONLY the accumulated
 * count slice. It parses an `accumulated` reply ({"accumulated":N}) and setStates
 * it for <AccumulatedCard/>; it never touches the counts or top slices.
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
import { AccumulatedViewNode } from '../accumulated-view-node';

beforeEach( () => Core.reset() );

function makeView() {
	const node = new AccumulatedViewNode();
	node.name = 'accumulated:view';
	return node;
}

function accReply( payload ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ VALUE ] = { name: 'accumulated', payload };
	return m;
}

describe( 'accumulated:view', () => {
	test( 'starts with a zero accumulated slice', () => {
		const v = makeView();
		expect( v.setStateCache.view ).toEqual( { accumulated: 0 } );
	} );

	test( 'parses an accumulated reply into the slice and publishes it', () => {
		const v = makeView();
		v.fill( accReply( JSON.stringify( { accumulated: 12 } ) ) );
		expect( v.setStateCache.view ).toEqual( { accumulated: 12 } );
	} );

	test( 'a later reply replaces the published slice', () => {
		const v = makeView();
		v.fill( accReply( JSON.stringify( { accumulated: 3 } ) ) );
		v.fill( accReply( JSON.stringify( { accumulated: 8 } ) ) );
		expect( v.setStateCache.view ).toEqual( { accumulated: 8 } );
	} );

	test( 'surfaces a TM_ERROR reply as an error in the slice', () => {
		const v = makeView();
		const m = accReply( 'acc read failed' );
		m[ TYPE ] = TM_COMMAND | TM_RESPONSE | TM_ERROR;
		v.fill( m );
		expect( v.setStateCache.view.error ).toMatch( /acc read failed/ );
	} );

	test( 'ignores an unparseable payload (keeps the prior slice)', () => {
		const v = makeView();
		v.fill( accReply( JSON.stringify( { accumulated: 5 } ) ) );
		v.fill( accReply( 'not json' ) );
		expect( v.setStateCache.view ).toEqual( { accumulated: 5 } );
	} );
} );
