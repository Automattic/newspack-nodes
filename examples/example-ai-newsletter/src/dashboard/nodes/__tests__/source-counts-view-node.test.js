/**
 * source-counts:view tests — the thin view node that owns ONLY the per-source
 * counts slice. It parses a `counts` reply ({"sources":{…}}) and setStates it for
 * <SourceCounts/>; it never touches the top or accumulated slices.
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

describe( 'source-counts:view', () => {
	test( 'starts with an empty sources slice', () => {
		const v = makeView();
		expect( v.setStateCache.view ).toEqual( { sources: {} } );
	} );

	test( 'parses a counts reply into the sources slice and publishes it', () => {
		const v = makeView();
		v.fill( countsReply( JSON.stringify( { sources: { releases: 2 } } ) ) );
		expect( v.setStateCache.view ).toEqual( { sources: { releases: 2 } } );
	} );

	test( 'a later reply replaces the published slice', () => {
		const v = makeView();
		v.fill( countsReply( JSON.stringify( { sources: { a: 1 } } ) ) );
		v.fill( countsReply( JSON.stringify( { sources: { b: 9 } } ) ) );
		expect( v.setStateCache.view ).toEqual( { sources: { b: 9 } } );
	} );

	test( 'surfaces a TM_ERROR reply as an error in the slice', () => {
		const v = makeView();
		const m = countsReply( 'counts read failed' );
		m[ TYPE ] = TM_COMMAND | TM_RESPONSE | TM_ERROR;
		v.fill( m );
		expect( v.setStateCache.view.error ).toMatch( /counts read failed/ );
	} );

	test( 'ignores an unparseable payload (keeps the prior slice)', () => {
		const v = makeView();
		v.fill( countsReply( JSON.stringify( { sources: { a: 1 } } ) ) );
		v.fill( countsReply( 'not json' ) );
		expect( v.setStateCache.view ).toEqual( { sources: { a: 1 } } );
	} );
} );
