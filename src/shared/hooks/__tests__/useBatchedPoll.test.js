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
import { useEffect } from '@wordpress/element';
import {
	Core,
	Node,
	ID,
	TO,
	FROM,
	VALUE,
	TYPE,
	TIMESTAMP,
	TM_COMMAND,
	TM_RESPONSE,
	CommandInterpreterNode,
	forgetSession,
	__setAuthFetch,
	newMessage,
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

// A fake CommandClient matching HttpOut's seam: records each batch.
function makeFakeClient() {
	const client = {
		batches: [],
		postBatch( messages ) {
			client.batches.push( messages );
			const replies = messages.map( ( m ) => {
				const reply = newMessage();
				reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
				reply[ TO ] = m[ FROM ];
				reply[ ID ] = m[ ID ];
				reply[ VALUE ] = { name: m[ VALUE ]?.name, payload: null };
				return reply;
			} );
			return Promise.resolve( replies );
		},
	};
	return client;
}

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

function renderPoll( opts = {} ) {
	return renderHook( () =>
		useBatchedPoll( {
			build: buildSlices,
			timerName: 'insights:timer',
			teeName: 'insights:tee',
			...opts,
		} )
	);
}

const VISIBILITY_RACE_INTERVAL_MS = 4321;

function useObservedVisibilityRace( client, observations ) {
	const poll = useBatchedPoll( {
		build: buildSlices,
		timerName: 'visibility-race:timer',
		teeName: 'visibility-race:tee',
		commandClient: client,
		intervalMs: VISIBILITY_RACE_INTERVAL_MS,
	} );
	useEffect( () => {
		const timer = Core.node( 'visibility-race:timer' );
		observations.push( {
			batches: client.batches.length,
			mode: timer.mode,
			intervalMs: timer.interval_ms,
		} );
	}, [ client, observations ] );
	return poll;
}

beforeEach( () => {
	Core.reset();
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
		renderPoll( { commandClient: makeFakeClient() } );
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

	test( '`_http` gets the injected CommandClient as its client', async () => {
		const client = makeFakeClient();
		renderPoll( { commandClient: client } );
		await act( async () => {} );
		expect( Core.node( HTTP ).client ).toBe( client );
	} );

	test( 'calls build with the interpreter and the fan-out Tee, wiring the slice fetchers', async () => {
		renderPoll( { commandClient: makeFakeClient() } );
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
		const { result } = renderPoll( { commandClient: makeFakeClient() } );
		await act( async () => {} );
		expect( result.current.interpreterRef.current ).toBe(
			Core.node( INTERPRETER )
		);
	} );
} );

describe( 'useBatchedPoll — initial poll on mount', () => {
	test( 'fires one batched POST on mount (immediate first paint, not a one-interval wait)', async () => {
		const client = makeFakeClient();
		renderPoll( { commandClient: client } );
		await act( async () => {} );

		expect( client.batches.length ).toBe( 1 );
		expect( client.batches[ 0 ].length ).toBe( 3 );
	} );

	test( 'does NOT fire the initial poll while the tab is hidden', async () => {
		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => 'hidden',
		} );
		const client = makeFakeClient();
		renderPoll( { commandClient: client } );
		await act( async () => {} );
		expect( client.batches.length ).toBe( 0 );
	} );

	test( 'DOES fire the initial poll when visible even if paused — paused suspends only ongoing polling, not the one-time first load', async () => {
		const client = makeFakeClient();
		renderHook( () =>
			useBatchedPoll( {
				build: buildSlices,
				timerName: 'insights:timer',
				teeName: 'insights:tee',
				commandClient: client,
				paused: true,
			} )
		);
		await act( async () => {} );
		expect( client.batches.length ).toBe( 1 );
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
		forgetSession();
		__setAuthFetch( () => auth );
		const nowSpy = jest
			.spyOn( Date, 'now' )
			.mockReturnValue( 1912345678000 );
		const client = makeFakeClient();

		renderPoll( { commandClient: client, paused: true } );
		await act( async () => {} );
		expect( client.batches ).toHaveLength( 0 );

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

		expect( client.batches ).toHaveLength( 1 );
		expect( client.batches[ 0 ] ).toHaveLength( 3 );
		for ( const message of client.batches[ 0 ] ) {
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
		expect( client.batches ).toHaveLength( 1 );
		expect( timer.mode ).toBe( 'inactive' );
	} );

	test( 'a hidden+paused mount still delivers the first load when the tab becomes visible (deep-link opened in a background tab)', async () => {
		// Spinner repro: hidden+paused mount must still fire the first load.
		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => 'hidden',
		} );
		const client = makeFakeClient();
		renderHook( () =>
			useBatchedPoll( {
				build: buildSlices,
				timerName: 'insights:timer',
				teeName: 'insights:tee',
				commandClient: client,
				paused: true,
			} )
		);
		await act( async () => {} );
		expect( client.batches.length ).toBe( 0 ); // hidden ⇒ nothing yet

		await act( async () => {
			setVisibility( 'visible' );
		} );
		expect( client.batches.length ).toBe( 1 );
		expect( client.batches[ 0 ].length ).toBe( 3 );
	} );
} );

describe( 'useBatchedPoll — the batching bracket', () => {
	test( 'one router TIMER tick batches every slice command into ONE HttpOut POST', async () => {
		const client = makeFakeClient();
		renderPoll( { commandClient: client } );
		await act( async () => {} );
		client.batches.length = 0;

		await act( async () => {
			Core.node( ROUTER ).fireCb();
		} );

		// ONE POST for the whole tick — the batch assertion.
		expect( client.batches.length ).toBe( 1 );
		expect( client.batches[ 0 ].length ).toBe( 3 );
		const verbs = client.batches[ 0 ]
			.map( ( m ) => m[ VALUE ].name )
			.sort();
		expect( verbs ).toEqual( [ 'accumulated', 'counts', 'top' ] );
	} );

	test( 'brackets the tick: `_http` is locked before notify and flushed after (empty buffer ⇒ no POST when nothing fans out)', async () => {
		const client = makeFakeClient();
		renderPoll( { commandClient: client } );
		await act( async () => {} );
		client.batches.length = 0;

		// Remove the fan-out: tick emits no commands, empty buffer posts none.
		Core.node( 'insights:timer' ).disconnectNode( 'insights:tee' );
		await act( async () => {
			Core.node( ROUTER ).fireCb();
		} );
		expect( client.batches.length ).toBe( 0 );
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
		const client = makeFakeClient();
		const observations = [];

		renderHook( () => useObservedVisibilityRace( client, observations ) );
		await act( async () => {} );

		expect( observations ).toEqual( [
			{ batches: 0, mode: 'inactive', intervalMs: 0 },
		] );
		expect( client.batches ).toHaveLength( 0 );
		expect( Core.node( 'visibility-race:timer' ).mode ).toBe( 'inactive' );
	} );

	test( 'while the tab is HIDDEN no router tick posts; becoming visible resumes polling', async () => {
		const client = makeFakeClient();
		renderPoll( { commandClient: client } );
		await act( async () => {} );
		client.batches.length = 0;

		await act( async () => {
			setVisibility( 'hidden' );
		} );
		await act( async () => {
			Core.node( ROUTER ).fireCb();
		} );
		expect( client.batches.length ).toBe( 0 );

		await act( async () => {
			setVisibility( 'visible' );
		} );
		await act( async () => {
			Core.node( ROUTER ).fireCb();
		} );
		expect( client.batches.length ).toBe( 1 );
		expect( client.batches[ 0 ].length ).toBe( 3 );
	} );
} );

describe( 'useBatchedPoll — paused gate', () => {
	test( 'while paused no router tick posts; unpausing resumes polling', async () => {
		const client = makeFakeClient();
		const { rerender } = renderHook(
			( { paused } ) =>
				useBatchedPoll( {
					build: buildSlices,
					timerName: 'insights:timer',
					teeName: 'insights:tee',
					commandClient: client,
					paused,
				} ),
			{ initialProps: { paused: false } }
		);
		await act( async () => {} );
		client.batches.length = 0;

		// Pause (e.g. an Overview drag in flight): the tick fans out nothing.
		await act( async () => {
			rerender( { paused: true } );
		} );
		await act( async () => {
			Core.node( ROUTER ).fireCb();
		} );
		expect( client.batches.length ).toBe( 0 );

		// Resume: the tick posts one batched POST again.
		await act( async () => {
			rerender( { paused: false } );
		} );
		await act( async () => {
			Core.node( ROUTER ).fireCb();
		} );
		expect( client.batches.length ).toBe( 1 );
		expect( client.batches[ 0 ].length ).toBe( 3 );
	} );
} );

describe( 'useBatchedPoll — intervalMs (hitchhike + throttle cadence)', () => {
	test( 'arms the owned Timer at the given intervalMs (hitchhike + throttle)', async () => {
		renderHook( () =>
			useBatchedPoll( {
				build: buildSlices,
				timerName: 'insights:timer',
				teeName: 'insights:tee',
				commandClient: makeFakeClient(),
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
					commandClient: makeFakeClient(),
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

	test( 'no intervalMs keeps the every-tick hitchhike (interval_ms 0)', async () => {
		renderPoll( { commandClient: makeFakeClient() } );
		await act( async () => {} );
		expect( Core.node( 'insights:timer' ).interval_ms ).toBe( 0 );
		expect( Core.node( 'insights:timer' ).mode ).toBe( 'router' );
	} );
} );

describe( 'useBatchedPoll — teardown', () => {
	test( 'on unmount it clears the router lock/flush hooks and removes the owned nodes', async () => {
		const { unmount } = renderPoll( { commandClient: makeFakeClient() } );
		await act( async () => {} );
		const router = Core.node( ROUTER );
		expect( router.beforeTimerNotify ).toBeTruthy();

		unmount();

		// The backbone is torn down (owner) and the lock/flush hooks cleared.
		expect( Core.node( INTERPRETER ) ).toBeNull();
		expect( Core.node( 'insights:tee' ) ).toBeNull();
		expect( Core.node( HTTP ) ).toBeNull();
	} );
} );
