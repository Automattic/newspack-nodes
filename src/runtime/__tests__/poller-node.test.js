/**
 * Poller tests — the self-timed verb poller and its two console subclasses.
 * `_router` delivers each poll reply (a POSITIONAL Message) back to the node
 * that minted it, which publishes it as node state. Never touches the
 * transcript.
 */

import { PollerNode } from '../poller-node';
import { DmesgNode } from '../dmesg-node';
import { UptimeNode } from '../uptime-node';
import { Node } from '../node';
import { TimerNode } from '../timer-node';
import { RouterNode } from '../router-node';
import { Core } from '../core';
import { forgetSession } from '../command-auth';
import names from '../reserved-node-names.json';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	VALUE,
	TM_BYTESTREAM,
	TM_COMMAND,
	TM_RESPONSE,
} from '../message';

beforeEach( () => Core.reset() );

function msg( type, value ) {
	const m = newMessage();
	m[ TYPE ] = type;
	m[ VALUE ] = value;
	return m;
}

// Drive a dmesg tail through fill() and read back the published level counts.
function tally( payload ) {
	const node = new DmesgNode();
	node.fill( msg( TM_COMMAND | TM_RESPONSE, { payload } ) );
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

describe( 'PollerNode', () => {
	it( 'fire() emits the CONFIGURED verb + arguments to its target', () => {
		const node = new PollerNode();
		node.name = '_logs:poller';
		node.target = '_http';
		node.verb = 'taillog';
		node.pollArgs = [ 'php' ];
		const sent = [];
		node.sink = { fill: ( m ) => sent.push( m ) };
		node.fire();
		expect( sent ).toHaveLength( 1 );
		expect( sent[ 0 ][ VALUE ] ).toMatchObject( {
			name: 'taillog',
			arguments: [ 'php' ],
		} );
		expect( sent[ 0 ][ TO ] ).toBe( '_http' );
	} );

	it( 'publishes a structured reply verbatim as `reply`', () => {
		const node = new PollerNode();
		node.name = 'runtime:timers';
		node.fill(
			msg( TM_COMMAND | TM_RESPONSE, {
				payload: [ { name: 'tick0', fires: 7 } ],
			} )
		);
		expect( node.setStateCache.reply ).toEqual( [
			{ name: 'tick0', fires: 7 },
		] );
	} );

	// A `profile on` ack lands on the poller that minted it; publishing it
	// would blank the grid the same node's row list feeds.
	it( 'drops a text reply rather than replacing the row list', () => {
		const node = new PollerNode();
		node.name = 'runtime:timers';
		node.fill( msg( TM_COMMAND | TM_RESPONSE, { payload: [ 'rows' ] } ) );
		node.fill(
			msg( TM_COMMAND | TM_RESPONSE, { payload: 'profiling on' } )
		);
		expect( node.setStateCache.reply ).toEqual( [ 'rows' ] );
	} );
} );

describe( 'DmesgNode', () => {
	it( 'publishes {errors,warnings,debug} from a dmesg reply payload', () => {
		const node = new DmesgNode();
		node.name = '_dmesg';
		node.fill(
			msg( TM_COMMAND | TM_RESPONSE, {
				payload: 'ERROR: a\nWARNING: b\ndebug c',
			} )
		);
		expect( node.setStateCache.dmesg ).toEqual( {
			errors: 1,
			warnings: 1,
			debug: 1,
		} );
	} );

	it( 'publishes an object reply payload as `reply` (e.g. a `-s` row list), leaving the text state untouched', () => {
		const node = new DmesgNode();
		node.name = 'runtime:poller';
		node.fill(
			msg( TM_COMMAND | TM_RESPONSE, {
				payload: {
					timers: [ { name: 'tick0', fires: 7 } ],
					handles: [],
				},
			} )
		);
		expect( node.setStateCache.reply ).toEqual( {
			timers: [ { name: 'tick0', fires: 7 } ],
			handles: [],
		} );
		expect( node.setStateCache.dmesg ).toBeUndefined();
	} );

	it( 'fire() emits a dmesg poll command to its target', () => {
		const node = new DmesgNode();
		node.name = '_dmesg';
		node.target = '_cwd';
		const sent = [];
		node.sink = { fill: ( m ) => sent.push( m ) };
		node.fire();
		expect( sent ).toHaveLength( 1 );
		expect( sent[ 0 ][ VALUE ] ).toMatchObject( {
			name: 'dmesg',
			arguments: [],
		} );
	} );

	// An unmintable tick emits nothing, so it must not count as a message
	// either — `counter` is what the inspector reports as messages passed on.
	// Last in the block: the void ensureSession() this triggers re-establishes
	// the session before the next test mints.
	it( 'fire() counts nothing when the mint is refused (no session)', () => {
		forgetSession();
		const node = new DmesgNode();
		node.name = '_dmesg';
		node.target = '_cwd';
		node.counter = 41;
		const sent = [];
		node.sink = { fill: ( m ) => sent.push( m ) };
		node.fire();
		expect( sent ).toHaveLength( 0 );
		expect( node.counter ).toBe( 41 );
	} );
} );

describe( 'UptimeNode', () => {
	it( 'keeps the right half of a bytestream uptime line', () => {
		const node = new UptimeNode();
		node.fill( msg( TM_BYTESTREAM, '09:44:52  up 0 days, 00:01:00\n' ) );
		expect( node.setStateCache.uptime ).toBe( '0 days, 00:01:00' );
	} );

	it( 'unwraps a {name,payload} command-response envelope', () => {
		const node = new UptimeNode();
		node.fill(
			msg( TM_COMMAND | TM_RESPONSE, {
				name: 'uptime',
				payload: '12:00:00  up 5 days, 02:03:04',
			} )
		);
		expect( node.setStateCache.uptime ).toBe( '5 days, 02:03:04' );
	} );

	it( 'ignores a line with no `up` segment', () => {
		const node = new UptimeNode();
		node.fill( msg( TM_BYTESTREAM, 'no uptime here' ) );
		expect( node.setStateCache.uptime ).toBeUndefined();
	} );

	it( 'pre-declares the `uptime` event so useNodeState can subscribe', () => {
		const node = new UptimeNode();
		expect( node.registrations.uptime ).toBeDefined();
	} );

	it( 'works as a real sink target (router → uptime.fill)', () => {
		const node = new UptimeNode();
		const router = new Node();
		router.sink = node;
		router.fill( msg( TM_BYTESTREAM, '00:00:00  up 1 day, 00:00:01' ) );
		expect( node.setStateCache.uptime ).toBe( '1 day, 00:00:01' );
	} );

	it( 'increments the base Node counter on each fill', () => {
		const node = new UptimeNode();
		node.fill( msg( TM_BYTESTREAM, 'x up a' ) );
		node.fill( msg( TM_BYTESTREAM, 'x up b' ) );
		expect( node.counter ).toBe( 2 );
	} );

	describe( 'fire() poll emission (5s throttle)', () => {
		afterEach( () => {
			Core.reset();
			jest.restoreAllMocks();
		} );

		// The 5s throttle is the Router-hitchhike pacer, so arm the node the
		// way production does — named, on a live _router — rather than
		// hand-setting interval_ms on an unarmed node.
		const build = ( { armed = false } = {} ) => {
			const router = new RouterNode();
			router.name = names.ROUTER;
			router.stopTimer();
			const node = new UptimeNode();
			node.name = '_uptime';
			const sent = [];
			node.sink = { fill: ( m ) => sent.push( m ) };
			if ( armed ) {
				node.setTimer();
			}
			return { node, sent };
		};

		it( 'emits an uptime TM_COMMAND addressed to this.target (the _cwd indirection)', () => {
			jest.spyOn( Core, 'now' ).mockReturnValue( 100 );
			const { node, sent } = build();
			node.target = '_cwd';
			node.fire();
			expect( sent ).toHaveLength( 1 );
			const m = sent[ 0 ];
			expect( m[ TYPE ] ).toBe( TM_COMMAND );
			expect( m[ VALUE ].name ).toBe( 'uptime' );
			expect( m[ TO ] ).toBe( '_cwd' );
			expect( m[ FROM ] ).toBe( '_uptime' );
			expect( node.pollTo ).toBeUndefined();
		} );

		it( 'throttles: two fireCb() ticks <5s apart emit once', () => {
			// 5s cadence = base Timer throttle in fireCb(); fire() unthrottled.
			const nowSpy = jest.spyOn( Core, 'now' );
			const { node, sent } = build( { armed: true } );
			node.target = '_cwd';
			expect( node.mode ).toBe( 'router' );
			nowSpy.mockReturnValue( 100 );
			node.fireCb();
			nowSpy.mockReturnValue( 103 ); // 3s later
			node.fireCb();
			expect( sent ).toHaveLength( 1 );
		} );

		it( 'emits twice when ticks are >=5s apart', () => {
			const nowSpy = jest.spyOn( Core, 'now' );
			const { node, sent } = build( { armed: true } );
			node.target = '_cwd';
			nowSpy.mockReturnValue( 100 );
			node.fireCb();
			nowSpy.mockReturnValue( 105 ); // 5s later
			node.fireCb();
			expect( sent ).toHaveLength( 2 );
		} );

		it( 'emits nothing when there is no sink', () => {
			const node = new UptimeNode();
			node.target = '_cwd';
			expect( () => node.fire() ).not.toThrow();
		} );

		// See the DmesgNode counterpart: an unmintable tick counts nothing.
		it( 'counts nothing when the mint is refused (no session)', () => {
			forgetSession();
			const { node, sent } = build();
			node.target = '_cwd';
			node.counter = 41;
			node.fire();
			expect( sent ).toHaveLength( 0 );
			expect( node.counter ).toBe( 41 );
		} );
	} );

	describe( 'TimerNode integration (router-hitchhike via notify_timer)', () => {
		afterEach( () => {
			Core.reset();
			jest.restoreAllMocks();
		} );

		it( 'is a TimerNode subclass', () => {
			expect( new UptimeNode() ).toBeInstanceOf( TimerNode );
		} );

		it( 'setTimer() registers on the router TIMER; notify_timer fires the poll', () => {
			jest.spyOn( Core, 'now' ).mockReturnValue( 100 );
			const router = new RouterNode();
			router.name = names.ROUTER;
			router.stopTimer();
			const node = new UptimeNode();
			node.name = names.UPTIME;
			const sent = [];
			node.sink = { fill: ( m ) => sent.push( m ) };
			node.target = names.CWD;
			node.setTimer();
			router.notifyTimer();
			expect( sent ).toHaveLength( 1 );
			expect( sent[ 0 ][ VALUE ].name ).toBe( 'uptime' );
			node.stopTimer();
		} );

		it( 'removeNode unregisters from the router TIMER (no leak)', () => {
			const router = new RouterNode();
			router.name = names.ROUTER;
			router.stopTimer();
			const node = new UptimeNode();
			node.name = names.UPTIME;
			node.sink = { fill: () => {} };
			node.setTimer();
			node.removeNode();
			expect( names.UPTIME in router.registrations.TIMER ).toBe( false );
			expect( () => router.notifyTimer() ).not.toThrow();
		} );
	} );
} );
