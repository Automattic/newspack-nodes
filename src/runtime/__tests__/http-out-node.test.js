/**
 * HttpOut tests — the outbound `/command` POST boundary. `_router` (or the link
 * that owns it) delivers a single positional Message with TO already routed;
 * HttpOut POSTs it verbatim. The worker-attach `connect_worker_input` bundling
 * moved up into RemoteIpc, which asks `onceInBatch()` rather than sending it
 * every time, so HttpOut itself is dumb: POST what it's given, route every
 * synchronous reply back into its sink (replies route by TO now — there is no
 * `_sse` convergence node).
 */

import { HttpOutNode } from '../http-out-node';
import { byteLength } from '../io-telemetry';
import {
	newMessage,
	pack,
	TYPE,
	FROM,
	TO,
	VALUE,
	TM_COMMAND,
	TM_ERROR,
	TM_PING,
	TM_RESPONSE,
	TM_BYTESTREAM,
} from '../message';

function makeNode() {
	// Default: bare 202, no sync replies (routed-onward); tests override.
	const postBatch = jest.fn().mockResolvedValue( [] );
	const client = { postBatch };
	const node = new HttpOutNode();
	node.client = client;
	node.name = '_http';
	return { node, postBatch };
}

const batchOf = ( postBatch ) => {
	expect( postBatch ).toHaveBeenCalledTimes( 1 );
	return postBatch.mock.calls[ 0 ][ 0 ];
};

// Build the positional Message the router hands HttpOut (TO already routed).
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
		postBatch.mockResolvedValueOnce( [ reply ] ); // JSONL → Message array

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
		m[ TO ] = ''; // _router peeled _http, nothing follows → the boundary
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

		it( 'lives in the I/O palette category (draggable command egress)', () => {
			expect( HttpOutNode.nodeSchema().category ).toBe( 'I/O' );
		} );

		describe( 'lazy client default from the localized global (palette-drop path)', () => {
			afterEach( () => {
				delete window.NewspackNodesData;
				delete global.fetch;
			} );

			it( 'defaults its client from window.NewspackNodesData when none was assigned, then POSTs through it', async () => {
				window.NewspackNodesData = {
					restUrl: 'https://example.test/wp-json/',
					nonce: 'GNONCE',
				};
				global.fetch = jest
					.fn()
					.mockResolvedValue( { text: async () => '' } );
				const node = new HttpOutNode();
				node.name = '_http';
				// No client assigned: a fresh drop has no programmatic dependency.
				expect( node.client ).toBeNull();

				node.fill( routed( { to: 'demo.p0' } ) );
				await new Promise( ( r ) => setTimeout( r, 0 ) );

				expect( typeof node.client.postBatch ).toBe( 'function' );
				// The transport is closed over the localized base + nonce, so
				// the POST it made is the only place to read them back.
				expect( global.fetch ).toHaveBeenCalledWith(
					'https://example.test/wp-json/newspack-nodes/v1/command',
					expect.objectContaining( {
						headers: expect.objectContaining( {
							'X-WP-Nonce': 'GNONCE',
						} ),
					} )
				);
				expect( global.fetch ).toHaveBeenCalledTimes( 1 );
				const [ url, init ] = global.fetch.mock.calls[ 0 ];
				expect( url ).toBe(
					'https://example.test/wp-json/newspack-nodes/v1/command'
				);
				expect( init.headers[ 'X-WP-Nonce' ] ).toBe( 'GNONCE' );
			} );
		} );

		it( 'declares has_target:true (the wire-inbound clause reads it)', () => {
			expect( HttpOutNode.nodeSchema().has_target ).toBe( true );
		} );

		it( 'accepts the client as a public property and POSTs through it', () => {
			const postBatch = jest.fn().mockResolvedValue( [] );
			const client = { postBatch };
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

/**
 * Wire-inbound discipline, following Tachikoma Socket.pm:852-862. A reply is
 * TM_RESPONSE and self-routes by TO. Anything else arriving on the reply leg is
 * the remote addressing OUR graph, and `target` decides what that means:
 * unaddressed output belongs to the target, and an addressed non-response while
 * a target is set is the remote choosing its own destination — refused.
 */
describe( 'HttpOut wire-inbound clause', () => {
	afterEach( () => {
		const { Core } = require( '../core' );
		Core.reset();
	} );

	function replyWith( message ) {
		const { node } = makeNode();
		node.client.postBatch = jest.fn().mockResolvedValue( [ message ] );
		const seen = [];
		node.sink = { fill: ( m ) => seen.push( m ) };
		return { node, seen };
	}

	const bytestream = ( to = '' ) => {
		const m = newMessage();
		m[ TYPE ] = TM_BYTESTREAM;
		m[ TO ] = to;
		m[ VALUE ] = 'hello world';
		return m;
	};

	/** The `log` broadcast: minted unaddressed, dropped by _router until now. */
	it( 'stamps TO=target on an unaddressed non-response', async () => {
		const { node, seen } = replyWith( bytestream() );
		node.target = '_output';

		node.fill( routed( { to: 'topologies' } ) );
		await Promise.resolve();
		await Promise.resolve();

		expect( seen ).toHaveLength( 1 );
		expect( seen[ 0 ][ TO ] ).toBe( '_output' );
	} );

	// Mirrors HttpOutTest::test_on_curl_message_forwards_a_command_error_reply.
	it( 'forwards a command-error reply, as it does the success reply', async () => {
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND | TM_ERROR;
		m[ TO ] = 'settings-sync';
		m[ VALUE ] = { name: 'set', payload: 'unknown setting: x' };
		const { node, seen } = replyWith( m );
		node.target = '_output';

		node.fill( routed( { to: 'topologies' } ) );
		await Promise.resolve();
		await Promise.resolve();

		expect( seen ).toHaveLength( 1 );
		expect( seen[ 0 ][ TO ] ).toBe( 'settings-sync' );
	} );

	it( 'forwards a bare error reply, as it does a response', async () => {
		const m = newMessage();
		m[ TYPE ] = TM_ERROR;
		m[ TO ] = 'settings-sync';
		m[ VALUE ] = 'NOT_AVAILABLE';
		const { node, seen } = replyWith( m );
		node.target = '_output';

		node.fill( routed( { to: 'topologies' } ) );
		await Promise.resolve();
		await Promise.resolve();

		expect( seen ).toHaveLength( 1 );
		expect( seen[ 0 ][ TO ] ).toBe( 'settings-sync' );
	} );

	// Mirrors HttpOutTest::test_on_curl_message_stamps_an_undirected_error_onto_the_target.
	it( 'stamps an undirected error onto the target', async () => {
		const m = newMessage();
		m[ TYPE ] = TM_ERROR;
		m[ TO ] = '';
		m[ VALUE ] = 'NOT_AVAILABLE';
		const { node, seen } = replyWith( m );
		node.target = '_output';

		node.fill( routed( { to: 'topologies' } ) );
		await Promise.resolve();
		await Promise.resolve();

		expect( seen ).toHaveLength( 1 );
		expect( seen[ 0 ][ TO ] ).toBe( '_output' );
	} );

	it( 'refuses a non-response that addressed our graph itself', async () => {
		expectConsoleWarn(
			'_http: WARNING: message addressed while target is set'
		);
		const { node, seen } = replyWith(
			bytestream( '_command_interpreter' )
		);
		node.target = '_output';

		node.fill( routed( { to: 'topologies' } ) );
		await Promise.resolve();
		await Promise.resolve();

		expect( seen ).toEqual( [] );
	} );

	it( 'leaves a TM_RESPONSE to self-route by its own TO', async () => {
		const reply = bytestream( 'topologies:view' );
		reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
		const { node, seen } = replyWith( reply );
		node.target = '_output';

		node.fill( routed( { to: 'topologies' } ) );
		await Promise.resolve();
		await Promise.resolve();

		expect( seen ).toHaveLength( 1 );
		expect( seen[ 0 ][ TO ] ).toBe( 'topologies:view' );
	} );

	/** No target: neither arm engages, so existing graphs are untouched. */
	it( 'passes an unaddressed non-response through when no target is set', async () => {
		const { node, seen } = replyWith( bytestream() );

		node.fill( routed( { to: 'topologies' } ) );
		await Promise.resolve();
		await Promise.resolve();

		expect( seen ).toHaveLength( 1 );
		expect( seen[ 0 ][ TO ] ).toBe( '' );
	} );
} );

describe( 'HttpOut — an undelivered command', () => {
	beforeEach( () => {
		require( '../core' ).Core.reset();
	} );

	// A POST that never reached the substrate is a failure the minter must learn
	// about; silence is indistinguishable from a 202 routed onward, so a node
	// awaiting its reply would wait out its whole deadline instead.
	it( 'a failed POST answers each entry with a TM_ERROR addressed back to it', async () => {
		expectConsoleWarn( '_http: ERROR: HttpOut POST failed' );
		const { node, postBatch } = makeNode();
		postBatch.mockRejectedValue( new Error( 'NetworkError-8821' ) );
		const sent = [];
		node.sink = { fill: ( m ) => sent.push( m ) };

		node.fill(
			routed( {
				to: 'topologies',
				from: 'topologies:list',
				value: { name: 'list', arguments: [] },
			} )
		);
		await new Promise( ( r ) => setTimeout( r, 0 ) );

		expect( sent ).toHaveLength( 1 );
		expect( sent[ 0 ][ TYPE ] & TM_ERROR ).toBeTruthy();
		expect( sent[ 0 ][ TO ] ).toBe( 'topologies:list' );
		expect( String( sent[ 0 ][ VALUE ].payload ) ).toMatch(
			/NetworkError-8821/
		);
	} );

	it( 'a failed POST for an entry with no FROM answers nobody', async () => {
		// Distinct text: printLessOften suppresses a repeat within its window.
		expectConsoleWarn(
			'_http: ERROR: HttpOut POST failed: NetworkError-4417'
		);
		const { node, postBatch } = makeNode();
		postBatch.mockRejectedValue( new Error( 'NetworkError-4417' ) );
		const sent = [];
		node.sink = { fill: ( m ) => sent.push( m ) };

		node.fill(
			routed( { to: 'topologies', from: '', value: { name: 'list' } } )
		);
		await new Promise( ( r ) => setTimeout( r, 0 ) );

		expect( sent ).toEqual( [] );
	} );
} );

describe( 'HttpOut — a per-batch claim', () => {
	beforeEach( () => {
		require( '../core' ).Core.reset();
	} );

	it( 'still needs a key until it is claimed, then never again', () => {
		const { node } = makeNode();

		node.lock();

		expect( node.onceInBatch( 'mount:complete.p3' ) ).toBe( true );
		expect( node.onceInBatch( 'mount:complete.p3' ) ).toBe( true );
		node.claimInBatch( 'mount:complete.p3' );
		expect( node.onceInBatch( 'mount:complete.p3' ) ).toBe( false );
	} );

	it( 'keeps distinct keys independent within one batch', () => {
		const { node } = makeNode();

		node.lock();

		node.claimInBatch( 'mount:complete.p3' );

		expect( node.onceInBatch( 'mount:complete.p3' ) ).toBe( false );
		expect( node.onceInBatch( 'mount:aggregator.p7' ) ).toBe( true );
	} );

	it( 'grants the key again in the next batch', () => {
		const { node } = makeNode();

		node.lock();
		node.claimInBatch( 'mount:complete.p3' );
		node.flush();
		node.lock();

		expect( node.onceInBatch( 'mount:complete.p3' ) ).toBe( true );
	} );

	it( 'treats a re-lock inside an open one as the same batch', () => {
		const { node } = makeNode();

		node.lock();
		node.claimInBatch( 'mount:complete.p3' );
		node.lock();

		expect( node.onceInBatch( 'mount:complete.p3' ) ).toBe( false );
	} );
} );
