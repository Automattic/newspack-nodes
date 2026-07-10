/**
 * aggregator servers:view tests — the de-god SERVER-CARDS slice. Owns ONLY the
 * per-server partition snapshot the server cards render. Fed by its own
 * `servers_status` slice verb (FROM=servers:view), it parses the JSON-string
 * payload (a sequential array of server snapshots) into `{ servers }` and
 * publishes via setState('view', …) for the <AggregatorServers> widget. No
 * counts, no snapshot clock — that's the summary slice's job.
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
import { AggregatorServersViewNode } from '../aggregator-servers-view-node';

beforeEach( () => Core.reset() );

function makeView() {
	const node = new AggregatorServersViewNode();
	node.name = 'servers:view';
	return node;
}

// A reply Message as the slice verb emits: VALUE.payload = JSON array string.
function reply( serversArray ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ VALUE ] = {
		name: 'servers_status',
		payload: JSON.stringify( serversArray ),
	};
	return m;
}

function errorReply( errorString ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE | TM_ERROR;
	m[ VALUE ] = { name: 'servers_status', payload: errorString };
	return m;
}

const SAMPLE = [
	{
		id: 'server1',
		url: 'https://a.example.test',
		partitions: { 0: { connected: true } },
	},
	{ id: 'server2', url: 'https://b.example.test', partitions: {} },
];

describe( 'AggregatorServersViewNode', () => {
	test( 'starts loading with null servers before the first reply', () => {
		const v = makeView();
		expect( v.setStateCache.view ).toMatchObject( {
			servers: null,
			loading: true,
			error: null,
		} );
	} );

	test( 'parses a servers_status reply into the servers array and clears loading', () => {
		const v = makeView();
		v.fill( reply( SAMPLE ) );
		const model = v.setStateCache.view;
		expect( Array.isArray( model.servers ) ).toBe( true );
		expect( model.servers.map( ( s ) => s.id ) ).toEqual( [
			'server1',
			'server2',
		] );
		expect( model.loading ).toBe( false );
		expect( model.error ).toBeNull();
	} );

	test( 'an empty payload yields an empty servers array', () => {
		const v = makeView();
		v.fill( reply( [] ) );
		expect( v.setStateCache.view.servers ).toEqual( [] );
	} );

	test( 'a TM_ERROR reply surfaces the error and clears loading, KEEPING prior servers', () => {
		const v = makeView();
		v.fill( reply( SAMPLE ) );
		v.fill( errorReply( 'aggregator down' ) );
		const model = v.setStateCache.view;
		expect( model.error ).toBe( 'aggregator down' );
		expect( model.loading ).toBe( false );
		// Prior servers kept on transient error (parity with old view).
		expect( model.servers ).toHaveLength( 2 );
	} );

	test( 'is a Hidden, terminal (no output port) node', () => {
		const schema = makeView().constructor.nodeSchema();
		expect( schema.has_target ).toBe( false );
		expect( schema.category ).toBe( 'Hidden' );
	} );
} );
