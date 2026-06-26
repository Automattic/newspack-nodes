/**
 * aggregator summary:view tests — the de-god HEADER slice. Owns ONLY the
 * connected/total counts + snapshot clock the dashboard header renders. Fed by
 * its own `summary` slice verb (FROM=summary:view), it parses the JSON-string
 * payload `{ connected, total, server_now }` into its slice and publishes via
 * setState('view', …) for the <AggregatorSummary> widget. No server cards, no
 * partition data — that's the servers slice's job.
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
import { AggregatorSummaryViewNode } from '../aggregator-summary-view-node';

beforeEach( () => Core.reset() );

function makeView() {
	const node = new AggregatorSummaryViewNode();
	node.name = 'summary:view';
	return node;
}

// A reply Message as the slice verb emits one: VALUE.payload is a JSON STRING
// (the substrate SliceViewNode contract).
function reply( payload ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ VALUE ] = { name: 'summary', payload: JSON.stringify( payload ) };
	return m;
}

function errorReply( errorString ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE | TM_ERROR;
	m[ VALUE ] = { name: 'summary', payload: errorString };
	return m;
}

describe( 'AggregatorSummaryViewNode', () => {
	test( 'starts loading with zero counts before the first reply', () => {
		const v = makeView();
		expect( v.setStateCache.view ).toMatchObject( {
			connected: 0,
			total: 0,
			serverNow: null,
			loading: true,
			error: null,
		} );
	} );

	test( 'parses a summary reply into connected/total/serverNow and clears loading', () => {
		const v = makeView();
		v.fill( reply( { connected: 1, total: 3, server_now: 1748960000 } ) );
		expect( v.setStateCache.view ).toMatchObject( {
			connected: 1,
			total: 3,
			serverNow: 1748960000,
			loading: false,
			error: null,
		} );
	} );

	test( 'a summary reply sets lastRefresh (a browser-clock ms number)', () => {
		const v = makeView();
		const before = Date.now();
		v.fill( reply( { connected: 0, total: 0, server_now: 1 } ) );
		const { lastRefresh } = v.setStateCache.view;
		expect( typeof lastRefresh ).toBe( 'number' );
		expect( lastRefresh ).toBeGreaterThanOrEqual( before );
	} );

	test( 'a TM_ERROR reply surfaces the error string and clears loading', () => {
		const v = makeView();
		v.fill( errorReply( 'aggregator down' ) );
		expect( v.setStateCache.view.error ).toBe( 'aggregator down' );
		expect( v.setStateCache.view.loading ).toBe( false );
	} );

	test( 'is a Hidden, terminal (no output port) node', () => {
		const schema = makeView().constructor.nodeSchema();
		expect( schema.has_target ).toBe( false );
		expect( schema.category ).toBe( 'Hidden' );
	} );
} );
