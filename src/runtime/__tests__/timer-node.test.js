import { TimerNode } from '../timer-node';
import { RouterNode } from '../router-node';
import { Core } from '../core';
import names from '../reserved-node-names.json';
import { TYPE, VALUE, TM_BYTESTREAM } from '../message';

jest.useFakeTimers();

beforeEach( () => Core.reset() );

// A live _router with interval stopped; tests drive ticks via notifyTimer().
function makeRouter() {
	const r = new RouterNode();
	r.name = names.ROUTER;
	r.stopTimer();
	return r;
}

describe( 'event-framework mode (own setInterval slot)', () => {
	test( 'setTimer(ms) schedules fire() at the configured interval', () => {
		const t = new TimerNode();
		const sent = [];
		t.name = 't1';
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

	// @longform
	// fireCb's throttle exists for the ROUTER tick: ride a 1s dispatch, fire
	// every interval_ms. An own slot already fires at interval_ms, so gating it
	// again drops any tick the platform delivers a hair early — invisible under
	// fake timers, which advance exactly, and a halved cadence in the wild.
	test( 'an own slot >1000ms is not re-throttled by the router gate', () => {
		const t = new TimerNode();
		t.sink = { fill: () => {} };
		t.setTimer( 2000 );
		expect( t.mode ).toBe( 'event_framework' );

		const realNow = Core.now.bind( Core );
		try {
			let stamp = 1000;
			Core.now = () => stamp;
			t.fireCb();
			const first = t.fireCount;
			// The next slot lands 1ms shy of the nominal 2000ms period.
			stamp = 1000 + 1.999;
			t.fireCb();

			expect( t.fireCount ).toBe( first + 1 );
		} finally {
			Core.now = realNow;
			t.stopTimer();
		}
	} );

	test( 'a spent oneshot stops fully: one fire, interval cleared, flag reset', () => {
		const t = new TimerNode();
		const sent = [];
		t.name = 't-oneshot';
		t.sink = { fill: ( m ) => sent.push( m ) };
		t.setTimer( 100, true );
		jest.advanceTimersByTime( 500 );
		expect( sent ).toHaveLength( 1 );
		expect( t.mode ).toBe( 'inactive' );
		expect( t.oneshot ).toBe( false );
		expect( t._handle ).toBeNull();
	} );

	test( 're-arming a live timer as a oneshot keeps the flag (re-arm stopTimer must not clobber it)', () => {
		const t = new TimerNode();
		const sent = [];
		t.name = 't-rearm-oneshot';
		t.sink = { fill: ( m ) => sent.push( m ) };
		t.setTimer( 100 );
		t.setTimer( 100, true );
		jest.advanceTimersByTime( 500 );
		expect( sent ).toHaveLength( 1 );
		expect( t.mode ).toBe( 'inactive' );
	} );

	test( 'stopTimer clears the interval', () => {
		const t = new TimerNode();
		const sent = [];
		t.name = 't2';
		t.sink = { fill: ( m ) => sent.push( m ) };
		t.setTimer( 100 );
		jest.advanceTimersByTime( 150 );
		t.stopTimer();
		jest.advanceTimersByTime( 500 );
		expect( sent ).toHaveLength( 1 );
	} );

	test( 'same-mode re-arm clears the prior interval (no leak; PHP-parity)', () => {
		// JS setInterval doesn't dedup, so re-arming must clear the old handle.
		const t = new TimerNode();
		const sent = [];
		t.name = 't-rearm';
		t.sink = { fill: ( m ) => sent.push( m ) };
		t.setTimer( 100 );
		t.setTimer( 100 );
		jest.advanceTimersByTime( 100 );
		expect( sent ).toHaveLength( 1 );
		t.stopTimer();
	} );

	test( 'fire() increments counter per emit (Perl parity: counter++ inside the owner/CI guard)', () => {
		// Perl Timer::fire counts on emit; a plain-object sink trips the guard.
		const t = new TimerNode();
		t.name = 't-counter-own';
		t.sink = { fill: () => {} };
		t.setTimer( 100 );
		jest.advanceTimersByTime( 300 );
		expect( t.fireCount ).toBe( 3 );
		expect( t.counter ).toBe( 3 );
		t.stopTimer();
	} );

	test( 'arguments=N self-starts the interval (Tachikoma parity)', () => {
		const t = new TimerNode();
		const sent = [];
		t.name = 't3';
		t.arguments = [ '250' ];
		t.sink = { fill: ( m ) => sent.push( m ) };
		expect( t.interval_ms ).toBe( 250 );
		jest.advanceTimersByTime( 600 );
		expect( sent.length ).toBeGreaterThanOrEqual( 2 );
		t.stopTimer();
	} );

	test( 'notify("FIRE") fires registered subscribers each tick', () => {
		const t = new TimerNode();
		t.name = 't4';
		// No sink: fire_cb returns early, so notify('FIRE') never fires.
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
		// No sink: fire_cb bumps fireCount but returns before fire().
		const t = new TimerNode();
		t.name = 't-nosink';
		const ticks = [];
		t.register( 'FIRE', 'sub', () => {
			ticks.push( 1 );
			return true;
		} );
		t.setTimer( 100 );
		jest.advanceTimersByTime( 300 );
		// No sink -> no fire() -> fireCount stays 0 (fires, not ticks).
		expect( t.fireCount ).toBe( 0 );
		expect( ticks ).toHaveLength( 0 );
		t.stopTimer();
	} );
} );

describe( 'Router-hitchhike mode (rides the _router TIMER via notify_timer)', () => {
	test( 'no-arg setTimer() fires fire_cb on each notify_timer (direct dispatch)', () => {
		const r = makeRouter();
		const t = new TimerNode();
		t.name = 'hb';
		const sent = [];
		t.sink = { fill: ( m ) => sent.push( m ) };
		t.target = '_output';
		t.setTimer();
		r.notifyTimer();
		r.notifyTimer();
		expect( sent ).toHaveLength( 2 );
		expect( t.fireCount ).toBe( 2 );
		t.stopTimer();
	} );

	test( 'a hitchhike oneshot unregisters from the router after its single fire', () => {
		const r = makeRouter();
		const t = new TimerNode();
		t.name = 'once';
		const sent = [];
		t.sink = { fill: ( m ) => sent.push( m ) };
		t.target = '_output';
		t.setTimer( 5000, true );
		r.notifyTimer();
		expect( sent ).toHaveLength( 1 );
		expect( 'once' in r.registrations.TIMER ).toBe( false );
		r.notifyTimer();
		expect( sent ).toHaveLength( 1 );
	} );

	test( 'counter advances once per tick (counter++ lives only in fire())', () => {
		const r = makeRouter();
		const t = new TimerNode();
		t.name = 'hb-counter';
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
		const sent = [];
		t.name = 'hb2';
		t.arguments = [];
		t.sink = { fill: ( m ) => sent.push( m ) };
		r.notifyTimer();
		expect( sent ).toHaveLength( 1 );
		t.stopTimer();
	} );

	test( 'stopTimer in router mode stops firing on notify_timer', () => {
		const r = makeRouter();
		const t = new TimerNode();
		const sent = [];
		t.name = 'hb3';
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
		t.name = 'hb4';
		expect( () => t.setTimer() ).toThrow();
	} );
} );

describe( 'hitchhike + throttle (setTimer(ms) with ms >= 1000)', () => {
	test( 'setTimer(ms >= 1000) hitchhikes the _router instead of an own slot', () => {
		makeRouter();
		const t = new TimerNode();
		t.name = 'slow';
		t.sink = { fill: () => {} };
		t.target = '_output';
		t.setTimer( 1000 );
		expect( t.mode ).toBe( 'router' );
		expect( t.interval_ms ).toBe( 1000 );
		// No own-slot interval was scheduled.
		jest.advanceTimersByTime( 10000 );
		expect( t.counter ).toBe( 0 );
		t.stopTimer();
	} );

	test( 'the _router itself owns a slot at 1000ms (cannot hitchhike its own TIMER)', () => {
		// Router can't subscribe to its own TIMER but still owns an EF slot.
		const r = makeRouter();
		r.setTimer( 1000 );
		expect( r.mode ).toBe( 'event_framework' );
		r.stopTimer();
	} );

	test( 'fire_cb throttles fire() to interval_ms across router ticks', () => {
		jest.setSystemTime( 0 );
		const r = makeRouter();
		const t = new TimerNode();
		t.name = 'slow-throttle';
		const sent = [];
		t.sink = { fill: ( m ) => sent.push( m ) };
		t.target = '_output';
		t.setTimer( 5000 );
		// Five 1s router ticks; only the tick at-or-past 5s should emit.
		for ( let i = 1; i <= 5; i++ ) {
			jest.setSystemTime( i * 1000 );
			r.notifyTimer();
		}
		expect( sent ).toHaveLength( 1 );
		// fireCount counts throttled EMITS, not driven ticks (1 fire / 5 ticks).
		expect( t.fireCount ).toBe( 1 );
		// Five more ticks → one more emit at the 10s boundary.
		for ( let i = 6; i <= 10; i++ ) {
			jest.setSystemTime( i * 1000 );
			r.notifyTimer();
		}
		expect( sent ).toHaveLength( 2 );
		t.stopTimer();
	} );

	test( 'setTimer(ms < 1000) still uses an own setInterval slot', () => {
		const t = new TimerNode();
		t.name = 'fast';
		const sent = [];
		t.sink = { fill: ( m ) => sent.push( m ) };
		t.setTimer( 999 );
		expect( t.mode ).toBe( 'event_framework' );
		jest.advanceTimersByTime( 2997 );
		expect( sent ).toHaveLength( 3 );
		t.stopTimer();
	} );

	// PHP: `$this->interval_ms = null === $ms ? $router->interval_ms : $ms;`
	// A no-ms rider genuinely fires at the router cadence, and list_timers
	// prints interval_ms — so reporting 0 here made the same node read
	// differently in a browser graph than in a worker.
	test( 'a no-ms hitchhike reports the router cadence, matching PHP', () => {
		const r = new RouterNode();
		r.name = names.ROUTER;
		expect( r.interval_ms ).toBe( 1000 );

		const t = new TimerNode();
		t.name = 'rides';
		t.sink = { fill: () => {} };
		t.setTimer();

		expect( t.interval_ms ).toBe( 1000 );
		t.stopTimer();
		r.stopTimer();
	} );

	test( 'no-ms hitchhike fires every tick — the cadence is never > 1000, so no throttle', () => {
		const r = makeRouter();
		const t = new TimerNode();
		t.name = 'every-tick';
		const sent = [];
		t.sink = { fill: ( m ) => sent.push( m ) };
		t.target = '_output';
		t.setTimer();
		r.notifyTimer();
		r.notifyTimer();
		r.notifyTimer();
		expect( sent ).toHaveLength( 3 );
		t.stopTimer();
	} );
} );
