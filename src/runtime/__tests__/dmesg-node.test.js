import { DmesgNode } from '../dmesg-node';
import { Core } from '../core';
import {
	newMessage,
	TYPE,
	TO,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
} from '../message';

beforeEach( () => Core.reset() );

// Drive a dmesg tail through fill() and read back the published level counts.
function tally( payload ) {
	const node = new DmesgNode();
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ VALUE ] = { payload };
	node.fill( m );
	return node.setStateCache.dmesg;
}

describe( 'dmesg level classification', () => {
	it( 'classifies dmesg lines (WARNING wins over ERROR), ignoring blanks', () => {
		const text = [
			'2026-01-01 12:00:00 ERROR: boom',
			'2026-01-01 12:00:01 WARNING: careful',
			'2026-01-01 12:00:02 WARNING: ERROR: warning wins',
			'2026-01-01 12:00:03 plain debug line',
			'',
			'   ',
		].join( '\n' );
		expect( tally( text ) ).toEqual( {
			errors: 1,
			warnings: 2,
			debug: 1,
		} );
	} );

	it( 'is zero-safe for empty / missing input', () => {
		expect( tally( '' ) ).toEqual( {
			errors: 0,
			warnings: 0,
			debug: 0,
		} );
		expect( tally( undefined ).errors ).toBe( 0 );
	} );
} );

describe( 'DmesgNode', () => {
	it( 'publishes {errors,warnings,debug} from a dmesg reply payload', () => {
		const node = new DmesgNode();
		node.name = '_dmesg';
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
		m[ VALUE ] = { payload: 'ERROR: a\nWARNING: b\ndebug c' };
		node.fill( m );
		expect( node.setStateCache.dmesg ).toEqual( {
			errors: 1,
			warnings: 1,
			debug: 1,
		} );
	} );

	it( 'publishes an object reply payload as `reply` (e.g. runtime_stats), leaving the text state untouched', () => {
		const node = new DmesgNode();
		node.name = 'runtime:poller';
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
		m[ VALUE ] = {
			payload: { timers: [ { name: 'tick0', fires: 7 } ], handles: [] },
		};
		node.fill( m );
		expect( node.setStateCache.reply ).toEqual( {
			timers: [ { name: 'tick0', fires: 7 } ],
			handles: [],
		} );
		expect( node.setStateCache.lines ).toBeUndefined();
	} );

	it( 'fire() emits a dmesg poll command to its target', () => {
		const node = new DmesgNode();
		node.name = '_dmesg';
		node.target = '_cwd';
		const sent = [];
		node.sink = { fill: ( msg ) => sent.push( msg ) };
		node.fire();
		expect( sent ).toHaveLength( 1 );
		expect( sent[ 0 ][ VALUE ] ).toMatchObject( {
			name: 'dmesg',
			arguments: [],
		} );
	} );

	it( 'fire() emits the CONFIGURED verb + arguments to its target', () => {
		const node = new DmesgNode();
		node.name = '_logs:poller';
		node.target = '_http';
		node.verb = 'taillog';
		node.pollArgs = [ 'php' ];
		const sent = [];
		node.sink = { fill: ( msg ) => sent.push( msg ) };
		node.fire();
		expect( sent ).toHaveLength( 1 );
		expect( sent[ 0 ][ VALUE ] ).toMatchObject( {
			name: 'taillog',
			arguments: [ 'php' ],
		} );
		expect( sent[ 0 ][ TO ] ).toBe( '_http' );
	} );
} );
