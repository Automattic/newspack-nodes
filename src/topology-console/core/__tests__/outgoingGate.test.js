import { OutgoingGateNode } from '../outgoingGate';
import { Core } from '../../../runtime/core';
import { Node } from '../../../runtime/node';
import {
	newMessage,
	TYPE,
	TO,
	VALUE,
	TM_COMMAND,
} from '../../../runtime/message';

// A TM_COMMAND for `verb`, addressed at `to`.
function cmd( to, verb = 'ls' ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ TO ] = to;
	m[ VALUE ] = { name: verb, arguments: [] };
	return m;
}

function makeGate() {
	const sink = new Node();
	const filled = [];
	sink.fill = ( m ) => filled.push( m );
	const gate = new OutgoingGateNode();
	gate.sink = sink;
	return { gate, filled };
}

describe( 'OutgoingGateNode', () => {
	it( 'forwards to its sink with nothing configured', () => {
		const { gate, filled } = makeGate();
		gate.fill( cmd( 'demo.p0' ) );
		expect( filled ).toHaveLength( 1 );
	} );

	it( 'reads connected only once a sink is wired', () => {
		const gate = new OutgoingGateNode();
		expect( gate.connected ).toBe( false );
		gate.sink = new Node();
		expect( gate.connected ).toBe( true );
	} );

	it( 'stays unnamed, so no message can be addressed to it', () => {
		const { gate } = makeGate();
		expect( gate.name ).toBe( '' );
		expect( Core.node( '' ) ).toBeNull();
	} );

	it( 'tells onForward about each forwarded message before its sink', () => {
		const order = [];
		const gate = new OutgoingGateNode();
		gate.sink = { fill: ( m ) => order.push( `sink:${ m[ TO ] }` ) };
		gate.onForward = ( m ) => order.push( `tap:${ m[ VALUE ].name }` );
		gate.fill( cmd( 'demo.p7', 'make_node' ) );
		expect( order ).toEqual( [ 'tap:make_node', 'sink:demo.p7' ] );
	} );

	it( 'announces a message even when its sink throws, which may have run it', () => {
		const gate = new OutgoingGateNode();
		gate.sink = {
			fill: () => {
				throw new Error( 'tap copy failed after the passthrough' );
			},
		};
		const seen = [];
		gate.onForward = ( m ) => seen.push( m[ VALUE ].name );
		expect( () => gate.fill( cmd( 'demo.p7', 'make_node' ) ) ).toThrow(
			'tap copy failed'
		);
		expect( seen ).toEqual( [ 'make_node' ] );
	} );

	it( 'drops a message the sseGuard refuses, and says so', () => {
		const { gate, filled } = makeGate();
		let refused = 0;
		gate.sseGuard = ( to ) => 'demo.p0' !== to;
		gate.onRefused = () => refused++;
		gate.fill( cmd( 'demo.p0' ) );
		expect( filled ).toEqual( [] );
		expect( refused ).toBe( 1 );
	} );

	it( 'lets a message the sseGuard admits through untouched', () => {
		const { gate, filled } = makeGate();
		gate.sseGuard = ( to ) => 'demo.p0' !== to;
		gate.onRefused = () => {
			throw new Error( 'refused an admitted message' );
		};
		gate.fill( cmd( '' ) );
		expect( filled ).toHaveLength( 1 );
	} );

	it( 'refuses BEFORE onForward, so a dropped message is never announced', () => {
		const { gate } = makeGate();
		gate.sseGuard = () => false;
		gate.onForward = () => {
			throw new Error( 'announced a refused message' );
		};
		expect( () => gate.fill( cmd( 'demo.p0' ) ) ).not.toThrow();
	} );

	it( 'names the dropped verb on stderr when it has no sink', () => {
		const spy = jest.spyOn( Core, 'stderr' ).mockImplementation();
		const gate = new OutgoingGateNode();
		gate.fill( cmd( '', 'connect_node' ) );
		expect( spy ).toHaveBeenCalledTimes( 1 );
		expect( spy.mock.calls[ 0 ][ 0 ] ).toMatch( /no command interpreter/i );
		expect( spy.mock.calls[ 0 ][ 0 ] ).toMatch( /\bconnect_node\b/ );
		spy.mockRestore();
	} );
} );
