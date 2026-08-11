/**
 * useBatchedPoll tests — the shared batched-poll toolkit (helper H3). It owns ALL
 * the poll-dashboard boilerplate the example used to hand-wire: the `_shell` Tap +
 * `_http` HttpOut, the fan-out Tee + router-hitchhike Timer, the lock/flush bracket
 * (so one router TIMER tick's commands batch into ONE POST), and the page-visibility
 * start/stop of the Timer. The caller's `build` only adds the dashboard's own nodes.
 *
 *   <timer> (Timer) ─> <tee> (Tee) ─> N Fetchers ─> _shell/_http/<ci>   ONE POST/tick
 */

import { renderHook, act } from '@testing-library/react';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { useEffect } from '@wordpress/element';
import {
	Core,
	Node,
	VALUE,
	TIMESTAMP,
	CommandInterpreterNode,
	forgetSession,
	__setAuthFetch,
} from '@newspack-nodes/runtime';
import { addSliceFetcher } from '../../helpers/addSliceFetcher';
import { useBatchedPoll } from '../useBatchedPoll';

const INTERPRETER = '_command_interpreter';
const ROUTER = '_router';
const HTTP = '_http';
const SHELL = '_shell';

// Lightweight view classes so makeNode builds slice views; fill() consumes.
class FakeViewNode extends Node {
	fill( message ) {
		this.counter += 1;
		this.setState( 'view', message[ VALUE ] );
	}
}
CommandInterpreterNode.registerNodeClasses( {
	SourceCountsView: FakeViewNode,
	TopTableView: FakeViewNode,
	AccumulatedView: FakeViewNode,
} );

// Drive document.visibilityState (matches usePageVisibility tests).
function setVisibility( state ) {
	Object.defineProperty( document, 'visibilityState', {
		configurable: true,
		get: () => state,
	} );
	document.dispatchEvent( new Event( 'visibilitychange' ) );
}

// A fake transport matching HttpOut's seam: records each batch.
// The three Publisher-Insights slices, as the example will pass them.
const SLICES = [
	{
		fetcher: 'fetch-counts',
		receiver: 'countsIn',
		command: 'counts',
		view: 'source-counts:view',
		viewClass: 'SourceCountsView',
	},
	{
		fetcher: 'fetch-top',
		receiver: 'topIn',
		command: 'top',
		view: 'top-table:view',
		viewClass: 'TopTableView',
	},
	{
		fetcher: 'fetch-acc',
		receiver: 'accIn',
		command: 'accumulated',
		view: 'accumulated:view',
		viewClass: 'AccumulatedView',
	},
];

const TARGET = `${ SHELL }/${ HTTP }/insights-demo`;

function buildSlices( { interpreter, tee } ) {
	SLICES.forEach( ( s ) =>
		addSliceFetcher( interpreter, { ...s, tee, target: TARGET } )
	);
}

// The seam is the WIRE: the graph packs, POSTs and unpacks for real, so
// HttpOut, the router and the interpreter all run. `wire.batches` is what was
// posted — one entry per POST, which is what the batching tests count.
function installWire() {
	return installFakeCommandWire( () => null );
}

function renderPoll( opts = {} ) {
	return renderHook( () =>
		useBatchedPoll( {
			build: buildSlices,
			timerName: 'insights:timer',
			teeName: 'insights:tee',
			intervalMs: 5000,
			...opts,
		} )
	);
}

const VISIBILITY_RACE_INTERVAL_MS = 4321;

function useObservedVisibilityRace( wire, observations ) {
	const poll = useBatchedPoll( {
		build: buildSlices,
		timerName: 'visibility-race:timer',
		teeName: 'visibility-race:tee',
		intervalMs: VISIBILITY_RACE_INTERVAL_MS,
	} );
	useEffect( () => {
		const timer = Core.node( 'visibility-race:timer' );
		observations.push( {
			batches: wire.batches.length,
			mode: timer.mode,
			intervalMs: timer.interval_ms,
		} );
	}, [ wire, observations ] );
	return poll;
}

beforeEach( () => {
	Core.reset();
	// Every test posts; a suite-wide wire keeps each one from re-installing.
	installWire();
	Object.defineProperty( document, 'visibilityState', {
		configurable: true,
		get: () => 'visible',
	} );
} );

afterEach( () => {
	jest.restoreAllMocks();
	forgetSession();
	__setAuthFetch( null );
} );

describe( 'useBatchedPoll — backbone + boilerplate it owns', () => {
	test( 'mounts the backbone, `_http`, `_shell` Tap, the fan-out Tee + hitchhike Timer, each sinking into the interpreter', async () => {
		renderPoll( {} );
		await act( async () => {} );

		const interpreter = Core.node( INTERPRETER );
		expect( interpreter ).toBeTruthy();
		expect( Core.node( ROUTER ) ).toBeTruthy();
		for ( const name of [
			HTTP,
			SHELL,
			'insights:timer',
			'insights:tee',
		] ) {
			expect( Core.node( name ) ).toBeTruthy();
			expect( Core.node( name ).sink ).toBe( interpreter );
		}
		// The Timer hitchhikes the router TIMER and fans the tick to the Tee.
		expect( Core.node( 'insights:timer' ).target ).toBe( 'insights:tee' );
		expect( Core.node( ROUTER ).registrations.TIMER ).toHaveProperty(
			'insights:timer'
		);
	} );

	test( '`_http` reaches the wire with nothing injected', async () => {
		const wire = installWire();
		renderPoll( {} );
		await act( async () => {} );
		// HttpOut defaults its own client lazily, at the first post.
		expect( wire.batches.flat() ).not.toHaveLength( 0 );
	} );

	test( 'calls build with the interpreter and the fan-out Tee, wiring the slice fetchers', async () => {
		renderPoll( {} );
		await act( async () => {} );
		// build wired the three fetchers through addSliceFetcher.
		for ( const name of [ 'fetch-counts', 'fetch-top', 'fetch-acc' ] ) {
			expect( Core.node( name ) ).toBeTruthy();
			expect( Core.node( name ).target ).toBe( TARGET );
		}
		// All three are fanned from the owned Tee.
		expect( Core.node( 'insights:tee' ).target ).toEqual(
			expect.arrayContaining( [
				'fetch-counts',
				'fetch-top',
				'fetch-acc',
			] )
		);
	} );

	test( 'returns an interpreterRef pointing at the mounted interpreter', async () => {
		const { result } = renderPoll( {} );
		await act( async () => {} );
		expect( result.current.interpreterRef.current ).toBe(
			Core.node( INTERPRETER )
		);
	} );
} );

describe( 'useBatchedPoll — initial poll on mount', () => {
	test( 'fires one batched POST on mount (immediate first paint, not a one-interval wait)', async () => {
		const wire = installWire();
		renderPoll( {} );
		await act( async () => {} );

		expect( wire.batches.length ).toBe( 1 );
		expect( wire.batches[ 0 ].length ).toBe( 3 );
	} );

	test( 'does NOT fire the initial poll while the tab is hidden', async () => {
		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => 'hidden',
		} );
		const wire = installWire();
		renderPoll( {} );
		await act( async () => {} );
		expect( wire.batches.length ).toBe( 0 );
	} );

	test( 'DOES fire the initial poll when visible even if paused — paused suspends only ongoing polling, not the one-time first load', async () => {
		const wire = installWire();
		renderHook( () =>
			useBatchedPoll( {
				build: buildSlices,
				timerName: 'insights:timer',
				teeName: 'insights:tee',
				paused: true,
				intervalMs: 5000,
			} )
		);
		await act( async () => {} );
		expect( wire.batches.length ).toBe( 1 );
	} );

	test( 'keeps a paused first poll eligible until deferred authentication can sign it', async () => {
		const session = {
			handle: 'd3f3aa11d3f3bb22d3f3cc33d3f3dd44',
			key: 'deferred-first-poll-key-8391',
			expires_in: 7319,
			now: 2123456789,
		};
		let resolveAuth;
		const auth = new Promise( ( resolve ) => {
			resolveAuth = resolve;
		} );
		const wire = installWire();
		// AFTER installWire: it installs an auth stub of its own, and this
		// test's whole subject is a session that lands late.
		forgetSession();
		__setAuthFetch( () => auth );
		const nowSpy = jest
			.spyOn( Date, 'now' )
			.mockReturnValue( 1912345678000 );

		renderPoll( { paused: true } );
		await act( async () => {} );
		expect( wire.batches ).toHaveLength( 0 );

		await act( async () => {
			resolveAuth( session );
			await auth;
			await Promise.resolve();
		} );
		const router = Core.node( ROUTER );
		const timer = Core.node( 'insights:timer' );
		await act( async () => {
			router.fireCb();
		} );
		nowSpy.mockRestore();

		expect( wire.batches ).toHaveLength( 1 );
		expect( wire.batches[ 0 ] ).toHaveLength( 3 );
		for ( const message of wire.batches[ 0 ] ) {
			expect( message[ TIMESTAMP ] ).toBe( session.now );
			expect( message[ VALUE ].auth ).toEqual(
				expect.objectContaining( {
					handle: session.handle,
					sig: expect.stringMatching( /^[0-9a-f]{64}$/ ),
				} )
			);
		}

		await act( async () => {
			router.fireCb();
			router.fireCb();
		} );
		expect( wire.batches ).toHaveLength( 1 );
		expect( timer.mode ).toBe( 'inactive' );
	} );

	test( 'a hidden+paused mount still delivers the first load when the tab becomes visible (deep-link opened in a background tab)', async () => {
		// Spinner repro: hidden+paused mount must still fire the first load.
		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => 'hidden',
		} );
		const wire = installWire();
		renderHook( () =>
			useBatchedPoll( {
				build: buildSlices,
				timerName: 'insights:timer',
				teeName: 'insights:tee',
				paused: true,
				intervalMs: 5000,
			} )
		);
		await act( async () => {} );
		expect( wire.batches.length ).toBe( 0 ); // hidden ⇒ nothing yet

		await act( async () => {
			setVisibility( 'visible' );
		} );
		expect( wire.batches.length ).toBe( 1 );
		expect( wire.batches[ 0 ].length ).toBe( 3 );
	} );
} );

describe( 'useBatchedPoll — the batching bracket', () => {
	test( 'one router TIMER tick batches every slice command into ONE HttpOut POST', async () => {
		const wire = installWire();
		renderPoll( {} );
		await act( async () => {} );
		wire.batches.length = 0;

		await act( async () => {
			Core.node( ROUTER ).fireCb();
		} );

		// ONE POST for the whole tick — the batch assertion.
		expect( wire.batches.length ).toBe( 1 );
		expect( wire.batches[ 0 ].length ).toBe( 3 );
		const verbs = wire.batches[ 0 ].map( ( m ) => m[ VALUE ].name ).sort();
		expect( verbs ).toEqual( [ 'accumulated', 'counts', 'top' ] );
	} );

	test( 'brackets the tick: `_http` is locked before notify and flushed after (empty buffer ⇒ no POST when nothing fans out)', async () => {
		const wire = installWire();
		renderPoll( {} );
		await act( async () => {} );
		wire.batches.length = 0;

		// Remove the fan-out: tick emits no commands, empty buffer posts none.
		Core.node( 'insights:timer' ).disconnectNode( 'insights:tee' );
		await act( async () => {
			Core.node( ROUTER ).fireCb();
		} );
		expect( wire.batches.length ).toBe( 0 );
		expect( Core.node( HTTP ).locked ).toBe( false );
	} );
} );

describe( 'useBatchedPoll — page-visibility gate', () => {
	test( 'a same-commit transition to hidden neither polls nor arms the Timer', async () => {
		let state = 'visible';
		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => state,
		} );
		const addEventListener = document.addEventListener.bind( document );
		jest.spyOn( document, 'addEventListener' ).mockImplementation(
			( type, listener, options ) => {
				if ( 'visibilitychange' === type ) {
					state = 'hidden';
				}
				addEventListener( type, listener, options );
			}
		);
		const wire = installWire();
		const observations = [];

		renderHook( () => useObservedVisibilityRace( wire, observations ) );
		await act( async () => {} );

		expect( observations ).toEqual( [
			{ batches: 0, mode: 'inactive', intervalMs: 0 },
		] );
		expect( wire.batches ).toHaveLength( 0 );
		expect( Core.node( 'visibility-race:timer' ).mode ).toBe( 'inactive' );
	} );

	test( 'while the tab is HIDDEN no router tick posts; becoming visible resumes polling', async () => {
		const wire = installWire();
		renderPoll( {} );
		await act( async () => {} );
		wire.batches.length = 0;

		await act( async () => {
			setVisibility( 'hidden' );
		} );
		await act( async () => {
			Core.node( ROUTER ).fireCb();
		} );
		expect( wire.batches.length ).toBe( 0 );

		await act( async () => {
			setVisibility( 'visible' );
		} );
		await act( async () => {
			Core.node( ROUTER ).fireCb();
		} );
		expect( wire.batches.length ).toBe( 1 );
		expect( wire.batches[ 0 ].length ).toBe( 3 );
	} );
} );

describe( 'useBatchedPoll — paused gate', () => {
	test( 'while paused no router tick posts; unpausing resumes polling', async () => {
		const wire = installWire();
		const { rerender } = renderHook(
			( { paused } ) =>
				useBatchedPoll( {
					build: buildSlices,
					timerName: 'insights:timer',
					teeName: 'insights:tee',
					paused,
					intervalMs: 5000,
				} ),
			{ initialProps: { paused: false } }
		);
		await act( async () => {} );
		wire.batches.length = 0;

		// Pause (e.g. an Overview drag in flight): the tick fans out nothing.
		await act( async () => {
			rerender( { paused: true } );
		} );
		await act( async () => {
			Core.node( ROUTER ).fireCb();
		} );
		expect( wire.batches.length ).toBe( 0 );

		// Resume: the tick posts one batched POST again.
		await act( async () => {
			rerender( { paused: false } );
		} );
		await act( async () => {
			Core.node( ROUTER ).fireCb();
		} );
		expect( wire.batches.length ).toBe( 1 );
		expect( wire.batches[ 0 ].length ).toBe( 3 );
	} );
} );

describe( 'useBatchedPoll — intervalMs (hitchhike + throttle cadence)', () => {
	test( 'arms the owned Timer at the given intervalMs (hitchhike + throttle)', async () => {
		renderHook( () =>
			useBatchedPoll( {
				build: buildSlices,
				timerName: 'insights:timer',
				teeName: 'insights:tee',
				intervalMs: 5000,
			} )
		);
		await act( async () => {} );

		const timer = Core.node( 'insights:timer' );
		// > 1000 ms → hitchhike the router TIMER and throttle in fireCb().
		expect( timer.mode ).toBe( 'router' );
		expect( timer.interval_ms ).toBe( 5000 );
		expect( Core.node( ROUTER ).registrations.TIMER ).toHaveProperty(
			'insights:timer'
		);
	} );

	test( 'changing intervalMs re-arms the Timer to the new cadence', async () => {
		const { rerender } = renderHook(
			( { intervalMs } ) =>
				useBatchedPoll( {
					build: buildSlices,
					timerName: 'insights:timer',
					teeName: 'insights:tee',
					intervalMs,
				} ),
			{ initialProps: { intervalMs: 5000 } }
		);
		await act( async () => {} );
		expect( Core.node( 'insights:timer' ).interval_ms ).toBe( 5000 );

		await act( async () => {
			rerender( { intervalMs: 30000 } );
		} );
		expect( Core.node( 'insights:timer' ).interval_ms ).toBe( 30000 );
		expect( Core.node( 'insights:timer' ).mode ).toBe( 'router' );
	} );

	/**
	 * Was 'no intervalMs keeps the every-tick hitchhike'. It pinned the silent
	 * fallback, which is the defect: omitting the knob adopted the router's
	 * sub-second cadence, so the poll ran every tick. Omission now throws; see
	 * the 'intervalMs is required' block.
	 */
	/**
	 * At exactly 1000 armTimer called a BARE setTimer(), which sets
	 * interval_ms from `router.interval_ms` — so the dashboard's cadence was
	 * silently whatever the router happened to run. It matches today only
	 * because ROUTER_TICK_MS is also 1000. TimerNode hitchhikes at >= 1000, so
	 * 1000 must be passed through like any other value.
	 */
	test( 'a 1000 cadence is honoured, not inherited from the router tick', async () => {
		const { rerender } = renderHook(
			( { intervalMs } ) =>
				useBatchedPoll( {
					build: buildSlices,
					timerName: 'insights:timer',
					teeName: 'insights:tee',
					intervalMs,
				} ),
			{ initialProps: { intervalMs: 5000 } }
		);
		await act( async () => {} );
		// Move the router off its default so "inherited" and "honoured" differ.
		Core.node( '_router' ).interval_ms = 2000;

		await act( async () => {
			rerender( { intervalMs: 1000 } );
		} );

		const timer = Core.node( 'insights:timer' );
		expect( timer.mode ).toBe( 'router' );
		expect( timer.interval_ms ).toBe( 1000 );
	} );

	test( 'a cadence at the router floor adopts the router cadence', async () => {
		// Both branches hitchhike the router, so every tick stays inside the
		// lock/flush bracket; above 1000 throttles, at-or-below rides the
		// router's own cadence. Both dashboards ship a '1s' option and 1000 IS
		// that cadence, so the floor case is the batch at its fastest — never
		// an own slot, which is exactly what armTimer avoids.
		renderPoll( { intervalMs: 1000 } );
		await act( async () => {} );
		const timer = Core.node( 'insights:timer' );
		expect( timer.mode ).toBe( 'router' );
		expect( timer.interval_ms ).toBe( Core.node( '_router' ).interval_ms );
	} );
} );

describe( 'useBatchedPoll — teardown', () => {
	test( 'on unmount it removes the owned nodes', async () => {
		const { unmount } = renderPoll( {} );
		await act( async () => {} );

		unmount();

		// The backbone is torn down by its owner.
		expect( Core.node( INTERPRETER ) ).toBeNull();
		expect( Core.node( 'insights:tee' ) ).toBeNull();
		expect( Core.node( HTTP ) ).toBeNull();
	} );
} );

/**
 * The cadence knob had a silent fallback to the MOST expensive value: an
 * omitted `intervalMs` armed a bare `setTimer()`, firing every router tick at
 * 1Hz. CHANGELOG v2.5.0 records that shipping once, with `useTopologyManager`
 * hammering its CI at 1Hz while `deriveConnected` judged staleness in seconds.
 * Of five consumers only one was unconditionally safe: two passed
 * `parseInt(…) || 0`, which LOOKS configured and lands on 1Hz, and one omitted
 * it entirely. Required config fails loud.
 */
describe( 'useBatchedPoll — intervalMs is required', () => {
	// The guard runs before the first hook call, so it is a plain precondition
	// — asserted directly, which keeps React's error logging out of it.
	const call = ( intervalMs ) => () =>
		useBatchedPoll( {
			build: buildSlices,
			timerName: 'insights:timer',
			teeName: 'insights:tee',
			...( undefined === intervalMs ? {} : { intervalMs } ),
		} );

	test( 'throws when omitted rather than polling every router tick', () => {
		expect( call( undefined ) ).toThrow( /intervalMs/ );
	} );

	test( 'throws on 0 — the value `parseInt( x, 10 ) || 0` yields', () => {
		expect( call( 0 ) ).toThrow( /intervalMs/ );
	} );

	// Below the hitchhike threshold TimerNode takes an own slot, which fires
	// OUTSIDE the lock/flush bracket — one POST per slice per tick, no batch.
	test( 'throws below the 1000 hitchhike threshold — that is no batch at all', () => {
		expect( call( 750 ) ).toThrow( /1000/ );
	} );

	test( 'names the timer, so the throw says WHICH dashboard', () => {
		expect( call( 0 ) ).toThrow( /insights:timer/ );
	} );
} );

/**
 * A filter change wants an immediate refresh. The tick already fans to every
 * slice inside the router's lock/flush bracket, with each slice's argsFn()
 * reading live refs — so firing it early IS the operation. Consumers that
 * rebuilt that bracket around hand-sent copies of the same verbs (three times
 * in one file, each re-finding `_http` by hardcoded name) were re-implementing
 * this.
 */
describe( 'useBatchedPoll — pollNow()', () => {
	test( 'fires every slice off-cadence in ONE POST', async () => {
		const wire = installWire();
		const { result } = renderPoll( {} );
		await act( async () => {} );
		wire.batches.length = 0;

		await act( async () => result.current.pollNow() );

		expect( wire.batches ).toHaveLength( 1 );
		expect( wire.batches[ 0 ].length ).toBe( SLICES.length );
	} );
} );
