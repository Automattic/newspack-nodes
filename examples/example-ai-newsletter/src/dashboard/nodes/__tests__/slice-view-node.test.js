/**
 * SliceViewNode tests — the shared base for the three Publisher Insights slice
 * view nodes. These exercise the base contract directly through a concrete
 * subclass (SourceCountsViewNode): a transport-minted TM_ERROR with a STRING
 * VALUE (a Router NOT_AVAILABLE reply) must surface as a slice error, and a
 * malformed non-error string reply must keep the prior slice.
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
import { SourceCountsViewNode } from '../source-counts-view-node';

beforeEach( () => Core.reset() );

function makeView() {
	const node = new SourceCountsViewNode();
	node.name = 'source-counts:view';
	return node;
}

function countsReply( payload ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ VALUE ] = { name: 'counts', payload };
	return m;
}

describe( 'SliceViewNode', () => {
	test( 'surfaces a TM_ERROR with a STRING VALUE (Router NOT_AVAILABLE) as a slice error', () => {
		const v = makeView();
		// The Router mints unrouted-error replies with a bare string VALUE
		// ('NOT_AVAILABLE\n') and the TM_ERROR bit — no { name, payload } object.
		const m = newMessage();
		m[ TYPE ] = TM_ERROR;
		m[ VALUE ] = 'NOT_AVAILABLE\n';
		v.fill( m );
		expect( v.setStateCache.view.error ).toMatch( /NOT_AVAILABLE/ );
	} );

	test( 'an unparseable string 200 reply (non-error) keeps the prior slice', () => {
		const v = makeView();
		v.fill( countsReply( JSON.stringify( { sources: { a: 1 } } ) ) );
		// A non-error reply whose VALUE is a raw, unparseable string must not
		// blank the widget — keep the last good slice.
		const garbage = newMessage();
		garbage[ TYPE ] = TM_COMMAND | TM_RESPONSE;
		garbage[ VALUE ] = 'not a json object';
		v.fill( garbage );
		expect( v.setStateCache.view ).toEqual( { sources: { a: 1 } } );
	} );
} );
