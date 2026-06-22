/**
 * AggregatorStatus UI-surface tests — the thin view over the aggregator node
 * graph.
 *
 * The graph is owned by useAggregatorStatusGraph (tested separately); here we mock
 * it to hand back spy control callbacks, and we register a fixture
 * `aggregator:view` node in Core so the view can read its model via useNodeState.
 * Mirrors how RequestStream.test.js was rewritten against its graph.
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

// A minimal stand-in for the aggregator:view node: the model lives in
// setStateCache.view (what useNodeState subscribes to). setState here notifies
// subscribers exactly like the real Node.setState.
function registerViewFixture( overrides = {} ) {
	const model = {
		servers: null,
		serverNow: null,
		connectedCount: 0,
		totalCount: 0,
		error: null,
		loading: true,
		lastRefresh: null,
		...overrides,
	};
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
	Core.nodes.set( 'aggregator:view', node );
	return node;
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

	it( 'renders the Aggregator Status heading', () => {
		registerViewFixture();
		const { container } = mount();
		expect( container.textContent ).toContain( 'Aggregator Status' );
	} );

	it( 'shows the loading state before the first poll publishes', () => {
		registerViewFixture( { loading: true } );
		const { container } = mount();
		expect( container.textContent ).toContain( 'Loading server status' );
	} );

	it( 'renders server cards from the view model', () => {
		registerViewFixture( {
			servers: SAMPLE_SERVERS,
			connectedCount: 1,
			totalCount: 2,
			loading: false,
		} );
		const { container } = mount();
		expect( container.textContent ).toContain( 'server1' );
		expect( container.textContent ).toContain( 'server2' );
		expect( container.textContent ).toContain( 'p0' );
		expect( container.textContent ).toContain( 'p1' );
		expect( container.textContent ).toContain( '1 / 2 connected' );
	} );

	it( 'shows the empty state when servers is an empty array', () => {
		registerViewFixture( { servers: [], loading: false } );
		const { container } = mount();
		expect( container.textContent ).toContain( 'No servers configured' );
	} );

	it( 'shows the error state from the view model', () => {
		registerViewFixture( {
			servers: null,
			error: 'aggregator down',
			loading: false,
		} );
		const { container } = mount();
		expect( container.textContent ).toContain( 'aggregator down' );
	} );

	it( 'renders the shared connection banner with the error message', () => {
		registerViewFixture( {
			servers: null,
			error: 'aggregator down',
			loading: false,
		} );
		const { container } = mount();
		const banner = container.querySelector(
			'.newspack-nodes-connection-banner'
		);
		expect( banner ).toBeTruthy();
		expect( banner.textContent ).toContain( 'aggregator down' );
	} );

	it( 'does not render the connection banner when there is no error', () => {
		registerViewFixture( { servers: [], loading: false } );
		const { container } = mount();
		expect(
			container.querySelector( '.newspack-nodes-connection-banner' )
		).toBeNull();
	} );

	it( 'keeps a per-row partition error message (never promoted to the connection banner)', () => {
		registerViewFixture( {
			servers: SAMPLE_SERVERS,
			connectedCount: 1,
			totalCount: 2,
			loading: false,
		} );
		const { container } = mount();
		// A per-partition error stays a per-row notice carrying only the MESSAGE;
		// the HTTP code now rides the Status row as a caption, not the error line.
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
		registerViewFixture( {
			servers: SAMPLE_SERVERS,
			connectedCount: 1,
			totalCount: 2,
			loading: false,
		} );
		const { container } = mount();
		// server1 p0 is connected + heartbeating → ok rail; p1 is down → down rail.
		expect(
			container.querySelector( '.aggregator-partition.is-ok' )
		).toBeTruthy();
		expect(
			container.querySelector( '.aggregator-partition.is-down' )
		).toBeTruthy();
	} );

	it( 'shows the connection error info for a disconnected partition', () => {
		registerViewFixture( {
			servers: SAMPLE_SERVERS,
			connectedCount: 1,
			totalCount: 2,
			loading: false,
		} );
		const { container } = mount();
		expect( container.textContent ).toContain( 'HTTP 504' );
		expect( container.textContent ).toContain( 'timeout' );
	} );

	it( 'shows the heartbeat status as pending (not success) when disconnected, even with a stale last_heartbeat_response', () => {
		registerViewFixture( {
			servers: [
				{
					id: 'gone',
					url: 'https://gone.example.test',
					partitions: {
						// Was connected once (stale heartbeat ts present) but the
						// SSE link is now down — the Status badge must reflect that.
						0: {
							connected: false,
							last_heartbeat_response: 1748960010,
						},
					},
				},
			],
			connectedCount: 0,
			totalCount: 1,
			loading: false,
		} );
		const { container } = mount();
		expect(
			container.querySelector( '.aggregator-heartbeat-badge.pending' )
		).toBeTruthy();
		expect(
			container.querySelector( '.aggregator-heartbeat-badge.success' )
		).toBeNull();
	} );

	it( 'shows the RTT badge for the heartbeat', () => {
		registerViewFixture( {
			servers: SAMPLE_SERVERS,
			connectedCount: 1,
			totalCount: 2,
			loading: false,
		} );
		const { container } = mount();
		// formatRtt(42) → "42.0" (between 1 and 100).
		expect( container.textContent ).toContain( '42.0ms' );
	} );

	it( 'formats sub-ms, warning, and error RTT partitions', () => {
		registerViewFixture( {
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
			serverNow: 10000,
			connectedCount: 1,
			totalCount: 1,
			loading: false,
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

	it( 'computes "ago" from the model serverNow, not the browser clock', () => {
		registerViewFixture( {
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
			serverNow: 2000,
			connectedCount: 1,
			totalCount: 1,
			loading: false,
		} );
		const { container } = mount();
		// Server HB = serverNow(2000) - last_sse_heartbeat(1999) = "1s ago".
		expect( container.textContent ).toContain( '1s ago' );
	} );

	it( 'renders the refresh select bound to the graph callback', () => {
		registerViewFixture( { servers: [], loading: false } );
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
		registerViewFixture();
		mount();
		expect( useAggregatorStatusGraph ).toHaveBeenCalled();
	} );

	it( 'falls back to a loading model when the view node is absent', () => {
		// No fixture registered — useNodeState yields undefined; the view must
		// still render the loading state without throwing.
		const { container } = mount();
		expect( container.textContent ).toContain( 'Loading server status' );
	} );

	it( 'keeps ticking the 1s ago clock (re-renders without re-polling)', () => {
		jest.useFakeTimers();
		registerViewFixture( {
			servers: SAMPLE_SERVERS,
			connectedCount: 1,
			totalCount: 2,
			loading: false,
		} );
		const { container } = mount();
		// The 1s tick must not throw and the dashboard stays rendered.
		act( () => {
			jest.advanceTimersByTime( 1000 );
		} );
		expect( container.textContent ).toContain( 'server1' );
		jest.useRealTimers();
	} );
} );
