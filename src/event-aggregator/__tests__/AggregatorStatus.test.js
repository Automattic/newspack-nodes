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
		// Distinct from `id`: the node NAME differs from the vault credential
		// KEY in real topologies (e.g. `firehose:tw0` vs `tucson-weekly`).
		vault_id: 'server1-vault-cred',
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
		vault_id: 'server2-vault-cred',
		url: 'https://b.example.test',
		partitions: {},
	},
];

// One server carrying BOTH post-close states, so no single code path can
// satisfy the idle and the failed expectations at once: p0 closed at EOF and
// is due back, p1 died of a transport error and is not coming back on its own.
const IDLE_CLOCK = 1748970000;
const IDLE_AND_FAILED = [
	{
		id: 'server3',
		vault_id: 'server3-vault-cred',
		url: 'https://c.example.test',
		partitions: {
			0: {
				connected: false,
				scheduled_reconnect_at: IDLE_CLOCK + 9,
				last_connection_attempt: IDLE_CLOCK - 6,
				last_error: null,
			},
			1: {
				connected: false,
				last_error: 'connection refused 8531',
				last_http_code: 502,
			},
		},
	},
];

// A stand-in slice-view node: model in setStateCache.view; setState notifies.
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
		idle: 0,
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
	let probeServer;
	let graphOpts = {};
	// What the graph reports as outstanding; the card asks rather than keeping
	// a flag of its own.
	let pendingSubjects = [];

	// A reply, already addressed: the graph hands the screen the answer and
	// the SUBJECT it named, exactly as the reply path delivered it.
	const answerProbe = ( subject, answer ) =>
		act( () =>
			graphOpts.onAnswer?.( {
				subject,
				result: null,
				error: null,
				...answer,
			} )
		);

	// Fire the nth card's Probe button.
	const clickProbe = ( container, n ) =>
		act( () =>
			container
				.querySelectorAll( '.aggregator-fleet-probe-button' )
				[ n ].dispatchEvent( new Event( 'click', { bubbles: true } ) )
		);
	const mounted = [];

	beforeEach( () => {
		Core.reset();
		window.localStorage.clear();
		setRefreshInterval = jest.fn();
		probeServer = jest.fn();
		graphOpts = {};
		pendingSubjects = [];
		useAggregatorStatusGraph.mockClear();
		useAggregatorStatusGraph.mockImplementation( ( opts = {} ) => {
			graphOpts = opts;
			return {
				setRefreshInterval,
				refreshInterval: '2000',
				probeServer,
				isPending: ( subject ) => pendingSubjects.includes( subject ),
			};
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

	it( 'marks only outer server cards as elevated canonical surfaces', () => {
		registerSlices( {
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		const serverCards = [
			...container.querySelectorAll( '.aggregator-server-card' ),
		];
		const partitionCards = [
			...container.querySelectorAll( '.aggregator-partition' ),
		];

		expect( serverCards ).toHaveLength( SAMPLE_SERVERS.length );
		expect( partitionCards ).toHaveLength( 2 );
		expect(
			[ ...serverCards, ...partitionCards ].every( ( card ) =>
				card.classList.contains( 'newspack-nodes-card' )
			)
		).toBe( true );
		expect(
			serverCards.every( ( card ) =>
				card.classList.contains( 'newspack-nodes-card--elevated' )
			)
		).toBe( true );
		expect(
			partitionCards.every(
				( card ) =>
					! card.classList.contains( 'newspack-nodes-card--elevated' )
			)
		).toBe( true );
		expect(
			partitionCards.every( ( card ) =>
				card.classList.contains( 'newspack-nodes-card--hoverable' )
			)
		).toBe( true );
		expect(
			serverCards.every(
				( card ) =>
					! card.classList.contains(
						'newspack-nodes-card--hoverable'
					)
			)
		).toBe( true );
	} );

	it( 'keeps distinct partition readings in compact semantic rows', () => {
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
						id: 'compact-contract',
						url: 'https://compact.example.test',
						partitions: {
							0: {
								connected: true,
								last_connection_attempt: 1903,
								last_sse_heartbeat: 1991,
								last_heartbeat_response: 1997,
								last_heartbeat_rtt: 37.25,
								last_http_code: 207,
							},
						},
					},
				],
				loading: false,
			},
		} );
		const { container } = mount();
		const partition = container.querySelector( '.aggregator-partition' );
		const rows = [
			...partition.querySelectorAll( '.aggregator-partition-row' ),
		];

		expect( rows ).toHaveLength( 4 );
		expect(
			rows.every(
				( row ) => ! row.classList.contains( 'newspack-nodes-stat' )
			)
		).toBe( true );
		expect(
			rows.every(
				( row ) =>
					row.querySelector(
						'.newspack-nodes-stat-label.aggregator-partition-stat-label'
					) &&
					row.querySelector(
						'.newspack-nodes-stat-value.aggregator-partition-stat-value'
					)
			)
		).toBe( true );
		expect( partition.textContent ).toContain( '2m ago' );
		expect( partition.textContent ).toContain( '9s ago' );
		expect( partition.textContent ).toContain( '3s ago' );
		expect( partition.textContent ).toContain( '37.3ms' );
		expect( partition.textContent ).toContain( 'HTTP 207' );
	} );

	it( 'renders the connected/total count from the summary slice (not the servers slice)', () => {
		registerSlices( {
			summary: { connected: 1, total: 2, loading: false },
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		expect( container.textContent ).toContain( '1 / 2 up' );
	} );

	it( 'renders a stream closed at EOF as idle, with the schedule it will return on', () => {
		registerSlices( {
			summary: { serverNow: IDLE_CLOCK, loading: false },
			servers: { servers: IDLE_AND_FAILED, loading: false },
		} );
		const { container } = mount();
		const idle = container.querySelector( '.aggregator-partition.is-idle' );

		expect( idle ).toBeTruthy();
		expect( idle.textContent ).toContain( 'idle' );
		expect( idle.textContent ).not.toContain( 'disconnected' );
		expect( idle.textContent ).toContain( 'Reconnects' );
		expect( idle.textContent ).toContain( 'in 9s' );
		expect(
			idle.querySelector( '.aggregator-partition-error' )
		).toBeNull();
	} );

	it( 'still rails a failed stream as an error beside an idle one', () => {
		registerSlices( {
			summary: { serverNow: IDLE_CLOCK, loading: false },
			servers: { servers: IDLE_AND_FAILED, loading: false },
		} );
		const { container } = mount();
		const failed = container.querySelector(
			'.aggregator-partition.is-down'
		);

		expect( failed ).toBeTruthy();
		expect( failed.textContent ).toContain( 'disconnected' );
		expect(
			failed.querySelector( '.aggregator-partition-error' ).textContent
		).toContain( 'connection refused 8531' );
	} );

	it( 'counts an idle partition as present in the server card total', () => {
		registerSlices( {
			summary: { serverNow: IDLE_CLOCK, loading: false },
			servers: { servers: IDLE_AND_FAILED, loading: false },
		} );
		const { container } = mount();
		expect(
			container.querySelector( '.aggregator-server-partition-count' )
				.textContent
		).toContain( '1/2 partitions' );
	} );

	it( 'counts idle spokes as up in the header, naming how many are idle', () => {
		registerSlices( {
			summary: { connected: 1, idle: 2, total: 3, loading: false },
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		const count = container.querySelector(
			'.aggregator-status-server-count'
		);
		expect( count.textContent ).toContain( '3 / 3 up' );
		expect( count.textContent ).toContain( '2 idle' );
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
								// Recorded 1s before serverNow below.
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

	it( 'renders an hour-old timestamp as a full local date + timezone', () => {
		const ts = 1_777_000_123; // Fixed instant, far older than an hour.
		registerSlices( {
			summary: {
				serverNow: ts + 90_000,
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
								last_sse_heartbeat: ts,
							},
						},
					},
				],
				loading: false,
			},
		} );
		const { container } = mount();
		const d = new Date( ts * 1000 );
		const expected = `${ d.toLocaleDateString(
			'en-CA'
		) } ${ d.toLocaleTimeString( 'en-US', {
			hour12: false,
			timeZoneName: 'short',
		} ) }`;
		expect( container.textContent ).toContain( expected );
	} );

	it( 'renders the refresh select bound to the graph callback', () => {
		registerSlices( { servers: { servers: [], loading: false } } );
		const { container } = mount();
		const select = container.querySelector( '.newspack-nodes-select' );
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
		// No fixture → useNodeState undefined; must still render loading.
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

	// The card asks the graph what it is waiting on; the outbox is the only
	// thing that knows, and a flag flipped at the click goes stale the moment
	// one path forgets to clear it.
	it( 'shows only the outstanding card as probing', () => {
		pendingSubjects = [ 'server1-vault-cred' ];
		registerSlices( {
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		const buttons = container.querySelectorAll(
			'.aggregator-fleet-probe-button'
		);
		expect( buttons[ 0 ].disabled ).toBe( true );
		expect( buttons[ 0 ].textContent ).toContain( 'Probing…' );
		expect( buttons[ 1 ].disabled ).toBe( false );
	} );

	it( 'renders one Probe button per server card', () => {
		registerSlices( {
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		expect(
			container.querySelectorAll( '.aggregator-fleet-probe-button' )
				.length
		).toBe( SAMPLE_SERVERS.length );
	} );

	it( 'clicking Probe fires the hook probe(id)', () => {
		registerSlices( {
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		clickProbe( container, 0 );
		// The probe verb takes the VAULT credential key, not the node name —
		// they differ in real topologies, so this must not regress to `id`.
		expect( probeServer ).toHaveBeenCalledWith( 'server1-vault-cred' );
		expect( probeServer ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'renders the fleet roll-up when a probe result is present', () => {
		registerSlices( {
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		// Keyed by vault_id (what the card probes), NOT `id` — an answer
		// naming server.id would reach no card at all.
		clickProbe( container, 0 );
		answerProbe( 'server1-vault-cred', {
			result: {
				workers: { total: 4, live: 3, stale: 1, dead: 0 },
				worst_distance: 128,
				deadletter_segments: 5,
			},
		} );
		expect( container.textContent ).toContain(
			'3 live / 1 stale / 0 dead'
		);
		expect( container.textContent ).toContain( '128' );
		expect( container.textContent ).toContain( 'DLQ 5' );
	} );

	// @longform Two spokes probed in the same second are two subjects, and each
	// card shows its OWN roll-up. A screen reading one shared result cannot:
	// the second answer replaces the first, and a card that is up starts
	// displaying its neighbour's numbers.
	it( 'keeps each card’s roll-up when a second spoke is probed', () => {
		registerSlices( {
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		const cards = () =>
			container.querySelectorAll( '.aggregator-server-card' );

		clickProbe( container, 0 );
		answerProbe( 'server1-vault-cred', {
			result: { worst_distance: 4471 },
		} );
		clickProbe( container, 1 );
		answerProbe( 'server2-vault-cred', { error: 'could not connect' } );

		expect( cards()[ 0 ].textContent ).toContain( '4471' );
		expect( cards()[ 1 ].textContent ).toContain( 'could not connect' );
	} );

	it( 'renders the probe error line on a failed probe', () => {
		registerSlices( {
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		clickProbe( container, 0 );
		answerProbe( 'server1-vault-cred', {
			error: 'could not connect to server',
		} );
		const err = container.querySelector(
			'.aggregator-fleet-rollup.is-error'
		);
		expect( err ).toBeTruthy();
		expect( err.textContent ).toContain( 'could not connect to server' );
	} );
} );
