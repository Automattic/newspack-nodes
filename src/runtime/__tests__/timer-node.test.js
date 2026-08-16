import { TimerNode, GRID_PHASE_MS } from '../timer-node';
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

	// @longform Every timer on the same interval must land on the SAME router
	// tick, whatever second it was armed in. Paced from its own arming time, a
	// 5s poll armed at :02 and another armed at :04 fire on different ticks
	// forever — two POSTs a cycle where the batch exists to make one. The grid
	// is a pure function of the wall clock, so they converge with nothing
	// shared and nothing persisted.
	// @longform Harmonics have to line up: a 10s boundary IS every second 5s
	// boundary, and every cadence in the set meets at 30s. A phase computed per
	// interval breaks exactly that — the 10s timer lands 360ms off the 5s one
	// and they never share a tick again, which is one extra POST per cycle for
	// every cadence on the page.
	test( 'harmonic intervals share ticks, and all of them meet at 30s', () => {
		const epoch = 1_700_000_000_000;
		const at = ( ms ) => jest.setSystemTime( epoch + ms );
		at( 0 );
		const r = makeRouter();
		const armed = ( name, intervalMs ) => {
			const t = new TimerNode();
			t.name = name;
			t.fired = [];
			t.sink = { fill: () => t.fired.push( Core.now() ) };
			t.target = '_output';
			t.setTimer( intervalMs );
			return t;
		};
		const five = armed( 'five', 5000 );
		const ten = armed( 'ten', 10000 );
		const fifteen = armed( 'fifteen', 15000 );
		const thirty = armed( 'thirty', 30000 );

		for ( let i = 1; i <= 90; i++ ) {
			at( i * 1000 );
			r.notifyTimer();
		}

		// Every slower cadence lands on ticks the 5s one also fires on.
		for ( const t of [ ten, fifteen, thirty ] ) {
			expect( t.fired.length ).toBeGreaterThan( 1 );
			expect(
				t.fired.filter( ( when ) => ! five.fired.includes( when ) )
			).toEqual( [] );
		}
		// And they all meet: every 30s fire is shared by all four.
		for ( const when of thirty.fired ) {
			expect( ten.fired ).toContain( when );
			expect( fifteen.fired ).toContain( when );
		}
		[ five, ten, fifteen, thirty ].forEach( ( t ) => t.stopTimer() );
	} );

	// @longform `markFired()` is the caller saying "I just loaded this myself"
	// — so the next fire owes a FULL interval, not merely the next boundary,
	// which an arming instant just before one makes ~0. Every adopter loads on
	// mount and re-arms on tab focus, so the near-boundary case is a duplicate
	// request about a second after the one it was meant to suppress.
	test( 'markFired holds off a full interval, and stays on the grid', () => {
		const epoch = 1_700_000_000_000;
		// Arm 10ms before a boundary: the next one is no interval at all.
		jest.setSystemTime(
			( Math.floor( ( epoch - GRID_PHASE_MS ) / 5000 ) + 2 ) * 5000 +
				GRID_PHASE_MS -
				10
		);
		const r = makeRouter();
		const t = new TimerNode();
		t.name = 'held';
		const fired = [];
		t.sink = { fill: () => fired.push( Core.now() ) };
		t.target = '_output';
		t.setTimer( 5000 );
		t.markFired();
		const armedAt = Core.now();

		for ( let i = 1; i <= 12; i++ ) {
			jest.setSystemTime( Date.now() + 1000 );
			r.notifyTimer();
		}

		expect( fired.length ).toBeGreaterThan( 0 );
		expect( fired[ 0 ] - armedAt ).toBeGreaterThanOrEqual( 5 );
		// Still the shared grid: every fire sits on a boundary.
		fired.forEach( ( when ) =>
			expect(
				Math.abs(
					( ( when - GRID_PHASE_MS / 1000 ) % 5 ) -
						Math.round( ( when - GRID_PHASE_MS / 1000 ) % 5 )
				)
			).toBeLessThan( 1.01 )
		);
		t.stopTimer();
	} );

	test( 'two timers on one interval fire on the same tick, however they were armed', () => {
		// A real epoch, not 0: `lastFireTime = 0` reads as "due now" there, so
		// each timer fires on the first tick after arming and paces from that.
		const epoch = 1_700_000_000_000;
		const at = ( ms ) => jest.setSystemTime( epoch + ms );
		at( 0 );
		const r = makeRouter();
		const armed = ( name ) => {
			const t = new TimerNode();
			t.name = name;
			t.fired = [];
			t.sink = { fill: () => t.fired.push( Core.now() ) };
			t.target = '_output';
			t.setTimer( 5000 );
			return t;
		};

		const early = armed( 'early-poll' );
		at( 1000 );
		r.notifyTimer();
		// The second surface opens two seconds into the first one's cycle.
		at( 2000 );
		const late = armed( 'late-poll' );

		for ( let i = 3; i <= 40; i++ ) {
			at( i * 1000 );
			r.notifyTimer();
		}

		const shared = early.fired.filter( ( t ) => late.fired.includes( t ) );
		expect( early.fired.length ).toBeGreaterThan( 4 );
		expect( shared.length ).toBeGreaterThan(
			early.fired.length - 3,
			'each surface polls on its own tick, so the batch that exists to make one POST makes two'
		);
		early.stopTimer();
		late.stopTimer();
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
