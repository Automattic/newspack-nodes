/**
 * useRouterTick tests — the shared "call me on the router heartbeat" primitive.
 *
 * The bug it exists for: every dashboard poller owned a private setInterval, so
 * a page ran N competing heartbeats none of which the graph could see, pause, or
 * batch. The Router already owns exactly ONE 1s slot and dispatches to every
 * TIMER-registered node; a poller that rides it costs no additional timer and
 * stops when the graph stops.
 */

import { renderHook, act } from '@testing-library/react';
import { Core, mountExospine } from '@newspack-nodes/runtime';
import useRouterTick from '../useRouterTick';

// Distinct from the 0 default AND not a multiple of the 1s router tick, so a
// throttle that rounded to the tick would land on a different count.
const INTERVAL_MS = 7000;

describe( 'useRouterTick', () => {
	let host;

	beforeEach( () => {
		jest.useFakeTimers();
		Core.reset();
		host = null;
	} );

	afterEach( () => {
		host?.teardown();
		host = null;
		Core.reset();
		// Never useRealTimers() — see jest-node-timers.js. Just drop pending work.
		jest.clearAllTimers();
	} );

	// The hook is a passenger: someone else owns the backbone it rides.
	const mountHost = () => {
		act( () => {
			host = mountExospine( () => {} );
		} );
	};

	it( 'fires the callback on the router heartbeat', () => {
		const onTick = jest.fn();

		mountHost();
		renderHook( () => useRouterTick( { name: 'test:tick', onTick } ) );

		act( () => {
			jest.advanceTimersByTime( 1000 );
		} );

		expect( onTick ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'adds NO interval of its own — the router slot is the only one', () => {
		mountHost();
		const spy = jest.spyOn( global, 'setInterval' );
		const before = spy.mock.calls.length;

		renderHook( () =>
			useRouterTick( {
				name: 'test:tick',
				onTick: () => {},
				intervalMs: INTERVAL_MS,
			} )
		);

		// The host already owns the only 1s slot; the passenger adds none.
		expect( spy.mock.calls.length - before ).toBe( 0 );

		spy.mockRestore();
	} );

	// @longform
	// No leading fire. TimerNode.setTimer zeroes lastFireTime, so the next router
	// tick always passed the throttle regardless of intervalMs — every adopter
	// that also does its own immediate load paid a duplicate request ~1s after
	// arming, and re-armed on every tab focus. The caller owns the leading edge.
	// The cadence is a wall-clock GRID (`nextBoundary`), so a slow tick fires
	// on the first boundary of its own period rather than intervalMs after it
	// was armed — which is what puts every 7s consumer on one tick.
	it( 'fires once per interval, not once per router tick', () => {
		const onTick = jest.fn();

		mountHost();
		renderHook( () =>
			useRouterTick( {
				name: 'test:tick',
				onTick,
				intervalMs: INTERVAL_MS,
			} )
		);

		// Three full periods of 1s router ticks: a couple of fires, never 21.
		// The first is a full interval out — `useRouterTick` marks the window
		// started, since its adopters load once themselves on mount.
		act( () => {
			jest.advanceTimersByTime( 21000 );
		} );
		const afterTwo = onTick.mock.calls.length;
		expect( afterTwo ).toBeGreaterThanOrEqual( 2 );
		expect( afterTwo ).toBeLessThanOrEqual( 3 );

		// One more period, one more fire — never one per router tick.
		act( () => {
			jest.advanceTimersByTime( 7000 );
		} );
		expect( onTick.mock.calls.length ).toBe( afterTwo + 1 );
	} );

	// A throwing callback used to abort RouterNode.notifyTimer mid-iteration and
	// escape into setInterval — starving every timer registered after it, on
	// every subsequent tick. Private slots could not do that to each other.
	it( 'a throwing callback cannot starve other timers', () => {
		const survivor = jest.fn();

		mountHost();
		renderHook( () => {
			useRouterTick( {
				name: 'test:thrower',
				onTick: () => {
					throw new Error( 'boom' );
				},
			} );
			useRouterTick( { name: 'test:survivor', onTick: survivor } );
		} );

		expectConsoleWarn( 'ERROR: useRouterTick(test:thrower): boom' );
		act( () => {
			jest.advanceTimersByTime( 2000 );
		} );

		expect( survivor ).toHaveBeenCalled();
	} );

	it( 'stops ticking after unmount', () => {
		const onTick = jest.fn();

		mountHost();
		const { unmount } = renderHook( () =>
			useRouterTick( { name: 'test:tick', onTick } )
		);

		act( () => {
			jest.advanceTimersByTime( 1000 );
		} );
		const seen = onTick.mock.calls.length;

		unmount();

		act( () => {
			jest.advanceTimersByTime( 5000 );
		} );
		expect( onTick ).toHaveBeenCalledTimes( seen );
	} );

	/**
	 * A poller is a PASSENGER. Mounting its own exospine made it the backbone
	 * OWNER whenever its hook was declared before the graph's — which on the
	 * console flipped Reset-Graph onto a catalog poller.
	 */
	it( 'never becomes the backbone owner', () => {
		renderHook( () =>
			useRouterTick( { name: 'test:tick', onTick: () => {} } )
		);

		// A passenger brings up no backbone at all.
		expect( Core.node( '_router' ) ).toBeNull();

		// And the real graph, mounting after, still owns the rebuild.
		mountHost();
		expect( Core.rebuildable ).toBe( true );
	} );

	it( 'arms itself when the graph mounts after it', () => {
		const onTick = jest.fn();

		renderHook( () => useRouterTick( { name: 'test:tick', onTick } ) );

		act( () => {
			jest.advanceTimersByTime( 3000 );
		} );
		expect( onTick ).not.toHaveBeenCalled();

		mountHost();
		act( () => {
			jest.advanceTimersByTime( 1000 );
		} );

		expect( onTick ).toHaveBeenCalled();
	} );

	// @longform
	// The console mounts BARE — `mountExospine()` with no build callback — and
	// only a build-delegated mount bumps graphGeneration. Keying the passenger's
	// re-attach on that bump left `useTopologyCatalog` (declared before
	// `useConsoleGraph`) permanently unarmed on the one page this was written
	// for: its mount fetch ran, then it never polled again.
	it( 'arms when a BARE mount brings the backbone up', () => {
		const onTick = jest.fn();

		renderHook( () => useRouterTick( { name: 'test:tick', onTick } ) );

		act( () => {
			host = mountExospine();
		} );
		act( () => {
			jest.advanceTimersByTime( 1000 );
		} );

		expect( onTick ).toHaveBeenCalled();
	} );

	// @longform
	// TimerNode.setTimer already handles sub-second: below 1000 it gives the node
	// its OWN slot at exactly that interval. The first cut passed no argument in
	// that branch, discarding the caller's interval and running everything at the
	// Router's 1s — which then got written up as a limitation of the mechanism.
	it( 'honours a sub-second interval instead of rounding it to the router tick', () => {
		const onTick = jest.fn();

		mountHost();
		renderHook( () =>
			useRouterTick( { name: 'test:fast', onTick, intervalMs: 200 } )
		);

		// Its own slot, so it is NOT registered on the router's TIMER.
		expect(
			Object.keys( Core.node( '_router' ).registrations.TIMER )
		).not.toContain( 'test:fast' );

		act( () => {
			jest.advanceTimersByTime( 1000 );
		} );

		// Five 200ms fires in the span the router would have given one.
		expect( onTick.mock.calls.length ).toBeGreaterThanOrEqual( 5 );
	} );

	it( 'does not tick while disabled', () => {
		const onTick = jest.fn();

		mountHost();
		renderHook( () =>
			useRouterTick( { name: 'test:tick', onTick, enabled: false } )
		);

		act( () => {
			jest.advanceTimersByTime( 5000 );
		} );

		expect( onTick ).not.toHaveBeenCalled();
	} );
} );
