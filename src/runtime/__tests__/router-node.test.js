import { RouterNode } from '../router-node';
import { TimerNode } from '../timer-node';
import { Node } from '../node';
import { Core } from '../core';
import { TYPE, FROM, TO, ID, VALUE, TM_ERROR, newMessage } from '../message';

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

test( 'NOT_AVAILABLE bounce with empty FROM is silently dropped (no throw, no loop)', () => {
	expectConsoleWarn( '_router: WARNING: message not addressed - TM_ERROR' );
	const r = new RouterNode();
	r.name = '_router';
	// No FROM → NOT_AVAILABLE has empty TO → drops on the TM_ERROR branch.
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
