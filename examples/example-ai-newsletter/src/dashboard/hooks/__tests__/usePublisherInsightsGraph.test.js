/**
 * usePublisherInsightsGraph tests — the Publisher Insights dashboard as a GENUINE
 * node graph, not a god object. The graph is:
 *
 *   insights:timer (Timer) ─> insights:tee (Tee) ─> fetch-counts (Fetcher) ─┐
 *                                                 ├> fetch-top    (Fetcher) ─┤  target = _shell/_http/insights-demo
 *                                                 └> fetch-acc    (Fetcher) ─┘
 *   countsIn (Tee) ─> source-counts:view ─> <SourceCounts/>
 *   topIn    (Tee) ─> top-table:view     ─> <TopTable/>
 *   accIn    (Tee) ─> accumulated:view   ─> <AccumulatedCard/>
 *
 * The Timer hitchhikes the router tick; the router brackets each tick with
 * `_http` lock/flush, so all three fetcher commands batch into ONE HttpOut POST.
 */

import { renderHook, act } from '@testing-library/react';
import {
	newMessage,
	ID,
	TO,
	FROM,
	VALUE,
	TYPE,
	TM_COMMAND,
	TM_RESPONSE,
	Core,
} from '@newspack-nodes/runtime';
import { usePublisherInsightsGraph } from '../usePublisherInsightsGraph';

const INTERPRETER = '_command_interpreter';
const ROUTER = '_router';
const HTTP = '_http';
const SHELL = '_shell';

// Drive document.visibilityState the same way the substrate's usePageVisibility
// test does — set the getter, then dispatch the visibilitychange event.
function setVisibility( state ) {
	Object.defineProperty( document, 'visibilityState', {
		configurable: true,
		get: () => state,
	} );
	document.dispatchEvent( new Event( 'visibilitychange' ) );
}

// A fake CommandClient matching HttpOut's seam: postBatch records each batch and
// echoes a reply addressed back along FROM, payload keyed by the posted verb.
function makeFakeClient( payloadByVerb = {} ) {
	const client = {
		batches: [],
		postBatch( messages ) {
			client.batches.push( messages );
			const replies = messages.map( ( m ) => {
				const reply = newMessage();
				reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
				reply[ TO ] = m[ FROM ];
				reply[ ID ] = m[ ID ];
				reply[ VALUE ] = {
					name: m[ VALUE ]?.name,
					payload: payloadByVerb[ m[ VALUE ]?.name ] ?? null,
				};
				return reply;
			} );
			return Promise.resolve( replies );
		},
	};
	return client;
}

const emptyPayloads = {
	counts: JSON.stringify( { sources: {} } ),
	top: JSON.stringify( { top: [] } ),
	accumulated: JSON.stringify( { accumulated: 0 } ),
};

beforeEach( () => {
	Core.reset();
	// Each test starts with a visible tab so visibility state can't leak.
	Object.defineProperty( document, 'visibilityState', {
		configurable: true,
		get: () => 'visible',
	} );
} );

describe( 'usePublisherInsightsGraph — graph wiring', () => {
	test( 'mounts the backbone, `_http`, `_shell` tap, the timer/tee/fetchers, and three view nodes, each sinking into the interpreter', async () => {
		const client = makeFakeClient( emptyPayloads );
		renderHook( () =>
			usePublisherInsightsGraph( { commandClient: client } )
		);
		await act( async () => {} );

		const interpreter = Core.node( INTERPRETER );
		expect( interpreter ).toBeTruthy();
		expect( Core.node( ROUTER ) ).toBeTruthy();

		const names = [
			HTTP,
			SHELL,
			'insights:timer',
			'insights:tee',
			'fetch-counts',
			'fetch-top',
			'fetch-acc',
			'countsIn',
			'topIn',
			'accIn',
			'source-counts:view',
			'top-table:view',
			'accumulated:view',
		];
		for ( const name of names ) {
			const node = Core.node( name );
			expect( node ).toBeTruthy();
			expect( node.sink ).toBe( interpreter );
		}
	} );

	test( '`_http` has the injected CommandClient as its client', async () => {
		const client = makeFakeClient( emptyPayloads );
		renderHook( () =>
			usePublisherInsightsGraph( { commandClient: client } )
		);
		await act( async () => {} );
		expect( Core.node( HTTP ).client ).toBe( client );
	} );

	test( 'each Fetcher is configured with its receiver + verb and targets `_shell/_http/insights-demo`', async () => {
		const client = makeFakeClient( emptyPayloads );
		renderHook( () =>
			usePublisherInsightsGraph( { commandClient: client } )
		);
		await act( async () => {} );
		const path = `${ SHELL }/${ HTTP }/insights-demo`;
		expect( Core.node( 'fetch-counts' ).receiver ).toBe( 'countsIn' );
		expect( Core.node( 'fetch-counts' ).verb ).toBe( 'counts' );
		expect( Core.node( 'fetch-counts' ).target ).toBe( path );
		expect( Core.node( 'fetch-top' ).verb ).toBe( 'top' );
		expect( Core.node( 'fetch-top' ).target ).toBe( path );
		expect( Core.node( 'fetch-acc' ).verb ).toBe( 'accumulated' );
		expect( Core.node( 'fetch-acc' ).target ).toBe( path );
	} );
} );

describe( 'usePublisherInsightsGraph — batched poll', () => {
	test( 'one router TIMER tick emits exactly three TM_COMMANDs (counts/top/accumulated, FROM=their receivers) batched into ONE HttpOut POST', async () => {
		const client = makeFakeClient( emptyPayloads );
		renderHook( () =>
			usePublisherInsightsGraph( { commandClient: client } )
		);
		await act( async () => {} );
		client.batches.length = 0;

		await act( async () => {
			Core.node( ROUTER ).fireCb();
		} );

		// ONE POST for the whole tick — the batch assertion.
		expect( client.batches.length ).toBe( 1 );
		const batch = client.batches[ 0 ];
		expect( batch.length ).toBe( 3 );

		const byVerb = Object.fromEntries(
			batch.map( ( m ) => [ m[ VALUE ].name, m ] )
		);
		expect( Object.keys( byVerb ).sort() ).toEqual( [
			'accumulated',
			'counts',
			'top',
		] );
		// HttpOut strips `_shell/_http/`, so the posted TO is the bare server node.
		expect( byVerb.counts[ TO ] ).toBe( 'insights-demo' );
		expect( byVerb.counts[ FROM ] ).toBe( 'countsIn' );
		expect( byVerb.top[ FROM ] ).toBe( 'topIn' );
		expect( byVerb.accumulated[ FROM ] ).toBe( 'accIn' );
	} );

	test( 'while the tab is HIDDEN no router tick posts; becoming visible resumes polling', async () => {
		const client = makeFakeClient( emptyPayloads );
		renderHook( () =>
			usePublisherInsightsGraph( { commandClient: client } )
		);
		await act( async () => {} );
		client.batches.length = 0;

		// Tab hidden: the timer must unregister from the router TIMER, so a tick
		// fans out to nothing — no fetcher commands, no HttpOut POST.
		await act( async () => {
			setVisibility( 'hidden' );
		} );
		await act( async () => {
			Core.node( ROUTER ).fireCb();
		} );
		expect( client.batches.length ).toBe( 0 );

		// Tab visible again: polling resumes — the next tick posts one batch.
		await act( async () => {
			setVisibility( 'visible' );
		} );
		await act( async () => {
			Core.node( ROUTER ).fireCb();
		} );
		expect( client.batches.length ).toBe( 1 );
		expect( client.batches[ 0 ].length ).toBe( 3 );
	} );

	test( 'each slice reply routes back to its own view node and lands in its slice', async () => {
		const client = makeFakeClient( {
			counts: JSON.stringify( { sources: { releases: 2 } } ),
			top: JSON.stringify( {
				top: [ { source: 'releases', title: 'X', score: 5 } ],
			} ),
			accumulated: JSON.stringify( { accumulated: 7 } ),
		} );
		renderHook( () =>
			usePublisherInsightsGraph( { commandClient: client } )
		);
		await act( async () => {
			Core.node( ROUTER ).fireCb();
		} );

		expect( Core.node( 'source-counts:view' ).setStateCache.view ).toEqual(
			{ sources: { releases: 2 } }
		);
		expect( Core.node( 'top-table:view' ).setStateCache.view ).toEqual( {
			top: [ { source: 'releases', title: 'X', score: 5 } ],
		} );
		expect( Core.node( 'accumulated:view' ).setStateCache.view ).toEqual( {
			accumulated: 7,
		} );
	} );
} );
