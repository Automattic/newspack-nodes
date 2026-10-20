/**
 * HttpOut tests — the outbound `/command` POST boundary. `_router` (or the link
 * that owns it) delivers a single positional Message with TO already routed;
 * HttpOut POSTs it verbatim, one batch per task. The worker-attach
 * `connect_worker_input` bundling lives in RemoteIpc, which asks
 * `onceInBatch()` rather than sending it every time, so HttpOut itself is
 * dumb: POST what it's given, route every synchronous reply back into its
 * sink (replies route by TO).
 */

import { nextTask } from '@newspack-nodes/shared/test-utils/nextTask';
import { HttpOutNode } from '../http-out-node';
import { MAX_FROM_SIZE } from '../node';
import names from '../reserved-node-names.json';
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

const inboundFrom = async ( from, type = TM_RESPONSE ) => {
	const { node, postBatch } = makeNode();
	const reply = newMessage();
	reply[ TYPE ] = type;
	reply[ FROM ] = from;
	reply[ TO ] = '_output';
	postBatch.mockResolvedValue( [ reply ] );
	const sink = { fill: jest.fn() };
	node.sink = sink;
	const out = newMessage();
	out[ TYPE ] = TM_COMMAND;
	out[ TO ] = 'foo';
	node.fill( out );
	await nextTask();
	return { sink, batch: postBatch.mock.calls[ 0 ]?.[ 0 ] };
};

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

// A command pack() refuses: JSON has no BigInt.
function unpackableAsk( id ) {
	return routed( {
		to: 'insights',
		from: `${ id }:ask`,
		value: {
			name: 'dump_url',
			arguments: [ id ],
			offset: 9007199254740993n,
		},
	} );
}

describe( 'HttpOut', () => {
	afterEach( () => {
		const { Core } = require( '../core' );
		Core.reset();
	} );

	it( 'records bytesWritten + largestMsgSent for the packed POST body', async () => {
		const { node } = makeNode();
		const m = routed( {
			to: 'echo',
			value: { name: 'tell', arguments: 'hi' },
		} );
		const size = byteLength( pack( m ) );
		node.fill( m );
		await nextTask();
		expect( node.bytesWritten ).toBe( size );
		expect( node.largestMsgSent ).toBe( size );
	} );

	it( 'records bytesRead for each reply Message returned by the POST (read boundary)', async () => {
		const { node, postBatch } = makeNode();
		const reply = routed( {
			to: '_output/1',
			value: { name: 'r', arguments: 'ok' },
		} );
		// Measured BEFORE intake: the read boundary counts what came off the
		// wire, and intake stamps this transport's name onto FROM in place.
		const onTheWire = byteLength( pack( reply ) );
		postBatch.mockResolvedValue( [ reply ] );
		node.fill( routed( { to: 'demo.p0' } ) );
		await nextTask();
		expect( node.bytesRead ).toBe( onTheWire );
	} );

	it( 'packs each message once and hands the packed lines to postBatch (no double-serialize)', async () => {
		const { node, postBatch } = makeNode();
		const m = routed( { to: 'demo.p0' } );
		node.fill( m );
		await nextTask();
		// Second arg is the pre-packed JSONL lines — postBatch must reuse them.
		expect( postBatch.mock.calls[ 0 ][ 1 ] ).toEqual( [ pack( m ) ] );
	} );

	it( 'POSTs the routed Message verbatim (no connect_worker_input prepend)', async () => {
		const { node, postBatch } = makeNode();
		node.fill( routed( { to: 'demo.p0' } ) );
		await nextTask();
		const batch = batchOf( postBatch );
		expect( batch ).toHaveLength( 1 );
		expect( batch[ 0 ][ TO ] ).toBe( 'demo.p0' );
		expect( batch[ 0 ][ VALUE ].name ).toBe( 'ls' );
	} );

	it( 'POSTs a server-CI target (workers) verbatim', async () => {
		const { node, postBatch } = makeNode();
		node.fill(
			routed( {
				to: 'workers',
				from: '_http/_sse:c0ffee09c0ffee09c0ffee09c0ffee09/_heartbeat',
				value: { name: 'heartbeat', arguments: '1 10 0' },
			} )
		);
		await nextTask();
		const batch = batchOf( postBatch );
		expect( batch ).toHaveLength( 1 );
		expect( batch[ 0 ][ TO ] ).toBe( 'workers' );
		expect( batch[ 0 ][ VALUE ].name ).toBe( 'heartbeat' );
	} );

	it( 'leaves the reply FROM untouched', async () => {
		const { node, postBatch } = makeNode();
		node.fill( routed( { to: 'demo.p0', from: '_http/555/_metadata' } ) );
		await nextTask();
		const batch = batchOf( postBatch );
		expect( batch[ 0 ][ FROM ] ).toBe( '_http/555/_metadata' );
	} );

	it( 'forwards a TM_PING positional message verbatim (no re-typing)', async () => {
		const { node, postBatch } = makeNode();
		node.fill(
			routed( { to: 'demo.p0', type: TM_PING, value: 1700000000.5 } )
		);
		await nextTask();
		const batch = batchOf( postBatch );
		expect( batch[ 0 ][ TYPE ] ).toBe( TM_PING );
		expect( batch[ 0 ][ VALUE ] ).toBe( 1700000000.5 );
	} );

	it( 'fill() is fire-and-forget (returns nothing) and still POSTs', async () => {
		const { node, postBatch } = makeNode();
		postBatch.mockResolvedValueOnce( [] ); // bare 202 → no reply Messages
		const out = node.fill( routed( { to: 'demo.p0' } ) );
		expect( out ).toBeUndefined();
		await nextTask();
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

		node.fill( routed( { to: '' } ) ); // bare POST
		await nextTask();

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

		node.fill( routed( { to: '' } ) );
		await nextTask();

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
		node.fill( routed( { to: 'demo.p0' } ) );
		await nextTask();

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

	it( 'sends from one task ride one POST on the next task', async () => {
		const { node, postBatch } = makeNode();
		const ask = ( verb ) =>
			routed( {
				to: 'insights',
				from: 'url:fetch',
				value: { name: verb, arguments: [ 'kea-5521' ] },
			} );

		node.fill( ask( 'dump_url' ) );
		node.fill( ask( 'query' ) );
		expect( postBatch ).not.toHaveBeenCalled();

		await nextTask();
		expect( batchOf( postBatch ).map( ( m ) => m[ VALUE ].name ) ).toEqual(
			[ 'dump_url', 'query' ]
		);
		expect( node.locked ).toBe( false );
	} );

	it( 'a send outside a tick joins a tick in the same task', async () => {
		const { RouterNode } = require( '../router-node' );
		const { Core } = require( '../core' );
		const router = new RouterNode();
		router.name = names.ROUTER;
		// Only the asked-for tick: a grid boundary passing must add none.
		router.stopTimer();
		const { node, postBatch } = makeNode();
		const timer = {
			name: 'rules:timer',
			fireCb: () =>
				node.fill(
					routed( {
						to: 'rules',
						from: 'rules:fetch',
						value: { name: 'dump_rules', arguments: [] },
					} )
				),
		};
		router.registrations.TIMER = { [ timer.name ]: true };
		Core.registerNode( timer.name, timer );

		node.fill(
			routed( {
				to: 'insights',
				from: 'url:fetch',
				value: { name: 'dump_url', arguments: [ 'ruru-7731' ] },
			} )
		);
		router.requestTick();

		await nextTask();
		expect( batchOf( postBatch ).map( ( m ) => m[ VALUE ].name ) ).toEqual(
			[ 'dump_url', 'dump_rules' ]
		);

		await nextTask();
		expect( postBatch ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'a held send leaves on the next task even while timers stand still', async () => {
		// A hidden tab throttles a 0ms timer; fake timers hold one outright.
		jest.useFakeTimers();
		try {
			const { node, postBatch } = makeNode();
			node.fill(
				routed( {
					to: 'insights',
					from: 'kahu:fetch',
					value: { name: 'dump_url', arguments: [ 'kahu-6612' ] },
				} )
			);

			await nextTask();
			expect( batchOf( postBatch )[ 0 ][ VALUE ] ).toEqual( {
				name: 'dump_url',
				arguments: [ 'kahu-6612' ],
			} );
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'removeNode posts what it still holds', async () => {
		const { node, postBatch } = makeNode();
		node.fill(
			routed( {
				to: 'insights',
				from: 'url:fetch',
				value: { name: 'forget_url', arguments: [ 'tui-8830' ] },
			} )
		);
		expect( postBatch ).not.toHaveBeenCalled();

		node.removeNode();
		expect( batchOf( postBatch ).map( ( m ) => m[ VALUE ] ) ).toEqual( [
			{ name: 'forget_url', arguments: [ 'tui-8830' ] },
		] );

		await nextTask();
		expect( postBatch ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'a message that will not pack fails alone', async () => {
		const { node, postBatch } = makeNode();
		const answered = [];
		node.sink = { fill: ( m ) => answered.push( m ) };
		const unpackable = unpackableAsk( 'ruru-7731' );
		const packable = routed( {
			to: 'insights',
			from: 'kea-5521:ask',
			value: { name: 'query', arguments: [ 'kea-5521' ] },
		} );

		await expect( node._post( [ unpackable, packable ] ) ).rejects.toThrow(
			/BigInt/
		);

		expect( batchOf( postBatch ) ).toEqual( [ packable ] );
		expect( answered ).toHaveLength( 1 );
		expect( answered[ 0 ][ TYPE ] ).toBe( TM_COMMAND | TM_ERROR );
		expect( answered[ 0 ][ TO ] ).toBe( 'ruru-7731:ask' );
		expect( answered[ 0 ][ VALUE ] ).toEqual(
			expect.objectContaining( {
				name: 'dump_url',
				arguments: [ 'ruru-7731' ],
				undelivered: true,
			} )
		);
	} );

	it( 'a batch of nothing but unpackable messages rejects with the pack error itself', async () => {
		const { node, postBatch } = makeNode();
		node.sink = { fill: () => {} };

		const rejected = node._post( [ unpackableAsk( 'moa-2208' ) ] );

		await expect( rejected ).rejects.toBeInstanceOf( TypeError );
		await expect( rejected ).rejects.toThrow( /BigInt/ );
		expect( postBatch ).not.toHaveBeenCalled();
	} );

	it( 'an empty batch settles, posting nothing', async () => {
		const { node, postBatch } = makeNode();

		const settled = await Promise.race( [
			node._post( [] ).then( () => 'settled-4417' ),
			nextTask().then( () => 'pending' ),
		] );

		expect( settled ).toBe( 'settled-4417' );
		expect( postBatch ).not.toHaveBeenCalled();
	} );

	it( "raises what a receiver throws on an unpackable message's refusal", async () => {
		const { node } = makeNode();
		node.sink = {
			fill: () => {
				throw new Error( 'transcript refused kea-3390' );
			},
		};
		const packable = routed( {
			to: 'insights',
			from: 'kea-3390:ask',
			value: { name: 'query', arguments: [ 'kea-3390' ] },
		} );

		const rejected = node._post( [
			unpackableAsk( 'kea-3390' ),
			packable,
		] );

		await expect( rejected ).rejects.toBeInstanceOf( AggregateError );
		await expect( rejected ).rejects.toMatchObject( {
			errors: [
				expect.any( TypeError ),
				expect.objectContaining( {
					message: 'transcript refused kea-3390',
				} ),
			],
		} );
	} );

	it( 'removeNode leaves nothing to post once the node is gone', async () => {
		expectConsoleWarn( 'WARNING: node removed' );
		const { node, postBatch } = makeNode();
		const resent = routed( {
			to: 'insights',
			from: 'tui-4410:ask',
			value: { name: 'dump_url', arguments: [ 'tui-4410' ] },
		} );
		// A minter answering its refusal by asking again, mid-teardown.
		node.sink = { fill: () => node.fill( resent ) };
		const posts = [];
		const post = node._post.bind( node );
		node._post = ( batch ) => {
			posts.push( post( batch ) );
			return posts.at( -1 );
		};
		node.fill( unpackableAsk( 'tui-4410' ) );

		node.removeNode();
		await expect( posts[ 0 ] ).rejects.toThrow( /BigInt/ );
		await nextTask();

		expect( posts ).toHaveLength( 1 );
		expect( postBatch ).not.toHaveBeenCalled();
		expect( node.buffer ).toEqual( [] );
	} );

	it( 'Core.reset() cancels a flush still held', async () => {
		const { Core } = require( '../core' );
		const { node, postBatch } = makeNode();
		node.fill(
			routed( {
				to: 'insights',
				from: 'pou-5157:ask',
				value: { name: 'dump_url', arguments: [ 'pou-5157' ] },
			} )
		);
		expect( Core.node( '_http' ) ).toBe( node );

		Core.reset();
		await nextTask();

		expect( postBatch ).not.toHaveBeenCalled();
	} );

	it( 'POSTs the bare command when addressed to _http itself (cd /_http)', async () => {
		const { node, postBatch } = makeNode();
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ TO ] = ''; // _router peeled _http, nothing follows → the boundary
		m[ VALUE ] = { name: 'ls', arguments: '' };
		node.fill( m );
		await nextTask();
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

			node.fill( routed( { to: '' } ) );
			await nextTask();

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
					await nextTask();
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
				await nextTask();

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

		it( 'accepts the client as a public property and POSTs through it', async () => {
			const postBatch = jest.fn().mockResolvedValue( [] );
			const client = { postBatch };
			const node = new HttpOutNode();
			node.client = client;
			node.name = '_http';
			node.fill( routed( { to: 'demo.p0' } ) );
			await nextTask();
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
			await nextTask();
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

	/** The `log` broadcast: minted unaddressed, so _router drops it untargeted. */
	it( 'stamps TO=target on an unaddressed non-response', async () => {
		const { node, seen } = replyWith( bytestream() );
		node.target = '_output';

		node.fill( routed( { to: 'topologies' } ) );
		await nextTask();

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
		await nextTask();

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
		await nextTask();

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
		await nextTask();

		expect( seen ).toHaveLength( 1 );
		expect( seen[ 0 ][ TO ] ).toBe( '_output' );
	} );

	it( 'delivers a non-response addressed to its own target', async () => {
		const { node, seen } = replyWith( bytestream( '_output' ) );
		node.target = '_output';

		node.fill( routed( { to: 'raw-logs' } ) );
		await nextTask();

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
		await nextTask();

		expect( seen ).toEqual( [] );
	} );

	it( 'leaves a TM_RESPONSE to self-route by its own TO', async () => {
		const reply = bytestream( 'topologies:view' );
		reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
		const { node, seen } = replyWith( reply );
		node.target = '_output';

		node.fill( routed( { to: 'topologies' } ) );
		await nextTask();

		expect( seen ).toHaveLength( 1 );
		expect( seen[ 0 ][ TO ] ).toBe( 'topologies:view' );
	} );

	/** No target: neither arm engages, so existing graphs are untouched. */
	it( 'passes an unaddressed non-response through when no target is set', async () => {
		const { node, seen } = replyWith( bytestream() );

		node.fill( routed( { to: 'topologies' } ) );
		await nextTask();

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
				value: { name: 'dump', arguments: [] },
			} )
		);
		await nextTask();

		expect( sent ).toHaveLength( 1 );
		expect( sent[ 0 ][ TYPE ] & TM_ERROR ).toBeTruthy();
		expect( sent[ 0 ][ TO ] ).toBe( 'topologies:list' );
		expect( String( sent[ 0 ][ VALUE ].payload ) ).toMatch(
			/NetworkError-8821/
		);
	} );

	// A receiver that throws is not a POST that failed: every other reply in
	// the batch still lands, no minter is told its command went undelivered,
	// and the receiver's failure escapes the delivery rather than vanishing.
	it( 'delivers the rest of a batch past a receiver that throws, then raises', async () => {
		const { node, postBatch } = makeNode();
		const replies = [ 'fetch:a', 'fetch:b' ].map( ( to ) => {
			const reply = newMessage();
			reply[ TYPE ] = TM_RESPONSE;
			reply[ TO ] = to;
			return reply;
		} );
		postBatch.mockResolvedValue( replies );
		const failure = new Error( 'view parse failed 3141' );
		const delivered = [];
		node.sink = {
			fill: ( m ) => {
				if ( 'fetch:a' === m[ TO ] ) {
					throw failure;
				}
				delivered.push( m );
			},
		};

		await expect(
			node._post( [ routed( { to: 'topologies', from: 'fetch:a' } ) ] )
		).rejects.toBe( failure );

		expect( delivered.map( ( m ) => m[ TO ] ) ).toEqual( [ 'fetch:b' ] );
		expect( delivered.every( ( m ) => ! ( m[ TYPE ] & TM_ERROR ) ) ).toBe(
			true
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
			routed( { to: 'topologies', from: '', value: { name: 'dump' } } )
		);
		await nextTask();

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

/**
 * An error crosses the wire like anything else, a Router bounce included: a
 * remote sender learns its message never routed only by receiving one.
 *
 * The loop this once guarded against is closed where the bounce is born —
 * `RouterNode.fill()` returns on a message that is already an error rather
 * than minting a second one, so the far side answers a bounce with nothing.
 */
describe( 'outbound errors', () => {
	beforeEach( () => {
		const { Core } = require( '../core' );
		Core.reset();
	} );
	afterEach( () => {
		const { Core } = require( '../core' );
		Core.reset();
	} );

	it( 'POSTs a Router bounce like any message', async () => {
		const { node, postBatch } = makeNode();
		const bounce = newMessage();
		bounce[ TYPE ] = TM_ERROR;
		bounce[ FROM ] = names.ROUTER;
		bounce[ TO ] = '';
		bounce[ VALUE ] = 'NOT_AVAILABLE\n';

		node.fill( bounce );
		await nextTask();

		expect( postBatch ).toHaveBeenCalledTimes( 1 );
	} );

	// An operator can set the error flag deliberately from Compose; that is a
	// command like any other, and so is a bounce.
	it( 'still POSTs an operator-composed error', async () => {
		const { node, postBatch } = makeNode();
		const composed = newMessage();
		composed[ TYPE ] = TM_COMMAND | TM_ERROR;
		composed[ FROM ] = '_output';
		composed[ TO ] = 'foo';

		node.fill( composed );
		await nextTask();

		expect( postBatch ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'still POSTs an ordinary command', async () => {
		const { node, postBatch } = makeNode();
		const out = newMessage();
		out[ TYPE ] = TM_COMMAND;
		out[ TO ] = 'foo';

		node.fill( out );
		await nextTask();

		expect( postBatch ).toHaveBeenCalledTimes( 1 );
	} );
} );

describe( 'the ERRORS tile', () => {
	const { IoTelemetry } = require( '../io-telemetry' );
	const { Core } = require( '../core' );

	// makeNode() registers `_http`; a second would collide on the live table.
	beforeEach( () => Core.reset() );
	afterEach( () => Core.reset() );

	// Drive one reply of the caller's shape through the node, return the ring.
	const tallyOf = async ( shape ) => {
		const { node, postBatch } = makeNode();
		const reply = newMessage();
		reply[ TYPE ] = TM_COMMAND | TM_ERROR;
		reply[ FROM ] = 'spoke-4471';
		reply[ TO ] = '_output';
		reply[ VALUE ] = shape;
		postBatch.mockResolvedValue( [ reply ] );
		node.sink = { fill: jest.fn() };
		IoTelemetry.clear();
		const out = newMessage();
		out[ TYPE ] = TM_COMMAND;
		out[ TO ] = 'foo';
		node.fill( out );
		await nextTask();
		return IoTelemetry.snapshot();
	};

	/**
	 * The FROM is stamped by the time this runs, which is why the tally lives
	 * here and not at the wire: the TO is whoever ASKED, our own `_output` on
	 * every one of these.
	 */
	it( 'names the failing node and the command, and quotes the diagnosis', async () => {
		const snap = await tallyOf( {
			name: 'topology',
			arguments: [ 'activate', 'combined' ],
			payload: 'no such topology\n',
		} );

		expect( snap.errors ).toBe( 1 );
		expect( snap.messages[ 0 ].text ).toBe(
			'_http/spoke-4471: topology activate combined: no such topology'
		);
	} );

	it( 'quotes a bare-string diagnosis under the node that sent it', async () => {
		const snap = await tallyOf( 'NOT_AVAILABLE: no slot 0 lease' );

		expect( snap.messages[ 0 ].text ).toBe(
			'_http/spoke-4471: NOT_AVAILABLE: no slot 0 lease'
		);
	} );

	/**
	 * `payload` is the interpreter's word. An intermediary answering
	 * `{ code, message }` would otherwise render as a bare node name with the
	 * diagnosis dropped — a textless row is a count with nothing to read.
	 */
	it( 'keeps the diagnosis when the VALUE is not a command envelope', async () => {
		const snap = await tallyOf( {
			code: 'rest_forbidden',
			message: 'no lease',
		} );

		expect( snap.messages[ 0 ].text ).toContain( 'rest_forbidden' );
	} );

	/**
	 * A malformed `arguments` must not take the whole batch down: a spread
	 * throwing inside the reply loop would let the catch answer EVERY command
	 * with "Command not delivered" and drop the server's real replies.
	 */
	it( 'survives a reply whose arguments are not a list', async () => {
		const snap = await tallyOf( {
			name: 'topology',
			arguments: 5,
			payload: 'no such topology',
		} );

		expect( snap.messages[ 0 ].text ).toBe(
			'_http/spoke-4471: topology: no such topology'
		);
	} );

	/**
	 * A refusal the TRANSPORT fabricated is the POST failing, which `post()`
	 * already reports once, rate-limited. Tallying it here as well put one row
	 * per command in the batch under a single HTTP failure.
	 */
	it( 'leaves a fabricated refusal to the one line post() already logs', async () => {
		const snap = await tallyOf( {
			name: 'topology',
			arguments: [],
			payload: 'Command refused (HTTP 401 rest_forbidden)',
			undelivered: true,
		} );

		expect( snap.errors ).toBe( 0 );
		expect( snap.messages ).toEqual( [] );
	} );

	// The heartbeat judges its own refusals and logs the ones that matter, so
	// counting them here too put the expected per-reconnect race on the tile.
	it( 'leaves the heartbeat to judge its own refusals', async () => {
		const { node, postBatch } = makeNode();
		const reply = newMessage();
		reply[ TYPE ] = TM_COMMAND | TM_ERROR;
		reply[ FROM ] = 'spoke-4471';
		reply[ TO ] = names.HEARTBEAT;
		reply[ VALUE ] = 'SSE slot lease not owned: slot_released';
		postBatch.mockResolvedValue( [ reply ] );
		node.sink = { fill: jest.fn() };
		IoTelemetry.clear();
		const out = newMessage();
		out[ TYPE ] = TM_COMMAND;
		out[ TO ] = 'foo';
		node.fill( out );
		await nextTask();

		expect( IoTelemetry.snapshot().errors ).toBe( 0 );
	} );
} );

describe( 'inbound FROM stamping', () => {
	beforeEach( () => {
		const { Core } = require( '../core' );
		Core.reset();
	} );

	afterEach( () => {
		const { Core } = require( '../core' );
		Core.reset();
	} );

	// Tachikoma Socket.pm:853 — a transport prefixes its own name onto the FROM
	// of everything it brings IN, so the address is a path back out through it.
	// Without it a reply from `foo` reads as bare `foo`, which names a node this
	// browser does not have and cannot route to.
	it( 'stamps its name onto a response coming back from the server', async () => {
		const { sink } = await inboundFrom( 'foo' );

		expect( sink.fill ).toHaveBeenCalledTimes( 1 );
		expect( sink.fill.mock.calls[ 0 ][ 0 ][ FROM ] ).toBe( '_http/foo' );
	} );

	it( 'stamps an error reply the same way', async () => {
		const { sink } = await inboundFrom( 'foo', TM_ERROR );

		expect( sink.fill.mock.calls[ 0 ][ 0 ][ FROM ] ).toBe( '_http/foo' );
	} );

	it( 'is its own name when the server sent no FROM', async () => {
		const { sink } = await inboundFrom( '' );

		expect( sink.fill.mock.calls[ 0 ][ 0 ][ FROM ] ).toBe( '_http' );
	} );

	it( 'leaves a request going OUT unstamped', async () => {
		// The stamp is a return path, and an outbound command has not been
		// anywhere yet — stamping it would address the server to our own node.
		const { batch } = await inboundFrom( 'foo' );

		expect( batch[ 0 ][ FROM ] ).not.toContain( '_http' );
	} );

	/**
	 * Through `stampMessage`, like every other transport that stamps — the
	 * sibling is `RemoteLink`. Its two guards are the point: a reply looping
	 * hub → spoke → hub grows its path without bound, and the Router would
	 * drop it a layer later naming no transport, where the guard names this
	 * one at the boundary that overflowed it.
	 */
	it( 'drops a reply whose stamped path would exceed MAX_FROM_SIZE', async () => {
		expectConsoleWarn( '_http: ERROR: path exceeded' );
		const { sink } = await inboundFrom( 'x'.repeat( MAX_FROM_SIZE ) );

		expect( sink.fill ).not.toHaveBeenCalled();
	} );

	/**
	 * A node torn down while its POST was in flight has no name, no sink and
	 * no registration — `removeNode()` clears all three. That is a lifecycle
	 * race, not the programming error `stampMessage` reports, so the reply is
	 * dropped where it belongs: at the top of the loop, before anything tries
	 * to stamp or route it.
	 */
	it( 'drops replies that land after the node was removed, silently', async () => {
		const { node, postBatch } = makeNode();
		const reply = newMessage();
		reply[ TYPE ] = TM_RESPONSE;
		reply[ FROM ] = 'foo';
		reply[ TO ] = '_output';
		let land;
		postBatch.mockReturnValue(
			new Promise( ( res ) => ( land = () => res( [ reply ] ) ) )
		);
		const sink = { fill: jest.fn() };
		node.sink = sink;
		const out = newMessage();
		out[ TYPE ] = TM_COMMAND;
		out[ TO ] = 'foo';
		node.fill( out );
		await nextTask();
		node.removeNode();
		land();
		await nextTask();

		expect( sink.fill ).not.toHaveBeenCalled();
	} );
} );
