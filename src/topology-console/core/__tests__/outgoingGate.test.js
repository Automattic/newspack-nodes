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

	it( 'stays unnamed, so no message can be addressed to it', () => {
		const { gate } = makeGate();
		expect( gate.name ).toBe( '' );
		expect( Core.node( '' ) ).toBeNull();
	} );

	it( 'runs beforeSend on the message on its way out', () => {
		const { gate, filled } = makeGate();
		gate.beforeSend = ( m ) => {
			m[ VALUE ].arguments.push( '-al' );
		};
		gate.fill( cmd( 'demo.p0' ) );
		expect( filled[ 0 ][ VALUE ].arguments ).toEqual( [ '-al' ] );
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

	it( 'refuses BEFORE beforeSend, so a dropped message is never mutated', () => {
		const { gate } = makeGate();
		gate.sseGuard = () => false;
		gate.beforeSend = () => {
			throw new Error( 'mutated a refused message' );
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
