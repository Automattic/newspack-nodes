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
import {
	Core,
	Node,
	ID,
	TO,
	FROM,
	VALUE,
	TYPE,
	TM_COMMAND,
	TM_RESPONSE,
	CommandInterpreterNode,
	newMessage,
} from '@newspack-nodes/runtime';
import { addSliceFetcher } from '../../helpers/addSliceFetcher';
import { useBatchedPoll } from '../useBatchedPoll';

const INTERPRETER = '_command_interpreter';
const ROUTER = '_router';
const HTTP = '_http';
const SHELL = '_shell';

// Lightweight registered view classes so makeNode can build the slice views
// without coupling the substrate test to the example app's node classes. Like a
// real SliceViewNode, fill() CONSUMES its reply (it's the sink) — it doesn't
// forward, so a reply doesn't bounce back through the interpreter unaddressed.
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

// Drive document.visibilityState (matches the example + usePageVisibility tests).
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

beforeEach( () => {
	Core.reset();
	Object.defineProperty( document, 'visibilityState', {
		configurable: true,
		get: () => 'visible',
	} );
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

	test( 'does NOT fire the initial poll while paused', async () => {
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
		expect( client.batches.length ).toBe( 0 );
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

		// Remove the fan-out so the tick produces no commands; the bracket still
		// runs (lock then flush) but an empty buffer posts nothing.
		Core.node( 'insights:timer' ).disconnectNode( 'insights:tee' );
		await act( async () => {
			Core.node( ROUTER ).fireCb();
		} );
		expect( client.batches.length ).toBe( 0 );
		expect( Core.node( HTTP ).locked ).toBe( false );
	} );
} );

describe( 'useBatchedPoll — page-visibility gate', () => {
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
