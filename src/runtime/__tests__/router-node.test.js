import { RouterNode } from '../router-node';
import { TimerNode } from '../timer-node';
import { Node } from '../node';
import { Core } from '../core';
import {
	TYPE,
	FROM,
	TO,
	ID,
	VALUE,
	TM_ERROR,
	TM_COMMAND,
	newMessage,
} from '../message';

beforeEach( () => Core.reset() );

test( 'peels TO head and forwards to registered node with remaining path', () => {
	const r = new RouterNode();
	r.name = '_router';

	const downstream = new Node();
	downstream.name = 'alpha';
	const captured = [];
	downstream.fill = ( m ) => captured.push( [ ...m ] );

	const m = newMessage();
	m[ TO ] = 'alpha/beta';
	r.fill( m );

	expect( captured ).toHaveLength( 1 );
	expect( captured[ 0 ][ TO ] ).toBe( 'beta' );
} );

test( 'setting a sink throws — the Router has none', () => {
	const r = new RouterNode();
	r.name = '_router';
	expect( () => {
		r.sink = new Node();
	} ).toThrow( /must not have a sink/ );
	expect( r.sink ).toBeNull();
} );

test( 'empty TO is dropped as "message not addressed" — no NOT_AVAILABLE bounce (Perl parity)', () => {
	expectConsoleWarn( '_router: WARNING: message not addressed - TM_UNTYPED' );
	const r = new RouterNode();
	r.name = '_router';
	const origin = new Node();
	origin.name = 'origin';
	const got = [];
	origin.fill = ( m ) => got.push( [ ...m ] );

	const m = newMessage();
	m[ FROM ] = 'origin';
	m[ TO ] = ''; // unaddressed → dropped before routing, no bounce to FROM
	r.fill( m );

	expect( got ).toHaveLength( 0 );
} );

test( 'a FROM trail over MAX_FROM_SIZE is dropped before routing (path-explosion guard; Perl parity)', () => {
	expectConsoleWarn( '_router: WARNING: path exceeded 1024 bytes' );
	const r = new RouterNode();
	r.name = '_router';
	const alpha = new Node();
	alpha.name = 'alpha';
	const got = [];
	alpha.fill = ( m ) => got.push( m );

	const m = newMessage();
	m[ TO ] = 'alpha';
	m[ FROM ] = 'x'.repeat( 1025 );
	r.fill( m );

	expect( got ).toHaveLength( 0 );
} );

test( 'unknown TO head yields NOT_AVAILABLE error walked back to FROM', () => {
	// The miss also leaves its audit line; the bounce is what this pins.
	expectConsoleWarn( '_router: NOT_AVAILABLE - TM_UNTYPED' );
	const r = new RouterNode();
	r.name = '_router';

	const origin = new Node();
	origin.name = 'origin';
	const got = [];
	origin.fill = ( m ) => got.push( [ ...m ] );

	const m = newMessage();
	m[ FROM ] = 'origin';
	m[ TO ] = 'missing/nope';
	m[ ID ] = 'cmd-42';
	r.fill( m );

	expect( got ).toHaveLength( 1 );
	expect( got[ 0 ][ TYPE ] & TM_ERROR ).toBeTruthy();
	expect( got[ 0 ][ ID ] ).toBe( 'cmd-42' );
	expect( got[ 0 ][ VALUE ] ).toMatch( /NOT_AVAILABLE/ );
} );

/**
 * The latch Tachikoma spells `handling_error`: while a bounce is being built,
 * a second miss is dropped as `breaking recursion` rather than minting another
 * bounce. The TM_ERROR check catches the bounce's own route missing; this
 * catches a miss reached any other way out of that re-fill.
 */
test( 'a miss while a bounce is in flight breaks recursion', () => {
	expectConsoleWarn( '_router: WARNING: breaking recursion' );
	const r = new RouterNode();
	r.name = '_router';
	r.handlingError = true;

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ TO ] = 'missing';
	m[ FROM ] = 'origin';
	r.fill( m );

	expect( Core.recentLog.join( ' ' ) ).toContain( 'breaking recursion' );
	expect( Core.recentLog.join( ' ' ) ).not.toContain( 'NOT_AVAILABLE' );
} );

test( 'TM_ERROR on a missing TO is dropped (no error-on-error bounce)', () => {
	const r = new RouterNode();
	r.name = '_router';

	const m = newMessage();
	m[ TYPE ] = TM_ERROR;
	m[ TO ] = 'missing';
	// No throw, no infinite loop — silently consumed.
	expect( () => r.fill( m ) ).not.toThrow();
} );

test( 'single-segment TO with no slash peels head and forwards with empty TO', () => {
	const r = new RouterNode();
	r.name = '_router';

	const downstream = new Node();
	downstream.name = 'alpha';
	const captured = [];
	downstream.fill = ( m ) => captured.push( [ ...m ] );

	const m = newMessage();
	m[ TO ] = 'alpha';
	r.fill( m );

	expect( captured ).toHaveLength( 1 );
	expect( captured[ 0 ][ TO ] ).toBe( '' );
} );

/**
 * Tachikoma's `send_error` ends with `drop_message( $message, $error )`, so the
 * message that failed to route always leaves an audit line — and because that
 * call sits inside `if ( not TYPE & TM_ERROR )`, the bounce never does. Without
 * it a route miss vanishes with nothing on stderr.
 */
test( 'a route miss leaves an audit line naming what was lost', () => {
	expectConsoleWarn( '_router: NOT_AVAILABLE - TM_COMMAND' );
	const r = new RouterNode();
	r.name = '_router';
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ TO ] = 'sprocket';
	m[ FROM ] = '';
	m[ VALUE ] = 'winding';
	r.fill( m );
	// `to:` carries the whole path asked for. The head that did not resolve
	// rides the bounce's own FROM, which is where Tachikoma reads it.
	expect( Core.recentLog.join( ' ' ) ).toContain( 'to: sprocket' );
} );

test( 'a miss with no FROM mints no bounce — it has nowhere to go', () => {
	// The audit line names the message that went missing, not a bounce the
	// Router built for itself and then dropped as unaddressed.
	expectConsoleWarn( '_router: NOT_AVAILABLE - TM_UNTYPED to: missing/path' );
	const r = new RouterNode();
	r.name = '_router';
	const m = newMessage();
	m[ TO ] = 'missing/path';
	expect( () => r.fill( m ) ).not.toThrow();
} );

describe( 'Router TIMER (notify_timer — direct fire_cb dispatch)', () => {
	test( "fireCb increments the router's own fireCount (list_timers FIRES)", () => {
		const r = new RouterNode();
		r.name = '_router';
		r.fireCb();
		r.fireCb();
		expect( r.fireCount ).toBe( 2 );
	} );

	test( "self-started slot fires each registered node's fireCb once per interval", () => {
		jest.useFakeTimers();
		try {
			const r = new RouterNode();
			r.name = '_router';
			const t = new TimerNode();
			t.name = 'sub';
			let fires = 0;
			t.fireCb = () => {
				fires += 1;
			};
			r.register( 'TIMER', 'sub' );
			// No immediate fire (Perl parity); first tick after one interval.
			expect( fires ).toBe( 0 );
			jest.advanceTimersByTime( 1000 );
			expect( fires ).toBe( 1 );
			jest.advanceTimersByTime( 2000 );
			expect( fires ).toBe( 3 );
			r.stopTimer();
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'a registered name with no live node is warned and dropped (forgot to unregister)', () => {
		jest.useFakeTimers();
		const stderr = jest.spyOn( Core, 'stderr' ).mockImplementation();
		try {
			const r = new RouterNode();
			r.name = '_router';
			r.register( 'TIMER', 'ghost' ); // no node named 'ghost' in Core
			jest.advanceTimersByTime( 1000 );
			expect( stderr ).toHaveBeenCalledWith(
				expect.stringMatching( /ghost forgot to unregister/ )
			);
			expect( 'ghost' in r.registrations.TIMER ).toBe( false );
			r.stopTimer();
		} finally {
			jest.useRealTimers();
			stderr.mockRestore();
		}
	} );

	test( 'stopTimer halts further ticks', () => {
		jest.useFakeTimers();
		try {
			const r = new RouterNode();
			r.name = '_router';
			const t = new TimerNode();
			t.name = 'sub';
			let count = 0;
			t.fireCb = () => {
				count += 1;
			};
			r.register( 'TIMER', 'sub' );
			jest.advanceTimersByTime( 1000 );
			expect( count ).toBe( 1 );
			r.stopTimer();
			jest.advanceTimersByTime( 5000 );
			expect( count ).toBe( 1 );
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'removeNode stops the self-started interval (no leak)', () => {
		jest.useFakeTimers();
		try {
			const r = new RouterNode();
			r.name = '_router';
			const t = new TimerNode();
			t.name = 'sub';
			let count = 0;
			t.fireCb = () => {
				count += 1;
			};
			r.register( 'TIMER', 'sub' );
			r.removeNode();
			jest.advanceTimersByTime( 5000 );
			expect( count ).toBe( 0 );
		} finally {
			jest.useRealTimers();
		}
	} );
} );

// Several nodes mounting in one commit each ask to be included in THIS tick.
// That is one tick, not one per asker: a hitchhiker at the tick's own cadence
// has no throttle to protect it, so a tick per asker would send its command
// once per asker — the duplication the batch exists to prevent.
test( 'requestTick coalesces many asks in one commit into ONE tick', async () => {
	const router = new RouterNode();
	router.name = '_router';

	router.requestTick();
	router.requestTick();
	router.requestTick();
	expect( router.fireCount ).toBe( 0 );

	await Promise.resolve();
	expect( router.fireCount ).toBe( 1 );

	// A later ask is a later tick.
	router.requestTick();
	await Promise.resolve();
	expect( router.fireCount ).toBe( 2 );
} );

// A timer that asks for a tick from INSIDE one — a rail refresh sending its
// verb — must ride the bracket it is already in. A fresh tick would open a
// second lock/flush and put that one command in a POST of its own.
describe( 'a tick asked for during a tick', () => {
	function tickHarness() {
		const router = new RouterNode();
		router.name = '_router';
		const http = new Node();
		http.name = '_http';
		http.brackets = [];
		http.lock = () => http.brackets.push( 'lock' );
		http.flush = () => http.brackets.push( 'flush' );
		const fired = [];
		const timer = ( name, ms ) => {
			const t = new TimerNode();
			t.name = name;
			t.sink = new Node();
			t.sink.fill = () => {};
			t.register( 'FIRE', `${ name }:probe`, () => {
				fired.push( name );
			} );
			t.setTimer( ms );
			return t;
		};
		return { router, http, fired, timer };
	}

	test( 'fires the timer it marked due before the one flush', async () => {
		const { router, http, fired, timer } = tickHarness();
		const fetch = timer( 'rail:fetch', 1000 );
		const rail = timer( 'rail:timer', 10000 );
		rail.register( 'FIRE', 'rail:refresh', () => {
			fetch.markDue();
			router.requestTick();
		} );

		router.fireCb();
		await Promise.resolve();

		expect( fired ).toEqual( [ 'rail:fetch', 'rail:timer', 'rail:fetch' ] );
		expect( http.brackets ).toEqual( [ 'lock', 'flush' ] );
		expect( router.fireCount ).toBe( 1 );
	} );

	test( 'leaves an ask made in the extra pass due for the cadence tick', async () => {
		const { router, http, fired, timer } = tickHarness();
		const tail = timer( 'chain:tail', 10000 );
		const head = timer( 'chain:head', 10000 );
		const rail = timer( 'rail:timer', 10000 );
		rail.register( 'FIRE', 'rail:ask', () => {
			head.markDue();
			router.requestTick();
		} );
		head.register( 'FIRE', 'head:ask', () => {
			tail.markDue();
			router.requestTick();
		} );
		// Both just fired, so only an ask brings either round again.
		tail.markFired();
		head.markFired();

		router.fireCb();
		await Promise.resolve();

		expect( http.brackets ).toEqual( [ 'lock', 'flush' ] );
		expect( router.fireCount ).toBe( 1 );
		expect( fired.filter( ( n ) => 'chain:tail' === n ) ).toHaveLength( 0 );
		expect( tail.due ).toBe( true );
	} );

	test( 'leaves it due whichever order the timers registered in', () => {
		const { router, fired, timer } = tickHarness();
		const head = timer( 'chain:head', 10000 );
		const tail = timer( 'chain:tail', 10000 );
		const rail = timer( 'rail:timer', 10000 );
		rail.register( 'FIRE', 'rail:ask', () => {
			head.markDue();
			router.requestTick();
		} );
		head.register( 'FIRE', 'head:ask', () => {
			tail.markDue();
			router.requestTick();
		} );
		head.markFired();
		tail.markFired();

		router.fireCb();

		expect( fired ).toEqual( [ 'rail:timer', 'chain:head' ] );
		expect( tail.due ).toBe( true );
	} );

	test( 'a cycle of asks ends with the tick instead of spinning', async () => {
		const { router, timer } = tickHarness();
		const a = timer( 'cycle:a', 10000 );
		const b = timer( 'cycle:b', 10000 );
		// A cap on the asks, so a regression fails here instead of hanging.
		let asks = 0;
		const ask = ( other ) => () => {
			if ( 64 > ++asks ) {
				other.markDue();
				router.requestTick();
			}
		};
		a.register( 'FIRE', 'cycle:a:ask', ask( b ) );
		b.register( 'FIRE', 'cycle:b:ask', ask( a ) );

		router.fireCb();
		for ( let i = 0; i < 64; i++ ) {
			await Promise.resolve();
		}

		expect( router.fireCount ).toBe( 1 );
	} );

	test( 'clears an unserved ask when a timer throws mid-walk', () => {
		const { router, fired, timer } = tickHarness();
		// Re-marks itself due every fire, as a refused mint does.
		const unsigned = timer( 'unsigned', 1000 );
		unsigned.register( 'FIRE', 'unsigned:refused', () => {
			unsigned.markDue();
		} );
		const rail = timer( 'rail:timer', 10000 );
		rail.register( 'FIRE', 'rail:ask', () => {
			router.requestTick();
		} );
		const broken = timer( 'broken', 10000 );
		broken.register( 'FIRE', 'broken:throw', () => {
			throw new Error( 'poller 5519 threw' );
		} );

		expect( () => router.fireCb() ).toThrow( 'poller 5519 threw' );
		broken.stopTimer();
		fired.length = 0;
		router.fireCb();

		expect( fired.filter( ( n ) => 'unsigned' === n ) ).toHaveLength( 1 );
	} );

	test( 'leaves a timer nobody marked due alone', async () => {
		const { router, fired, timer } = tickHarness();
		timer( 'status:poll', 1000 );
		const fetch = timer( 'rail:fetch', 1000 );
		const rail = timer( 'rail:timer', 10000 );
		rail.register( 'FIRE', 'rail:refresh', () => {
			fetch.markDue();
			router.requestTick();
		} );

		router.fireCb();
		await Promise.resolve();

		expect( fired.filter( ( n ) => 'status:poll' === n ) ).toHaveLength(
			1
		);
	} );
} );
