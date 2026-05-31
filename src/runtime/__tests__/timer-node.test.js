import { TimerNode } from '../timer-node';
import { RouterNode } from '../router-node';
import { Core } from '../core';
import names from '../reserved-node-names.json';
import { TYPE, VALUE, TM_BYTESTREAM } from '../message';

jest.useFakeTimers();

beforeEach( () => Core.reset() );

// A live _router whose self-started interval is stopped, so tests drive the
// TIMER tick explicitly via notifyTimer() — Perl Router::notify_timer, a DIRECT
// fire_cb dispatch to each registered node (no routed message, no fill()).
function makeRouter() {
	const r = new RouterNode();
	r.setName( names.ROUTER );
	r.stopTimer();
	return r;
}

describe( 'event-framework mode (own setInterval slot)', () => {
	test( 'setTimer(ms) schedules fire() at the configured interval', () => {
		const t = new TimerNode();
		t.setName( 't1' );
		const sent = [];
		t.sink = { fill: ( m ) => sent.push( m ) };
		t.target = '_output';
		t.setTimer( 100 );
		jest.advanceTimersByTime( 350 );
		expect( sent ).toHaveLength( 3 );
		for ( const m of sent ) {
			expect( m[ TYPE ] & TM_BYTESTREAM ).toBeTruthy();
			expect( typeof m[ VALUE ] ).toBe( 'string' );
		}
		t.stopTimer();
	} );

	test( 'stopTimer clears the interval', () => {
		const t = new TimerNode();
		t.setName( 't2' );
		const sent = [];
		t.sink = { fill: ( m ) => sent.push( m ) };
		t.setTimer( 100 );
		jest.advanceTimersByTime( 150 );
		t.stopTimer();
		jest.advanceTimersByTime( 500 );
		expect( sent ).toHaveLength( 1 );
	} );

	test( 'same-mode re-arm clears the prior interval (no leak; PHP-parity)', () => {
		// PHP set_timer guards on mode; Event_Framework dedups by node. JS setInterval
		// does NOT dedup, so re-arming event mode must clear the old handle or it leaks
		// and BOTH intervals fire each tick.
		const t = new TimerNode();
		t.setName( 't-rearm' );
		const sent = [];
		t.sink = { fill: ( m ) => sent.push( m ) };
		t.setTimer( 100 );
		t.setTimer( 100 );
		jest.advanceTimersByTime( 100 );
		expect( sent ).toHaveLength( 1 );
		t.stopTimer();
	} );

	test( 'fire() increments counter per emit (Perl parity: counter++ inside the owner/CI guard)', () => {
		// Perl Timer::fire does $self->{counter}++ when it emits. A plain-object sink
		// (not the CommandInterpreter) trips the guard, so each tick emits + counts.
		const t = new TimerNode();
		t.setName( 't-counter-own' );
		t.sink = { fill: () => {} };
		t.setTimer( 100 );
		jest.advanceTimersByTime( 300 );
		expect( t.fire_count ).toBe( 3 );
		expect( t.counter ).toBe( 3 );
		t.stopTimer();
	} );

	test( 'arguments=N self-starts the interval (Tachikoma parity)', () => {
		const t = new TimerNode();
		t.setName( 't3' );
		const sent = [];
		t.sink = { fill: ( m ) => sent.push( m ) };
		t.arguments = '250';
		expect( t.interval_ms ).toBe( 250 );
		jest.advanceTimersByTime( 600 );
		expect( sent.length ).toBeGreaterThanOrEqual( 2 );
		t.stopTimer();
	} );

	test( 'notify("FIRE") fires registered subscribers each tick', () => {
		const t = new TimerNode();
		t.setName( 't4' );
		// fire_cb returns early without a sink (Perl parity), and notify('FIRE')
		// lives in fire(), so FIRE only reaches subscribers when a sink is present.
		t.sink = { fill: () => {} };
		const ticks = [];
		t.register( 'FIRE', 'sub', ( now ) => {
			ticks.push( now );
			return true;
		} );
		t.setTimer( 100 );
		jest.advanceTimersByTime( 250 );
		expect( ticks ).toHaveLength( 2 );
		t.stopTimer();
	} );

	test( 'fire_cb returns early when there is no sink (Perl parity: return if not sink)', () => {
		// No sink → fire_cb advances fire_count but returns BEFORE fire(), so neither
		// the egress emit nor notify('FIRE') runs.
		const t = new TimerNode();
		t.setName( 't-nosink' );
		const ticks = [];
		t.register( 'FIRE', 'sub', () => {
			ticks.push( 1 );
			return true;
		} );
		t.setTimer( 100 );
		jest.advanceTimersByTime( 300 );
		expect( t.fire_count ).toBe( 3 );
		expect( ticks ).toHaveLength( 0 );
		t.stopTimer();
	} );
} );

describe( 'Router-hitchhike mode (rides the _router TIMER via notify_timer)', () => {
	test( 'no-arg setTimer() fires fire_cb on each notify_timer (direct dispatch)', () => {
		const r = makeRouter();
		const t = new TimerNode();
		t.setName( 'hb' );
		const sent = [];
		t.sink = { fill: ( m ) => sent.push( m ) };
		t.target = '_output';
		t.setTimer();
		r.notifyTimer();
		r.notifyTimer();
		expect( sent ).toHaveLength( 2 );
		expect( t.fire_count ).toBe( 2 );
		t.stopTimer();
	} );

	test( 'counter advances once per tick (counter++ lives only in fire())', () => {
		const r = makeRouter();
		const t = new TimerNode();
		t.setName( 'hb-counter' );
		t.sink = { fill: () => {} };
		t.target = '_output';
		t.setTimer();
		r.notifyTimer();
		r.notifyTimer();
		r.notifyTimer();
		expect( t.counter ).toBe( 3 );
		t.stopTimer();
	} );

	test( 'arguments="" triggers Router-hitchhike', () => {
		const r = makeRouter();
		const t = new TimerNode();
		t.setName( 'hb2' );
		const sent = [];
		t.sink = { fill: ( m ) => sent.push( m ) };
		t.arguments = '';
		r.notifyTimer();
		expect( sent ).toHaveLength( 1 );
		t.stopTimer();
	} );

	test( 'stopTimer in router mode stops firing on notify_timer', () => {
		const r = makeRouter();
		const t = new TimerNode();
		t.setName( 'hb3' );
		const sent = [];
		t.sink = { fill: ( m ) => sent.push( m ) };
		t.setTimer();
		t.stopTimer();
		r.notifyTimer();
		expect( sent ).toHaveLength( 0 );
	} );

	test( 'no-arg setTimer() without a name throws', () => {
		makeRouter();
		const t = new TimerNode();
		expect( () => t.setTimer() ).toThrow();
	} );

	test( 'no-arg setTimer() without a _router throws', () => {
		const t = new TimerNode();
		t.setName( 'hb4' );
		expect( () => t.setTimer() ).toThrow();
	} );
} );
