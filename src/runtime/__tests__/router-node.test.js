import { RouterNode } from '../router-node';
import { Node } from '../node';
import { Core } from '../core';
import { TYPE, FROM, TO, ID, VALUE, TM_ERROR, newMessage } from '../message';

beforeEach( () => Core.reset() );

test( 'peels TO head and forwards to registered node with remaining path', () => {
	const r = new RouterNode();
	r.setName( '_router' );

	const downstream = new Node();
	downstream.setName( 'alpha' );
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
	r.setName( '_router' );
	expect( () => {
		r.sink = new Node();
	} ).toThrow( /must not have a sink/ );
	expect( r.sink ).toBeNull();
} );

test( 'empty TO is not forwarded to a sink — it yields NOT_AVAILABLE', () => {
	const r = new RouterNode();
	r.setName( '_router' );
	const origin = new Node();
	origin.setName( 'origin' );
	const got = [];
	origin.fill = ( m ) => got.push( [ ...m ] );

	const m = newMessage();
	m[ FROM ] = 'origin';
	m[ TO ] = ''; // empty head → cannot peel → NOT_AVAILABLE, walked back to FROM
	r.fill( m );

	expect( got ).toHaveLength( 1 );
	expect( got[ 0 ][ TYPE ] & TM_ERROR ).toBeTruthy();
	expect( got[ 0 ][ VALUE ] ).toMatch( /NOT_AVAILABLE/ );
} );

test( 'unknown TO head yields NOT_AVAILABLE error walked back to FROM', () => {
	const r = new RouterNode();
	r.setName( '_router' );

	const origin = new Node();
	origin.setName( 'origin' );
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
	r.setName( '_router' );

	const m = newMessage();
	m[ TYPE ] = TM_ERROR;
	m[ TO ] = 'missing';
	// No throw, no infinite loop — silently consumed.
	expect( () => r.fill( m ) ).not.toThrow();
} );

test( 'single-segment TO with no slash peels head and forwards with empty TO', () => {
	const r = new RouterNode();
	r.setName( '_router' );

	const downstream = new Node();
	downstream.setName( 'alpha' );
	const captured = [];
	downstream.fill = ( m ) => captured.push( [ ...m ] );

	const m = newMessage();
	m[ TO ] = 'alpha';
	r.fill( m );

	expect( captured ).toHaveLength( 1 );
	expect( captured[ 0 ][ TO ] ).toBe( '' );
} );

test( 'NOT_AVAILABLE bounce with empty FROM is silently dropped (no throw, no loop)', () => {
	const r = new RouterNode();
	r.setName( '_router' );
	// No FROM -> the NOT_AVAILABLE error has empty TO -> empty head -> re-fills as
	// TM_ERROR and drops on the TM_ERROR branch; no loop, no sink.
	const m = newMessage();
	m[ TO ] = 'missing/path';
	expect( () => r.fill( m ) ).not.toThrow();
} );

describe( 'Router TIMER', () => {
	test( 'startTimer notifies TIMER immediately and then once per interval', () => {
		jest.useFakeTimers();
		try {
			const r = new RouterNode();
			r.setName( '_router' );
			const fires = [];
			r.register( 'TIMER', 'sub', ( payload ) => {
				fires.push( payload );
				return true;
			} );
			r.startTimer( 1000 );
			// Fires once immediately on startTimer.
			expect( fires ).toHaveLength( 1 );
			expect( typeof fires[ 0 ].now ).toBe( 'number' );
			jest.advanceTimersByTime( 1000 );
			expect( fires ).toHaveLength( 2 );
			jest.advanceTimersByTime( 2000 );
			expect( fires ).toHaveLength( 4 );
			r.stopTimer();
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'beforeTimerNotify runs before, afterTimerNotify after the notify', () => {
		jest.useFakeTimers();
		try {
			const r = new RouterNode();
			r.setName( '_router' );
			const log = [];
			r.beforeTimerNotify = () => log.push( 'before' );
			r.afterTimerNotify = () => log.push( 'after' );
			r.register( 'TIMER', 'sub', () => {
				log.push( 'notify' );
				return true;
			} );
			r.startTimer( 1000 );
			expect( log ).toEqual( [ 'before', 'notify', 'after' ] );
			r.stopTimer();
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'afterTimerNotify runs even when a subscriber throws', () => {
		jest.useFakeTimers();
		try {
			const r = new RouterNode();
			r.setName( '_router' );
			const log = [];
			r.beforeTimerNotify = () => log.push( 'before' );
			r.afterTimerNotify = () => log.push( 'after' );
			// notify() swallows nothing; force a throw by stubbing notify.
			r.notify = () => {
				throw new Error( 'boom' );
			};
			expect( () => r.startTimer( 1000 ) ).toThrow( /boom/ );
			expect( log ).toEqual( [ 'before', 'after' ] );
			r.stopTimer();
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'stopTimer halts further ticks', () => {
		jest.useFakeTimers();
		try {
			const r = new RouterNode();
			r.setName( '_router' );
			let count = 0;
			r.register( 'TIMER', 'sub', () => {
				count += 1;
				return true;
			} );
			r.startTimer( 1000 );
			expect( count ).toBe( 1 );
			r.stopTimer();
			jest.advanceTimersByTime( 5000 );
			expect( count ).toBe( 1 );
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'startTimer restarts cleanly (no duplicate intervals)', () => {
		jest.useFakeTimers();
		try {
			const r = new RouterNode();
			r.setName( '_router' );
			let count = 0;
			r.register( 'TIMER', 'sub', () => {
				count += 1;
				return true;
			} );
			r.startTimer( 1000 ); // count=1 (immediate)
			r.startTimer( 1000 ); // stops old, count=2 (immediate)
			count = 0;
			jest.advanceTimersByTime( 1000 );
			expect( count ).toBe( 1 ); // exactly one interval, not two
			r.stopTimer();
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'removeNode clears _timerHandle (no setInterval leak)', () => {
		jest.useFakeTimers();
		try {
			const r = new RouterNode();
			r.setName( '_router' );
			expect( r._timerHandle ).not.toBeNull();
			r.removeNode();
			expect( r._timerHandle ).toBeNull();
		} finally {
			jest.useRealTimers();
		}
	} );
} );
