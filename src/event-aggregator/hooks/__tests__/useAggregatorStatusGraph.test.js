/**
 * useAggregatorStatusGraph tests — the de-god Aggregator Status graph built on
 * the substrate batched-poll toolkit (useBatchedPoll + addSliceFetcher). The
 * single god `status` poll feeding one `aggregator:view` is gone; in its place
 * two independent slice paths:
 *
 *   <tee> → fetch-summary  (Fetcher, FROM=summary:view) → _shell/_http/aggregator
 *           summaryIn (Tee) → summary:view (AggregatorSummaryView)
 *   <tee> → fetch-servers  (Fetcher, FROM=servers:view) → _shell/_http/aggregator
 *           serversIn (Tee) → servers:view (AggregatorServersView)
 *
 * Each slice has its OWN inspectable reply path (its own command + receiver Tee);
 * a reply to `summary` never touches `servers:view` and vice-versa. useBatchedPoll
 * owns the Timer/Tee/_shell/_http + lock-flush batching; both slices ride one POST
 * per tick. _http.client is injected via opts.commandClient (no network in tests).
 */

import { renderHook, act } from '@testing-library/react';
import {
	newMessage,
	TO,
	FROM,
	VALUE,
	TYPE,
	TM_COMMAND,
	TM_RESPONSE,
	Core,
	useNodeState,
} from '@newspack-nodes/runtime';
import { useAggregatorStatusGraph } from '../useAggregatorStatusGraph';

const INTERPRETER = '_command_interpreter';
const ROUTER = '_router';
const HTTP = '_http';
const SHELL = '_shell';
const SUMMARY_VIEW = 'summary:view';
const SERVERS_VIEW = 'servers:view';
const SLICE_VIEWS = [ SUMMARY_VIEW, SERVERS_VIEW ];

// Fake CommandClient: records batches, mints one TO=FROM reply per message.
function makeFakeClient( { summary = {}, servers = [] } = {} ) {
	const client = {
		batches: [],
		postBatch( messages ) {
			client.batches.push( messages );
			const replies = messages.map( ( m ) => {
				const reply = newMessage();
				reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
				reply[ TO ] = m[ FROM ]; // server's TO=FROM reply
				const name = m[ VALUE ]?.name;
				const payload =
					'summary' === name
						? JSON.stringify( summary )
						: JSON.stringify( servers );
				reply[ VALUE ] = { name, payload };
				return reply;
			} );
			return Promise.resolve( replies );
		},
	};
	return client;
}

beforeEach( () => {
	Core.reset();
	window.localStorage.clear();
} );

describe( 'useAggregatorStatusGraph — batched-poll backbone + slice wiring', () => {
	test( 'mounts the backbone, _http/_shell, and both slice views (each sinking into the interpreter)', () => {
		renderHook( () =>
			useAggregatorStatusGraph( { commandClient: makeFakeClient() } )
		);
		const interpreter = Core.node( INTERPRETER );
		expect( interpreter ).toBeTruthy();
		expect( Core.node( ROUTER ) ).toBeTruthy();
		expect( Core.node( HTTP ) ).toBeTruthy();
		expect( Core.node( SHELL ) ).toBeTruthy();
		for ( const name of SLICE_VIEWS ) {
			const node = Core.node( name );
			expect( node ).toBeTruthy();
			expect( node.sink ).toBe( interpreter );
		}
	} );

	test( 'does NOT mount _output / _completion / _uptime / _cwd (dashboards are not REPLs)', () => {
		renderHook( () =>
			useAggregatorStatusGraph( { commandClient: makeFakeClient() } )
		);
		for ( const name of [ '_output', '_completion', '_uptime', '_cwd' ] ) {
			expect( Core.node( name ) ).toBeNull();
		}
	} );

	test( '_http has the injected CommandClient as its client', () => {
		const client = makeFakeClient();
		renderHook( () =>
			useAggregatorStatusGraph( { commandClient: client } )
		);
		expect( Core.node( HTTP ).client ).toBe( client );
	} );

	test( 'mounts a Fetcher + receiver Tee per slice (own reply path each)', () => {
		renderHook( () =>
			useAggregatorStatusGraph( { commandClient: makeFakeClient() } )
		);
		for ( const name of [
			'fetch-summary',
			'fetch-servers',
			'summaryIn',
			'serversIn',
		] ) {
			expect( Core.node( name ) ).toBeTruthy();
		}
	} );

	test( 'fires both slice commands on mount (summary + servers_status), batched into one POST', () => {
		const client = makeFakeClient();
		renderHook( () =>
			useAggregatorStatusGraph( { commandClient: client } )
		);
		expect( client.batches.length ).toBeGreaterThanOrEqual( 1 );
		const verbs = client.batches[ 0 ]
			.map( ( m ) => m[ VALUE ].name )
			.sort();
		expect( verbs ).toEqual( [ 'servers_status', 'summary' ] );
		// Each command's FROM is its own receiver Tee, the reply target.
		const froms = client.batches[ 0 ].map( ( m ) => m[ FROM ] ).sort();
		expect( froms ).toEqual( [ 'serversIn', 'summaryIn' ] );
	} );

	test( 'returns the current refresh interval (defaults to 2000)', () => {
		const { result } = renderHook( () =>
			useAggregatorStatusGraph( { commandClient: makeFakeClient() } )
		);
		expect( result.current.refreshInterval ).toBe( '2000' );
	} );
} );

describe( 'useAggregatorStatusGraph — end-to-end routing into each slice view', () => {
	test( 'the summary reply lands ONLY in summary:view; the servers reply ONLY in servers:view', async () => {
		const client = makeFakeClient( {
			summary: { connected: 1, total: 2, server_now: 1748960000 },
			servers: [
				{ id: 'server1', partitions: { 0: { connected: true } } },
				{ id: 'server2', partitions: {} },
			],
		} );
		renderHook( () =>
			useAggregatorStatusGraph( { commandClient: client } )
		);
		await act( async () => {} );

		const summary = Core.node( SUMMARY_VIEW ).setStateCache.view;
		expect( summary.connected ).toBe( 1 );
		expect( summary.total ).toBe( 2 );
		expect( summary.serverNow ).toBe( 1748960000 );
		expect( summary.loading ).toBe( false );
		// summary slice carries NO servers array.
		expect( summary.servers ).toBeUndefined();

		const servers = Core.node( SERVERS_VIEW ).setStateCache.view;
		expect( servers.servers.map( ( s ) => s.id ) ).toEqual( [
			'server1',
			'server2',
		] );
		expect( servers.loading ).toBe( false );
		// servers slice carries NO counts.
		expect( servers.connected ).toBeUndefined();
	} );
} );

describe( 'useAggregatorStatusGraph — poll interval', () => {
	beforeEach( () => jest.useFakeTimers() );
	afterEach( () => jest.useRealTimers() );

	test( 'polls again after the configured interval elapses', () => {
		const client = makeFakeClient();
		renderHook( () =>
			useAggregatorStatusGraph( { commandClient: client } )
		);
		const afterMount = client.batches.length;
		act( () => {
			jest.advanceTimersByTime( 2000 );
		} );
		expect( client.batches.length ).toBeGreaterThan( afterMount );
	} );
} );

describe( 'useAggregatorStatusGraph — refresh interval control', () => {
	test( 'setRefreshInterval persists the choice to localStorage', () => {
		const { result } = renderHook( () =>
			useAggregatorStatusGraph( { commandClient: makeFakeClient() } )
		);
		act( () => result.current.setRefreshInterval( '5000' ) );
		expect( result.current.refreshInterval ).toBe( '5000' );
		expect(
			window.localStorage.getItem( 'aggregator-status-refresh' )
		).toBe( '5000' );
	} );

	test( 'seeds the interval from a previously-persisted localStorage value', () => {
		window.localStorage.setItem( 'aggregator-status-refresh', '10000' );
		const { result } = renderHook( () =>
			useAggregatorStatusGraph( { commandClient: makeFakeClient() } )
		);
		expect( result.current.refreshInterval ).toBe( '10000' );
	} );

	test( 'ignores an invalid persisted value and falls back to the default', () => {
		window.localStorage.setItem( 'aggregator-status-refresh', '999' );
		const { result } = renderHook( () =>
			useAggregatorStatusGraph( { commandClient: makeFakeClient() } )
		);
		expect( result.current.refreshInterval ).toBe( '2000' );
	} );
} );

describe( 'useAggregatorStatusGraph — teardown', () => {
	test( 'unmount unregisters every slice view + the backbone', () => {
		const { unmount } = renderHook( () =>
			useAggregatorStatusGraph( { commandClient: makeFakeClient() } )
		);
		unmount();
		for ( const name of [ ...SLICE_VIEWS, INTERPRETER, ROUTER, HTTP ] ) {
			expect( Core.node( name ) ).toBeNull();
		}
	} );
} );

describe( 'useAggregatorStatusGraph — Core.reinit (Reset Graph)', () => {
	test( 'Core.reinit re-renders the consumer so useNodeState re-subscribes to the fresh views', async () => {
		const client = makeFakeClient();
		const { result } = renderHook( () => {
			useAggregatorStatusGraph( { commandClient: client } );
			return useNodeState( SUMMARY_VIEW, 'view' );
		} );
		await act( async () => {} );
		const firstView = Core.node( SUMMARY_VIEW );

		await act( async () => {
			Core.reinit();
		} );
		const freshView = Core.node( SUMMARY_VIEW );
		expect( freshView ).not.toBe( firstView );

		act( () => {
			freshView.setState( 'view', { total: 7 } );
		} );
		expect( result.current ).toEqual( { total: 7 } );
	} );
} );
