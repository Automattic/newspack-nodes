/**
 * HttpOut tests — the `_http` console node. `_router` peels `_http` and delivers
 * a single positional Message with TO={reader} (or {reader}/{node}); HttpOut
 * POSTs it to /command behind a leading connect_worker_input (the prepend is
 * kept; de-bake deferred per WIRING-PLAN §8). FROM is left untouched — the Shell
 * / poll-builder already stamped the reply pivot.
 */

import { HttpOut } from '../httpOut';
import { CommandClient } from '../../../runtime/command_client';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	VALUE,
	TM_COMMAND,
	TM_PING,
} from '../../../runtime/message';

function makeNode() {
	const real = new CommandClient( { baseUrl: '/wp-json/', nonce: 'NONCE' } );
	const postBatch = jest
		.fn()
		.mockResolvedValue( [ 0, 0, '', '', '', '', '{}' ] );
	const client = {
		buildMessage: real.buildMessage.bind( real ),
		postBatch,
	};
	const node = new HttpOut( { client } );
	node.setName( '_http' );
	return { node, postBatch };
}

const batchOf = ( postBatch ) => {
	expect( postBatch ).toHaveBeenCalledTimes( 1 );
	return postBatch.mock.calls[ 0 ][ 0 ];
};

// Build the positional Message the router would hand HttpOut (TO already peeled).
function routed( {
	to,
	from = '_http/777/_output',
	type = TM_COMMAND,
	value,
} ) {
	const m = newMessage();
	m[ TYPE ] = type;
	m[ FROM ] = from;
	m[ TO ] = to;
	m[ VALUE ] = value ?? { name: 'ls', arguments: '', payload: '' };
	return m;
}

describe( 'HttpOut', () => {
	afterEach( () => {
		const { Core } = require( '../../../runtime/core' );
		Core.reset();
	} );

	it( 'POSTs a single routed Message behind a leading connect_worker_input', () => {
		const { node, postBatch } = makeNode();
		node.fill( routed( { to: 'demo.p0' } ) );
		const batch = batchOf( postBatch );
		expect( batch ).toHaveLength( 2 );
		// Leading connect mounts the worker input partition for {reader}.
		expect( batch[ 0 ][ TO ] ).toBe( 'topologies' );
		expect( batch[ 0 ][ VALUE ].name ).toBe( 'connect_worker_input' );
		expect( batch[ 0 ][ VALUE ].arguments ).toBe( 'demo.p0' );
		// The routed message rides as-is.
		expect( batch[ 1 ][ TO ] ).toBe( 'demo.p0' );
		expect( batch[ 1 ][ VALUE ].name ).toBe( 'ls' );
	} );

	it( 'derives the reader from the head of TO when a node path follows', () => {
		const { node, postBatch } = makeNode();
		node.fill( routed( { to: 'demo.p0/firehose-in' } ) );
		const batch = batchOf( postBatch );
		expect( batch[ 0 ][ VALUE ].arguments ).toBe( 'demo.p0' );
		expect( batch[ 1 ][ TO ] ).toBe( 'demo.p0/firehose-in' );
	} );

	it( 'leaves the reply-pivot FROM untouched', () => {
		const { node, postBatch } = makeNode();
		node.fill( routed( { to: 'demo.p0', from: '_http/555/_metadata' } ) );
		const batch = batchOf( postBatch );
		expect( batch[ 1 ][ FROM ] ).toBe( '_http/555/_metadata' );
	} );

	it( 'forwards a TM_PING positional message verbatim (no re-typing)', () => {
		const { node, postBatch } = makeNode();
		node.fill(
			routed( { to: 'demo.p0', type: TM_PING, value: 1700000000.5 } )
		);
		const batch = batchOf( postBatch );
		expect( batch[ 1 ][ TYPE ] ).toBe( TM_PING );
		expect( batch[ 1 ][ VALUE ] ).toBe( 1700000000.5 );
	} );

	it( 'returns the postBatch promise', async () => {
		const { node, postBatch } = makeNode();
		postBatch.mockResolvedValueOnce( { queued: true } );
		const out = await node.fill( routed( { to: 'demo.p0' } ) );
		expect( out ).toEqual( { queued: true } );
	} );

	it( 'increments the base Node counter on each fill', () => {
		const { node } = makeNode();
		node.fill( routed( { to: 'demo.p0' } ) );
		node.fill( routed( { to: 'demo.p0' } ) );
		expect( node.counter ).toBe( 2 );
	} );

	it( 'is the `_http` node', () => {
		const { node } = makeNode();
		expect( node.name ).toBe( '_http' );
	} );

	it( 'POSTs nothing when handed a message with an empty TO (no reader to route)', () => {
		const { node, postBatch } = makeNode();
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ TO ] = '';
		m[ VALUE ] = { name: 'ls', arguments: '', payload: '' };
		node.fill( m );
		expect( postBatch ).not.toHaveBeenCalled();
	} );
} );
