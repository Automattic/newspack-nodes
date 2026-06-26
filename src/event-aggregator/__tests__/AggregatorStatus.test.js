/**
 * AggregatorStatus UI-surface tests — the thin view over the DE-GOD aggregator
 * node graph. The single god `aggregator:view` is gone; the dashboard now reads
 * two independent per-concern slices, each from its own view node:
 *
 *   summary:view → <AggregatorSummary> (header: counts + snapshot clock)
 *   servers:view → <AggregatorServers> (server cards + partition grids)
 *
 * The graph is owned by useAggregatorStatusGraph (tested separately); here we mock
 * it to hand back spy control callbacks, and we register fixture slice nodes in
 * Core so each widget can read its model via useNodeState.
 */

jest.mock( '../hooks/useAggregatorStatusGraph', () => {
	const actual = jest.requireActual( '../hooks/useAggregatorStatusGraph' );
	return {
		__esModule: true,
		...actual,
		useAggregatorStatusGraph: jest.fn(),
	};
} );

import { createElement } from '@wordpress/element';
import { render, act } from '@testing-library/react';
import { Core } from '@newspack-nodes/runtime';
import AggregatorStatus from '../AggregatorStatus';

const {
	useAggregatorStatusGraph,
} = require( '../hooks/useAggregatorStatusGraph' );

const SAMPLE_SERVERS = [
	{
		id: 'server1',
		url: 'https://a.example.test',
		partitions: {
			0: {
				connected: true,
				last_heartbeat_response: 1748960010,
				last_heartbeat_rtt: 42,
				last_connection_attempt: 1748960000,
				last_sse_heartbeat: 1748960010,
			},
			1: {
				connected: false,
				last_error: 'timeout',
				last_http_code: 504,
			},
		},
	},
	{
		id: 'server2',
		url: 'https://b.example.test',
		partitions: {},
	},
];

// A minimal stand-in for a slice view node: the model lives in setStateCache.view
// (what useNodeState subscribes to). setState here notifies subscribers exactly
// like the real Node.setState.
function fixtureNode( name, model ) {
	const node = {
		registrations: { view: {} },
		setStateCache: {},
		register( event, listener, cb ) {
			this.registrations[ event ][ listener ] = cb;
			if ( event in this.setStateCache ) {
				cb( this.setStateCache[ event ] );
			}
		},
		unregister( event, listener ) {
			delete this.registrations[ event ]?.[ listener ];
		},
		setState( event, payload ) {
			this.setStateCache[ event ] = payload;
			Object.values( this.registrations[ event ] || {} ).forEach(
				( cb ) => cb( payload )
			);
		},
	};
	node.setState( 'view', model );
	Core.nodes.set( name, node );
	return node;
}

// Register the two per-concern slice fixtures the de-god dashboard reads.
function registerSlices( { summary = {}, servers = {} } = {} ) {
	fixtureNode( 'summary:view', {
		connected: 0,
		total: 0,
		serverNow: null,
		error: null,
		loading: true,
		lastRefresh: null,
		...summary,
	} );
	fixtureNode( 'servers:view', {
		servers: null,
		error: null,
		loading: true,
		...servers,
	} );
}

describe( 'AggregatorStatus', () => {
	let setRefreshInterval;
	const mounted = [];

	beforeEach( () => {
		Core.reset();
		window.localStorage.clear();
		setRefreshInterval = jest.fn();
		useAggregatorStatusGraph.mockClear();
		useAggregatorStatusGraph.mockReturnValue( {
			setRefreshInterval,
			refreshInterval: '2000',
		} );
	} );

	afterEach( () => {
		while ( mounted.length ) {
			mounted.pop().unmount();
		}
	} );

	function mount() {
		const r = render( createElement( AggregatorStatus ) );
		mounted.push( r );
		return r;
	}

	it( 'shows the loading state before the first poll publishes', () => {
		registerSlices( { servers: { loading: true } } );
		const { container } = mount();
		expect( container.textContent ).toContain( 'Loading server status' );
	} );

	it( 'renders server cards from the servers slice', () => {
		registerSlices( {
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		expect( container.textContent ).toContain( 'server1' );
		expect( container.textContent ).toContain( 'server2' );
		expect( container.textContent ).toContain( 'p0' );
		expect( container.textContent ).toContain( 'p1' );
	} );

	it( 'renders the connected/total count from the summary slice (not the servers slice)', () => {
		registerSlices( {
			summary: { connected: 1, total: 2, loading: false },
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		expect( container.textContent ).toContain( '1 / 2 connected' );
	} );

	it( 'shows the empty state when servers is an empty array', () => {
		registerSlices( { servers: { servers: [], loading: false } } );
		const { container } = mount();
		expect( container.textContent ).toContain( 'No servers configured' );
	} );

	it( 'shows the error state from the servers slice', () => {
		registerSlices( {
			servers: {
				servers: null,
				error: 'aggregator down',
				loading: false,
			},
		} );
		const { container } = mount();
		expect( container.textContent ).toContain( 'aggregator down' );
	} );

	it( 'renders the shared connection banner with the servers-slice error', () => {
		registerSlices( {
			servers: {
				servers: null,
				error: 'aggregator down',
				loading: false,
			},
		} );
		const { container } = mount();
		const banner = container.querySelector(
			'.newspack-nodes-connection-banner'
		);
		expect( banner ).toBeTruthy();
		expect( banner.textContent ).toContain( 'aggregator down' );
	} );

	it( 'does not render the connection banner when there is no error', () => {
		registerSlices( { servers: { servers: [], loading: false } } );
		const { container } = mount();
		expect(
			container.querySelector( '.newspack-nodes-connection-banner' )
		).toBeNull();
	} );

	it( 'keeps a per-row partition error message (never promoted to the connection banner)', () => {
		registerSlices( {
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		const errLine = container.querySelector(
			'.aggregator-partition-error'
		);
		expect( errLine ).toBeTruthy();
		expect( errLine.textContent ).toContain( 'timeout' );
		expect( errLine.textContent ).not.toContain( 'HTTP 504' );
		expect(
			container.querySelector( '.aggregator-http-code' ).textContent
		).toContain( 'HTTP 504' );
	} );

	it( 'rails each partition by rolled-up health (connected+heartbeating → is-ok, down → is-down)', () => {
		registerSlices( {
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		expect(
			container.querySelector( '.aggregator-partition.is-ok' )
		).toBeTruthy();
		expect(
			container.querySelector( '.aggregator-partition.is-down' )
		).toBeTruthy();
	} );

	it( 'shows the heartbeat RTT badge', () => {
		registerSlices( {
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		// formatRtt(42) → "42.0" (between 1 and 100).
		expect( container.textContent ).toContain( '42.0ms' );
	} );

	it( 'formats sub-ms, warning, and error RTT partitions', () => {
		registerSlices( {
			summary: {
				serverNow: 10000,
				connected: 1,
				total: 1,
				loading: false,
			},
			servers: {
				servers: [
					{
						id: 'srv-rtt',
						url: 'https://rtt.example.test',
						partitions: {
							0: {
								connected: true,
								last_heartbeat_response: 9999,
								last_heartbeat_rtt: 0.5,
								last_connection_attempt: 9880,
								last_sse_heartbeat: 5000,
							},
							1: {
								connected: true,
								last_heartbeat_response: 9999,
								last_heartbeat_rtt: 250,
							},
							2: {
								connected: true,
								last_heartbeat_response: 9999,
								last_heartbeat_rtt: 600,
							},
						},
					},
				],
				loading: false,
			},
		} );
		const { container } = mount();
		expect( container.textContent ).toContain( '0.50ms' );
		expect( container.textContent ).toContain( '250ms' );
		expect( container.textContent ).toContain( '600ms' );
		expect( container.textContent ).toContain( '2m ago' );
		expect(
			container.querySelector( '.aggregator-heartbeat-rtt.warning' )
		).toBeTruthy();
		expect(
			container.querySelector( '.aggregator-heartbeat-rtt.error' )
		).toBeTruthy();
	} );

	it( 'computes "ago" from the summary-slice serverNow, not the browser clock', () => {
		registerSlices( {
			summary: {
				serverNow: 2000,
				connected: 1,
				total: 1,
				loading: false,
			},
			servers: {
				servers: [
					{
						id: 'srv',
						url: 'https://s.example.test',
						partitions: {
							0: {
								connected: true,
								// Recorded 1s before the snapshot serverNow below.
								last_sse_heartbeat: 1999,
							},
						},
					},
				],
				loading: false,
			},
		} );
		const { container } = mount();
		// Server HB = serverNow(2000) - last_sse_heartbeat(1999) = "1s ago".
		expect( container.textContent ).toContain( '1s ago' );
	} );

	it( 'renders the refresh select bound to the graph callback', () => {
		registerSlices( { servers: { servers: [], loading: false } } );
		const { container } = mount();
		const select = container.querySelector(
			'.newspack-nodes-refresh-select'
		);
		expect( select ).toBeTruthy();
		expect( select.value ).toBe( '2000' );
		const setter = Object.getOwnPropertyDescriptor(
			window.HTMLSelectElement.prototype,
			'value'
		).set;
		act( () => {
			setter.call( select, '5000' );
			select.dispatchEvent( new Event( 'change', { bubbles: true } ) );
		} );
		expect( setRefreshInterval ).toHaveBeenCalledWith( '5000' );
	} );

	it( 'mounts the graph (calls useAggregatorStatusGraph)', () => {
		registerSlices();
		mount();
		expect( useAggregatorStatusGraph ).toHaveBeenCalled();
	} );

	it( 'falls back to a loading model when the slice nodes are absent', () => {
		// No fixture registered — useNodeState yields undefined; the view must
		// still render the loading state without throwing.
		const { container } = mount();
		expect( container.textContent ).toContain( 'Loading server status' );
	} );

	it( 'keeps ticking the 1s ago clock (re-renders without re-polling)', () => {
		jest.useFakeTimers();
		registerSlices( {
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		act( () => {
			jest.advanceTimersByTime( 1000 );
		} );
		expect( container.textContent ).toContain( 'server1' );
		jest.useRealTimers();
	} );
} );
