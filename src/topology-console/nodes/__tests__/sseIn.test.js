/**
 * SseIn node tests — the `_sse` console node. It is the runtime SseConnector
 * named for the console graph: opens an EventSource, snoops the `connected`
 * envelope for `pid()`, and fills each parsed positional Message into its sink
 * (`_router`, NOT the Dumper). A thin subclass so the published runtime keeps
 * its generic SseConnector primitive.
 */

import { SseIn } from '../sseIn';
import { SseConnector } from '../../../runtime/sse_connector';
import { Node } from '../../../runtime/node';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	KEY,
	VALUE,
	TM_INFO,
	TM_COMMAND,
} from '../../../runtime/message';
import names from '../../../runtime/reserved-node-names.json';

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
	global.EventSource = FakeEventSource;
} );

function makeSseIn() {
	const sse = new SseIn( {
		subscribe: [ 'demo.p0' ],
		baseUrl: '/wp-json/',
		nonce: 'NONCE',
	} );
	sse.name = '_sse'; // needed so the incoming-stamp breadcrumb has a name
	const router = new Node();
	const routed = [];
	router.fill = ( m ) => routed.push( m );
	sse.sink = router;
	return { sse, routed };
}

describe( 'SseIn', () => {
	it( 'is a SseConnector (the runtime primitive keeps its name)', () => {
		const { sse } = makeSseIn();
		expect( sse ).toBeInstanceOf( SseConnector );
	} );

	it( 'forwards each parsed SSE message into the sink (the router)', () => {
		const { sse, routed } = makeSseIn();
		sse.start();
		const m = newMessage();
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
} );
