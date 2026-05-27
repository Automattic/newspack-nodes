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

	it( 'fill() is fire-and-forget (returns nothing) and still POSTs', () => {
		const { node, postBatch } = makeNode();
		postBatch.mockResolvedValueOnce( [] ); // bare 202 → no reply Messages
		const out = node.fill( routed( { to: 'demo.p0' } ) );
		expect( out ).toBeUndefined();
		expect( postBatch ).toHaveBeenCalledTimes( 1 );
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

	it( 'feeds a synchronous reply Message from the POST body into _sse', async () => {
		const { Node } = require( '../../../runtime/node' );
		const names = require( '../../../runtime/reserved-node-names.json' );
		const { node, postBatch } = makeNode();
		const sse = new Node();
		const got = [];
		sse.fill = ( m ) => got.push( m );
		sse.setName( names.SSE );

		const reply = newMessage();
		reply[ VALUE ] = 'sync-reply';
		postBatch.mockResolvedValueOnce( [ reply ] ); // JSONL → array of Messages

		await node.fill( routed( { to: '' } ) ); // _http-level → bare POST
		await Promise.resolve(); // flush the intake microtask

		expect( got ).toHaveLength( 1 );
		expect( got[ 0 ][ VALUE ] ).toBe( 'sync-reply' );
	} );

	it( 'feeds EVERY reply Message from a JSONL body into _sse (e.g. stderr line + response)', async () => {
		const { Node } = require( '../../../runtime/node' );
		const names = require( '../../../runtime/reserved-node-names.json' );
		const { node, postBatch } = makeNode();
		const sse = new Node();
		const got = [];
		sse.fill = ( m ) => got.push( m );
		sse.setName( names.SSE );

		const a = newMessage();
		a[ VALUE ] = 'log line';
		const b = newMessage();
		b[ VALUE ] = 'response';
		postBatch.mockResolvedValueOnce( [ a, b ] );

		await node.fill( routed( { to: '' } ) );
		await Promise.resolve();

		expect( got.map( ( m ) => m[ VALUE ] ) ).toEqual( [
			'log line',
			'response',
		] );
	} );

	it( 'ignores a null response (bare 202 — routed onward, reply via SSE)', async () => {
		const { Node } = require( '../../../runtime/node' );
		const names = require( '../../../runtime/reserved-node-names.json' );
		const { node, postBatch } = makeNode();
		const sse = new Node();
		const got = [];
		sse.fill = ( m ) => got.push( m );
		sse.setName( names.SSE );

		postBatch.mockResolvedValueOnce( null );
		await node.fill( routed( { to: 'demo.p0' } ) );
		await Promise.resolve();

		expect( got ).toHaveLength( 0 );
	} );

	it( 'when locked, fill() does NOT POST and buffers the entries', () => {
		const { node, postBatch } = makeNode();
		node.lock();
		node.fill( routed( { to: '' } ) ); // bare → 1 entry
		node.fill( routed( { to: 'demo.p0' } ) ); // worker → 2 entries
		expect( postBatch ).not.toHaveBeenCalled();
		expect( node.locked ).toBe( true );
		expect( node.buffer ).toHaveLength( 3 );
	} );

	it( 'flush() POSTs the whole buffer ONCE and clears locked/buffer', () => {
		const { node, postBatch } = makeNode();
		node.lock();
		node.fill( routed( { to: '' } ) );
		node.fill( routed( { to: 'demo.p0' } ) );
		node.flush();
		const batch = batchOf( postBatch );
		expect( batch ).toHaveLength( 3 );
		expect( node.locked ).toBe( false );
		expect( node.buffer ).toHaveLength( 0 );
	} );

	it( 'flush() with an empty buffer POSTs nothing', () => {
		const { node, postBatch } = makeNode();
		node.lock();
		node.flush();
		expect( postBatch ).not.toHaveBeenCalled();
		expect( node.locked ).toBe( false );
	} );

	it( 'POSTs the bare command (no connect) when addressed to _http itself (cd /_http)', () => {
		const { node, postBatch } = makeNode();
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ TO ] = ''; // _router peeled _http, nothing follows → the HTTP boundary itself
		m[ VALUE ] = { name: 'ls', arguments: '', payload: '' };
		node.fill( m );
		const batch = batchOf( postBatch );
		// No connect_worker_input prepend — the request-scope CI (HTTP_In) handles it.
		expect( batch ).toHaveLength( 1 );
		expect( batch[ 0 ][ VALUE ].name ).toBe( 'ls' );
		expect( batch[ 0 ][ TO ] ).toBe( '' );
	} );
} );
