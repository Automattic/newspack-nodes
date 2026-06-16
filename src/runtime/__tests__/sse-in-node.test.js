/**
 * SseInNode node tests — the `_sse` console node. It is the runtime SseConnector
 * named for the console graph: opens an EventSource, snoops the `connected`
 * envelope for `pid()`, and fills each parsed positional Message into its sink
 * (`_router`, NOT the Dumper). A thin subclass so the published runtime keeps
 * its generic SseConnector primitive.
 */

import { SseInNode } from '../sse-in-node';
import { SseConnectorNode } from '../sse-connector-node';
import { Node } from '../node';
import { Core } from '../core';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	KEY,
	VALUE,
	TM_INFO,
	TM_COMMAND,
	TM_BYTESTREAM,
} from '../message';
import names from '../reserved-node-names.json';

class FakeEventSource {
	constructor( url ) {
		this.url = url;
		this.listeners = {};
		FakeEventSource.last = this;
	}
	addEventListener( name, cb ) {
		( this.listeners[ name ] ||= [] ).push( cb );
	}
	close() {
		this.closed = true;
	}
	dispatch( name, data ) {
		( this.listeners[ name ] || [] ).forEach( ( cb ) => cb( { data } ) );
	}
}

beforeEach( () => {
	Core.reset();
	global.EventSource = FakeEventSource;
} );

function makeSseIn() {
	const sse = new SseInNode();
	sse.name = '_sse'; // needed so the incoming-stamp breadcrumb has a name
	sse.arguments = 'demo.p0 /wp-json/ NONCE';
	const router = new Node();
	const routed = [];
	router.fill = ( m ) => routed.push( m );
	sse.sink = router;
	return { sse, routed };
}

describe( 'SseInNode', () => {
	it( 'is a SseConnector (the runtime primitive keeps its name)', () => {
		const { sse } = makeSseIn();
		expect( sse ).toBeInstanceOf( SseConnectorNode );
	} );

	it( 'forwards each parsed SSE message into the sink (the router)', () => {
		const { sse, routed } = makeSseIn();
		sse.start();
		const m = newMessage();
		m[ TYPE ] = TM_BYTESTREAM;
		m[ VALUE ] = 'data line';
		FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
		expect( routed ).toHaveLength( 1 );
		expect( routed[ 0 ][ VALUE ] ).toBe( 'data line' );
	} );

	it( 'snoops the connected envelope so pid() reads it back', () => {
		const { sse } = makeSseIn();
		sse.start();
		const m = newMessage();
		m[ TYPE ] = TM_INFO;
		m[ KEY ] = 'connected';
		m[ VALUE ] = { pid: 4242, slot: 1 };
		FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
		expect( sse.pid() ).toBe( 4242 );
	} );

	it( 'opens the EventSource against /messages/stream with the subscription', () => {
		const { sse } = makeSseIn();
		sse.start();
		expect( FakeEventSource.last.url ).toContain(
			'newspack-nodes/v1/messages/stream'
		);
		expect( FakeEventSource.last.url ).toContain( 'subscribe=demo.p0' );
	} );

	// Outgoing leg: a command routed in via TO=_sse/… (head already peeled).
	it( 'wraps an outgoing reply-node FROM into the private pivot and prepends _http to TO', () => {
		const { sse, routed } = makeSseIn();
		sse.start();
		sse.setState( 'connected', { pid: 4242, slot: 1 } ); // so pid() resolves
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = names.OUTPUT;
		m[ TO ] = 'firehose-workers.p0';
		sse.fill( m );
		expect( routed[ 0 ][ FROM ] ).toBe(
			`${ names.SSE }:4242/${ names.OUTPUT }`
		);
		expect( routed[ 0 ][ TO ] ).toBe(
			`${ names.HTTP }/firehose-workers.p0`
		);
	} );

	it( 'wraps an outgoing _completion FROM into the private pivot (tab-completion query)', () => {
		const { sse, routed } = makeSseIn();
		sse.start();
		sse.setState( 'connected', { pid: 4242, slot: 1 } );
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = names.COMPLETION;
		m[ TO ] = 'firehose-workers.p0';
		sse.fill( m );
		expect( routed[ 0 ][ FROM ] ).toBe(
			`${ names.SSE }:4242/${ names.COMPLETION }`
		);
		expect( routed[ 0 ][ TO ] ).toBe(
			`${ names.HTTP }/firehose-workers.p0`
		);
	} );

	it( 'wraps an outgoing _heartbeat FROM into the private pivot (slot poke)', () => {
		const { sse, routed } = makeSseIn();
		sse.start();
		sse.setState( 'connected', { pid: 4242, slot: 1 } );
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = names.HEARTBEAT;
		m[ TO ] = 'workers';
		sse.fill( m );
		expect( routed[ 0 ][ FROM ] ).toBe(
			`${ names.SSE }:4242/${ names.HEARTBEAT }`
		);
		expect( routed[ 0 ][ TO ] ).toBe( `${ names.HTTP }/workers` );
	} );

	it( 'routes an incoming reply by TO and stamps the _sse provenance breadcrumb', () => {
		const { sse, routed } = makeSseIn();
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = '_command_interpreter';
		m[ TO ] = names.OUTPUT;
		sse.fill( m );
		expect( routed[ 0 ][ FROM ] ).toBe( '_sse/_command_interpreter' );
		expect( routed[ 0 ][ TO ] ).toBe( names.OUTPUT );
	} );

	it( 'strips its own _sse:{pid} head from an intaken POST reply, then routes', () => {
		const { sse, routed } = makeSseIn();
		sse.start();
		sse.setState( 'connected', { pid: 4242, slot: 1 } );
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = '_command_interpreter';
		m[ TO ] = `${ names.SSE }:4242/${ names.METADATA }`; // unstripped (synchronous POST)
		sse.fill( m );
		expect( routed[ 0 ][ TO ] ).toBe( names.METADATA );
	} );

	describe( 'no-arg ctor + schema-driven arguments', () => {
		it( 'constructs with no args (deps come via arguments=)', () => {
			const sse = new SseInNode();
			expect( sse.subscribe ).toEqual( [] );
			expect( sse.baseUrl ).toBe( '' );
			expect( sse.nonce ).toBe( '' );
		} );

		it( 'inherits the SseConnector schema (subscribe/baseUrl/nonce)', () => {
			const schema = SseInNode.nodeSchema();
			expect( schema.arguments.map( ( a ) => a.name ) ).toEqual( [
				'subscribe',
				'baseUrl',
				'nonce',
			] );
		} );

		// accepts_fill is a UI wireability hint, not a claim about the runtime fill().
		// _sse HAS a fill() (it's bidirectional), but you can't drag a connection into
		// it in the editor (pivoting cwd onto _sse shows the other leg), so it's false.
		it( 'declares accepts_fill:false (not a drag-into target despite a runtime fill)', () => {
			expect( SseInNode.nodeSchema().accepts_fill ).toBe( false );
		} );

		it( 'declares has_target:true (_sse forwards the outgoing/reply leg)', () => {
			expect( SseInNode.nodeSchema().has_target ).toBe( true );
		} );

		it( 'arguments= parses three tokens; subscribe becomes the comma-split array', () => {
			const sse = new SseInNode();
			sse.arguments = 'demo.p0,demo.p1 /wp-json/ NONCE';
			expect( sse.subscribe ).toEqual( [ 'demo.p0', 'demo.p1' ] );
			expect( sse.baseUrl ).toBe( '/wp-json/' );
			expect( sse.nonce ).toBe( 'NONCE' );
		} );

		it( 'arguments getter returns the raw string (dump_config round-trip)', () => {
			const sse = new SseInNode();
			sse.arguments = 'demo.p0 /wp-json/ NONCE';
			expect( sse.arguments ).toBe( 'demo.p0 /wp-json/ NONCE' );
		} );

		it( 'opens the EventSource using arguments-assigned config', () => {
			const sse = new SseInNode();
			sse.name = '_sse';
			sse.arguments = 'demo.p0 /wp-json/ NONCE';
			sse.start();
			expect( FakeEventSource.last.url ).toContain(
				'newspack-nodes/v1/messages/stream'
			);
			expect( FakeEventSource.last.url ).toContain( 'subscribe=demo.p0' );
		} );
	} );
} );
