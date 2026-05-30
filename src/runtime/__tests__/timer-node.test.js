import { TimerNode } from '../timer-node';
import { RouterNode } from '../router-node';
import { Core } from '../core';
import names from '../reserved-node-names.json';
import { TYPE, VALUE, TM_BYTESTREAM } from '../message';

jest.useFakeTimers();

beforeEach( () => Core.reset() );

// A _router whose self-started tick is stopped, so tests drive notify('TIMER').
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

	test( 'counter stays inactive in own-slot mode (PHP-parity: fire() is egress, no counter++)', () => {
		// PHP fire() never touches counter; own-slot ticks go setInterval->fire_cb->fire
		// (no fill), so counter must stay 0 while fire_count advances.
		const t = new TimerNode();
		t.setName( 't-counter-own' );
		t.sink = { fill: () => {} };
		t.setTimer( 100 );
		jest.advanceTimersByTime( 300 );
		expect( t.fire_count ).toBe( 3 );
		expect( t.counter ).toBe( 0 );
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
} );

describe( 'Router-hitchhike mode (no own slot — rides the _router TIMER tick)', () => {
	test( 'no-arg setTimer() fires fire_cb on each _router TIMER notify', () => {
		const r = makeRouter();
		const t = new TimerNode();
		t.setName( 'hb' );
		const sent = [];
		t.sink = { fill: ( m ) => sent.push( m ) };
		t.target = '_output';
		t.setTimer();
		r.notify( 'TIMER', { now: 1 } );
		r.notify( 'TIMER', { now: 2 } );
		expect( sent ).toHaveLength( 2 );
		expect( t.fire_count ).toBe( 2 );
		t.stopTimer();
	} );

	test( 'counter advances once per tick (PHP-canon parity; fill must not double-count)', () => {
		// PHP Timer_Node::fill() calls fire_cb() with NO counter++; counter++ lives
		// only in fire(). So hitchhike must match own-slot at +1/tick, not +2.
		const r = makeRouter();
		const t = new TimerNode();
		t.setName( 'hb-counter' );
		t.sink = { fill: () => {} };
		t.target = '_output';
		t.setTimer();
		r.notify( 'TIMER', { now: 1 } );
		r.notify( 'TIMER', { now: 2 } );
		r.notify( 'TIMER', { now: 3 } );
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
		r.notify( 'TIMER', { now: 1 } );
		expect( sent ).toHaveLength( 1 );
		t.stopTimer();
	} );

	test( 'stopTimer in router mode stops firing on TIMER notify', () => {
		const r = makeRouter();
		const t = new TimerNode();
		t.setName( 'hb3' );
		const sent = [];
		t.sink = { fill: ( m ) => sent.push( m ) };
		t.setTimer();
		t.stopTimer();
		r.notify( 'TIMER', { now: 1 } );
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
