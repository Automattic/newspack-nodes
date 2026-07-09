/**
 * HttpOut tests — the outbound `/command` POST boundary. `_router` (or the link
 * that owns it) delivers a single positional Message with TO already routed; HttpOut
 * POSTs it verbatim. The worker-attach `connect_worker_input` bundling moved up into
 * RemoteIpc (which owns its own HttpOut), so HttpOut itself is dumb: POST what it's
 * given, route every synchronous reply back into its sink (replies route by TO now —
 * there is no `_sse` convergence node).
 */

import { HttpOutNode } from '../http-out-node';
import { CommandClient } from '../command-client';
import { byteLength } from '../io-telemetry';
import {
	newMessage,
	pack,
	TYPE,
	FROM,
	TO,
	VALUE,
	TM_COMMAND,
	TM_PING,
} from '../message';

function makeNode() {
	const real = new CommandClient( { baseUrl: '/wp-json/', nonce: 'NONCE' } );
	// Default: a bare 202 with no synchronous reply Messages (the routed-onward
	// case). Reply-forwarding tests override with a proper array of Messages.
	const postBatch = jest.fn().mockResolvedValue( [] );
	const client = {
		buildMessage: real.buildMessage.bind( real ),
		postBatch,
	};
	const node = new HttpOutNode();
	node.client = client;
	node.name = '_http';
	return { node, postBatch };
}

const batchOf = ( postBatch ) => {
	expect( postBatch ).toHaveBeenCalledTimes( 1 );
	return postBatch.mock.calls[ 0 ][ 0 ];
};

// Build the positional Message the router would hand HttpOut (TO already routed).
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
	m[ VALUE ] = value ?? { name: 'ls', arguments: '' };
	return m;
}

describe( 'HttpOut', () => {
	afterEach( () => {
		const { Core } = require( '../core' );
		Core.reset();
	} );

	it( 'records bytesWritten + largestMsgSent for the packed POST body', () => {
		const { node } = makeNode();
		const m = routed( {
			to: 'echo',
			value: { name: 'tell', arguments: 'hi' },
		} );
		const size = byteLength( pack( m ) );
		node.fill( m );
		expect( node.bytesWritten ).toBe( size );
		expect( node.largestMsgSent ).toBe( size );
	} );

	it( 'records bytesRead for each reply Message returned by the POST (read boundary)', async () => {
		const { node, postBatch } = makeNode();
		const reply = routed( {
			to: '_output/1',
			value: { name: 'r', arguments: 'ok' },
		} );
		postBatch.mockResolvedValue( [ reply ] );
		node.fill( routed( { to: 'demo.p0' } ) );
		await new Promise( ( r ) => setTimeout( r, 0 ) );
		expect( node.bytesRead ).toBe( byteLength( pack( reply ) ) );
	} );

	it( 'packs each message once and hands the packed lines to postBatch (no double-serialize)', () => {
		const { node, postBatch } = makeNode();
		const m = routed( { to: 'demo.p0' } );
		node.fill( m );
		// Second arg is the pre-packed JSONL lines — postBatch must reuse them.
		expect( postBatch.mock.calls[ 0 ][ 1 ] ).toEqual( [ pack( m ) ] );
	} );

	it( 'POSTs the routed Message verbatim (no connect_worker_input prepend)', () => {
		const { node, postBatch } = makeNode();
		node.fill( routed( { to: 'demo.p0' } ) );
		const batch = batchOf( postBatch );
		expect( batch ).toHaveLength( 1 );
		expect( batch[ 0 ][ TO ] ).toBe( 'demo.p0' );
		expect( batch[ 0 ][ VALUE ].name ).toBe( 'ls' );
	} );

	it( 'POSTs a server-CI target (workers) verbatim', () => {
		const { node, postBatch } = makeNode();
		node.fill(
			routed( {
				to: 'workers',
				from: '_http/_sse:9/_heartbeat',
				value: { name: 'heartbeat', arguments: '1 10 0' },
			} )
		);
		const batch = batchOf( postBatch );
		expect( batch ).toHaveLength( 1 );
		expect( batch[ 0 ][ TO ] ).toBe( 'workers' );
		expect( batch[ 0 ][ VALUE ].name ).toBe( 'heartbeat' );
	} );

	it( 'leaves the reply FROM untouched', () => {
		const { node, postBatch } = makeNode();
		node.fill( routed( { to: 'demo.p0', from: '_http/555/_metadata' } ) );
		const batch = batchOf( postBatch );
		expect( batch[ 0 ][ FROM ] ).toBe( '_http/555/_metadata' );
	} );

	it( 'forwards a TM_PING positional message verbatim (no re-typing)', () => {
		const { node, postBatch } = makeNode();
		node.fill(
			routed( { to: 'demo.p0', type: TM_PING, value: 1700000000.5 } )
		);
		const batch = batchOf( postBatch );
		expect( batch[ 0 ][ TYPE ] ).toBe( TM_PING );
		expect( batch[ 0 ][ VALUE ] ).toBe( 1700000000.5 );
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

	it( 'feeds a synchronous reply Message from the POST body into sink', async () => {
		const { Node } = require( '../node' );
		const { node, postBatch } = makeNode();
		const got = [];
		const sink = new Node();
		sink.fill = ( m ) => got.push( m );
		node.sink = sink;

		const reply = newMessage();
		reply[ VALUE ] = 'sync-reply';
		postBatch.mockResolvedValueOnce( [ reply ] ); // JSONL → array of Messages

		await node.fill( routed( { to: '' } ) ); // bare POST
		await Promise.resolve(); // flush the intake microtask

		expect( got ).toHaveLength( 1 );
		expect( got[ 0 ][ VALUE ] ).toBe( 'sync-reply' );
	} );

	it( 'feeds EVERY reply Message from a JSONL body into sink (e.g. stderr line + response)', async () => {
		const { Node } = require( '../node' );
		const { node, postBatch } = makeNode();
		const got = [];
		const sink = new Node();
		sink.fill = ( m ) => got.push( m );
		node.sink = sink;

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
		expectConsoleWarn( '_http: ERROR: HttpOut POST failed:' );
		const { Node } = require( '../node' );
		const { node, postBatch } = makeNode();
		const got = [];
		const sink = new Node();
		sink.fill = ( m ) => got.push( m );
		node.sink = sink;

		postBatch.mockResolvedValueOnce( null );
		await node.fill( routed( { to: 'demo.p0' } ) );
		await Promise.resolve();

		expect( got ).toHaveLength( 0 );
	} );

	it( 'when locked, fill() does NOT POST and buffers the message', () => {
		const { node, postBatch } = makeNode();
		node.lock();
		node.fill( routed( { to: '' } ) );
		node.fill( routed( { to: 'demo.p0' } ) );
		expect( postBatch ).not.toHaveBeenCalled();
		expect( node.locked ).toBe( true );
		expect( node.buffer ).toHaveLength( 2 );
	} );

	it( 'flush() POSTs the whole buffer ONCE and clears locked/buffer', () => {
		const { node, postBatch } = makeNode();
		node.lock();
		node.fill( routed( { to: '' } ) );
		node.fill( routed( { to: 'demo.p0' } ) );
		node.flush();
		const batch = batchOf( postBatch );
		expect( batch ).toHaveLength( 2 );
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

	it( 'POSTs the bare command when addressed to _http itself (cd /_http)', () => {
		const { node, postBatch } = makeNode();
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ TO ] = ''; // _router peeled _http, nothing follows → the HTTP boundary itself
		m[ VALUE ] = { name: 'ls', arguments: '' };
		node.fill( m );
		const batch = batchOf( postBatch );
		expect( batch ).toHaveLength( 1 );
		expect( batch[ 0 ][ VALUE ].name ).toBe( 'ls' );
		expect( batch[ 0 ][ TO ] ).toBe( '' );
	} );

	describe( '_post — reply intake routes to sink (route-by-TO)', () => {
		it( 'feeds a POST-body reply into this.sink', async () => {
			const { Node } = require( '../node' );
			const { node, postBatch } = makeNode();
			const seen = [];
			const sink = new Node();
			sink.fill = ( m ) => seen.push( m );
			node.sink = sink;

			const reply = newMessage();
			reply[ VALUE ] = 'sync-reply';
			postBatch.mockResolvedValueOnce( [ reply ] );

			await node.fill( routed( { to: '' } ) );
			await Promise.resolve();

			expect( seen ).toHaveLength( 1 );
			expect( seen[ 0 ][ VALUE ] ).toBe( 'sync-reply' );
		} );

		it( 'drops POST-body replies silently when sink is null', async () => {
			const { node, postBatch } = makeNode();
			node.sink = null;
			const reply = newMessage();
			reply[ VALUE ] = 'sync-reply';
			postBatch.mockResolvedValueOnce( [ reply ] );

			await expect(
				( async () => {
					node.fill( routed( { to: '' } ) );
					await Promise.resolve();
					await Promise.resolve();
				} )()
			).resolves.toBeUndefined();
		} );
	} );

	describe( 'no-arg ctor + public-property dep', () => {
		it( 'constructs with no args; client defaults to null', () => {
			const node = new HttpOutNode();
			expect( node.client ).toBeNull();
			expect( node.locked ).toBe( false );
			expect( node.buffer ).toEqual( [] );
		} );

		it( 'has an empty arguments schema (client is programmatic, not config)', () => {
			const schema = HttpOutNode.nodeSchema();
			expect( schema.arguments ).toEqual( [] );
		} );

		it( 'declares has_target:false (POSTs out + routes replies, never targets in-graph — no out-port)', () => {
			expect( HttpOutNode.nodeSchema().has_target ).toBe( false );
		} );

		it( 'accepts the client as a public property and POSTs through it', () => {
			const postBatch = jest.fn().mockResolvedValue( [] );
			const real = new CommandClient( {
				baseUrl: '/wp-json/',
				nonce: 'NONCE',
			} );
			const client = {
				buildMessage: real.buildMessage.bind( real ),
				postBatch,
			};
			const node = new HttpOutNode();
			node.client = client;
			node.name = '_http';
			node.fill( routed( { to: 'demo.p0' } ) );
			expect( postBatch ).toHaveBeenCalledTimes( 1 );
		} );

		it( 'surfaces a postBatch rejection via printLessOften (no silent swallow)', async () => {
			const node = new HttpOutNode();
			node.name = '_http';
			node.client = {
				buildMessage: () => newMessage(),
				postBatch: () =>
					Promise.reject( new Error( 'boom 502 from /command' ) ),
			};
			const spy = jest
				.spyOn( node, 'printLessOften' )
				.mockImplementation( () => {} );
			node.fill( routed( { to: 'demo.p0' } ) );
			await new Promise( ( r ) => setTimeout( r, 0 ) );
			expect( spy ).toHaveBeenCalled();
			expect( spy.mock.calls[ 0 ][ 0 ] ).toMatch( /^ERROR:.*boom 502/ );
			spy.mockRestore();
		} );
	} );
} );
