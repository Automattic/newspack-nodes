/**
 * AggregatorStatus UI-surface tests — the thin view over the aggregator node
 * graph. The dashboard reads two independent per-concern slices, each from its
 * own view node:
 *
 *   summary:view → the header strip: counts + snapshot clock
 *   servers:view → one card per spoke, a timings line per partition
 *
 * The graph is owned by useAggregatorStatusGraph (tested separately); here we mock
 * it to hand back spy control callbacks, and we register fixture slice nodes in
 * Core so each widget can read its model via useNodeField.
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
import { Core, mountExospine } from '@newspack-nodes/runtime';
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
				last_response: 1748960010,
				last_rtt: 42,
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

// A spoke whose socket is open but whose `connected` handshake has not landed.
// It is neither up nor down, and the raw transport string is the one the card
// must translate rather than repeat.
const CURL_TIMEOUT_ERROR =
	'cURL error 28 (Timeout was reached): Connection timed out after 5000 milliseconds';
const OPENING = [
	{
		id: 'server4',
		vault_id: 'server4-vault-cred',
		url: 'https://d.example.test',
		partitions: {
			0: {
				connected: false,
				connecting: true,
				last_connection_attempt: 1748980000,
			},
			1: {
				connected: false,
				connecting: false,
				last_error: CURL_TIMEOUT_ERROR,
			},
		},
	},
];

// A spoke that never opened. "not connected" is the only thing its heartbeat
// can say, so the transport's reason is the card's whole Status reading.
const DEAD_STREAM_ERROR =
	"cURL error 7 (Couldn't connect to server): Failed to connect to h.example.test port 8443";
const DEAD = [
	{
		id: 'server6',
		vault_id: 'server6-vault-cred',
		url: 'https://h.example.test',
		partitions: {
			5: {
				connected: false,
				last_connection_attempt: 1749002000,
				last_error: DEAD_STREAM_ERROR,
				last_http_code: 409,
			},
		},
	},
];

// A spoke still connected and answering round trips when a frame broke
// mid-stream: SSE_In sets last_error without dropping `connected`, the one
// state where the badge the error displaces would read success.
const MIDSTREAM_ERROR = 'Buffer overflow (no newline in 65536 bytes)';
const CONNECTED_AND_BROKEN = [
	{
		id: 'server7',
		vault_id: 'server7-vault-cred',
		url: 'https://i.example.test',
		partitions: {
			9: {
				connected: true,
				last_response: 1749001234,
				last_rtt: 13,
				last_connection_attempt: 1749001200,
				last_error: MIDSTREAM_ERROR,
			},
		},
	},
];

// A stand-in slice-view node: model in its `view` field; setField announces it.
function fixtureNode( name, model ) {
	const node = {
		registrations: { view: {} },
		register( event, listener, cb ) {
			this.registrations[ event ][ listener ] = cb;
		},
		unregister( event, listener ) {
			delete this.registrations[ event ]?.[ listener ];
		},
		setField( field, value ) {
			this[ field ] = value;
			Object.values( this.registrations[ field ] || {} ).forEach(
				( cb ) => cb()
			);
		},
	};
	node.setField( 'view', model );
	Core.nodes.set( name, node );
	return node;
}

// Register the two per-concern slice fixtures the dashboard reads.
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
	// One reading in a scope, found by its label rather than its position.
	const stat = ( scope, label ) =>
		[ ...scope.querySelectorAll( '.aggregator-stat' ) ].find(
			( reading ) =>
				label ===
				reading.querySelector( '.newspack-nodes-stat-label' )
					.textContent
		);
	// A multi-partition card's timings line, found by its `p<N>` label.
	const partitionLine = ( scope, label ) =>
		[ ...scope.querySelectorAll( '.aggregator-partition-line' ) ].find(
			( candidate ) =>
				label ===
				candidate.querySelector( '.aggregator-partition-label' )
					?.textContent
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

	it( 'lists no readers for a broker the probe log names none of', () => {
		registerSlices( {
			summary: { serverNow: 2000, loading: false },
			servers: {
				servers: [
					{
						id: 'firehose:tapir-8',
						url: 'https://tapir.example.test',
						partitions: { 0: { connected: true } },
						readers: [],
					},
				],
				loading: false,
			},
		} );
		const { container } = mount();

		expect( container.querySelector( '.aggregator-cursors' ) ).toBeNull();
	} );

	it( 'names each unreadable topology from the summary slice in an error banner', () => {
		registerSlices( {
			summary: {
				loading: false,
				unreadable: { 'marmot-9912': 'include orphaned-9913 failed' },
			},
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		const banners = [
			...container.querySelectorAll( '.newspack-nodes-error-banner' ),
		].map( ( n ) => n.textContent );
		expect( banners ).toEqual( [
			'Topology marmot-9912 will not read, so its servers are not listed: include orphaned-9913 failed',
		] );
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
		const idle = partitionLine( container, 'p0' );

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
		const failed = partitionLine( container, 'p1' );

		expect(
			container
				.querySelector( '.aggregator-server-card' )
				.classList.contains( 'is-down' )
		).toBe( true );
		expect( failed.textContent ).toContain( 'disconnected' );
		expect(
			failed.querySelector( '.aggregator-partition-error' ).textContent
		).toContain( 'connection refused 8531' );
	} );

	it( 'renders a socket that is still opening as connecting, never as connected', () => {
		registerSlices( {
			summary: { serverNow: 1748980002, loading: false },
			servers: { servers: OPENING, loading: false },
		} );
		const { container } = mount();
		const opening = partitionLine( container, 'p0' );

		expect(
			opening.querySelector( '.aggregator-status-badge' ).textContent
		).toBe( 'connecting' );
		expect( opening.textContent ).not.toContain( 'disconnected' );
		expect(
			container.querySelector( '.aggregator-server-card.is-ok' )
		).toBeNull();
	} );

	it( 'says what broke in short, keeping the transport string on hover', () => {
		registerSlices( {
			summary: { serverNow: 1748980002, loading: false },
			servers: { servers: OPENING, loading: false },
		} );
		const { container } = mount();
		const errLine = container.querySelector(
			'.aggregator-partition-error'
		);

		expect( errLine.textContent ).toBe( 'timed out' );
		expect( errLine.getAttribute( 'title' ) ).toBe( CURL_TIMEOUT_ERROR );
	} );

	it( 'reads a connection error on the Status reading, not a line beneath the card', () => {
		registerSlices( {
			summary: { serverNow: 1749002006, loading: false },
			servers: { servers: DEAD, loading: false },
		} );
		const { container } = mount();
		const card = container.querySelector( '.aggregator-server-card' );
		const errBadge = stat( card, 'Status' ).querySelector(
			'.aggregator-partition-error'
		);

		expect( errBadge.textContent ).toBe( "couldn't connect to server" );
		expect(
			card.querySelectorAll( '.aggregator-partition-error' )
		).toHaveLength( 1 );
	} );

	it( 'keeps the whole transport string on the Status-row error', () => {
		registerSlices( {
			summary: { serverNow: 1749002006, loading: false },
			servers: { servers: DEAD, loading: false },
		} );
		const { container } = mount();
		const errBadge = container.querySelector(
			'.aggregator-partition-error'
		);

		expect( errBadge.getAttribute( 'title' ) ).toBe( DEAD_STREAM_ERROR );
	} );

	it( 'paints the Status-row error as a canonical error badge, leaving the caps to CSS', () => {
		registerSlices( {
			summary: { serverNow: 1749002006, loading: false },
			servers: { servers: DEAD, loading: false },
		} );
		const { container } = mount();
		const errBadge = container.querySelector(
			'.aggregator-partition-error'
		);

		expect( [ ...errBadge.classList ] ).toEqual(
			expect.arrayContaining( [
				'newspack-nodes-status-badge',
				'small',
				'is-error',
			] )
		);
	} );

	it( 'drops a pending heartbeat badge the error already accounts for', () => {
		registerSlices( {
			summary: { serverNow: 1749002006, loading: false },
			servers: { servers: DEAD, loading: false },
		} );
		const { container } = mount();
		const status = stat(
			container.querySelector( '.aggregator-server-card' ),
			'Status'
		);

		expect(
			status.querySelector( '.aggregator-response-badge' )
		).toBeNull();
		expect( status.textContent ).not.toContain( 'pending' );
		expect(
			stat( container.querySelector( '.aggregator-server-card' ), 'HTTP' )
				.textContent
		).toBe( 'HTTP409' );
	} );

	it( 'replaces even a succeeding heartbeat badge, the error being the reading that matters', () => {
		registerSlices( {
			summary: { serverNow: 1749001240, loading: false },
			servers: { servers: CONNECTED_AND_BROKEN, loading: false },
		} );
		const { container } = mount();
		const card = container.querySelector( '.aggregator-server-card' );
		const status = stat( card, 'Status' );

		expect(
			status.querySelector( '.aggregator-response-badge' )
		).toBeNull();
		expect(
			status.querySelector( '.aggregator-partition-error' ).textContent
		).toBe( 'Buffer overflow' );
		// The response it displaced still reads off Round trip and the rail.
		expect( card.classList.contains( 'is-ok' ) ).toBe( true );
		expect( card.textContent ).toContain( '13.0ms' );
	} );

	it( 'labels the last_response reading Round trip and keeps Server HB for the SSE heartbeat', () => {
		registerSlices( {
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		const labels = Array.from(
			container.querySelectorAll(
				'.aggregator-partition-line .newspack-nodes-stat-label'
			)
		).map( ( node ) => node.textContent );

		expect( labels ).toContain( 'Round trip' );
		expect( labels ).toContain( 'Server HB' );
		expect( labels ).not.toContain( 'Client HB' );
	} );

	it( 'leaves a healthy partition Status reading success alone', () => {
		registerSlices( {
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		const row = stat( partitionLine( container, 'p0' ), 'Status' );

		expect(
			row.querySelector( '.aggregator-response-badge' ).textContent
		).toBe( 'success' );
		expect( row.querySelector( '.aggregator-partition-error' ) ).toBeNull();
	} );

	it( 'counts an idle partition as up in the card badge', () => {
		registerSlices( {
			summary: { serverNow: IDLE_CLOCK, loading: false },
			servers: { servers: IDLE_AND_FAILED, loading: false },
		} );
		const { container } = mount();
		expect(
			container.querySelector(
				'.aggregator-server-header .aggregator-status-badge'
			).textContent
		).toBe( '1/2 up' );
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
		expect( errLine.textContent ).toContain( 'timed out' );
		expect( errLine.textContent ).not.toContain( 'HTTP 504' );
		expect(
			stat( partitionLine( container, 'p1' ), 'HTTP' ).textContent
		).toBe( 'HTTP504' );
	} );

	it( "rails each card by its worst partition's health", () => {
		registerSlices( {
			servers: {
				servers: [
					...SAMPLE_SERVERS,
					...CONNECTED_AND_BROKEN,
					{
						id: 'server8',
						url: 'https://j.example.test',
						partitions: { 3: { connected: true } },
					},
				],
				loading: false,
			},
		} );
		const { container } = mount();
		const rails = [
			...container.querySelectorAll( '.aggregator-server-card' ),
		].map( ( card ) =>
			[ ...card.classList ].filter( ( name ) => name.startsWith( 'is-' ) )
		);

		// server2 reports no partition, which is not a spoke that streams.
		expect( rails ).toEqual( [
			[ 'is-down' ],
			[ 'is-down' ],
			[ 'is-ok' ],
			[ 'is-degraded' ],
		] );
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
								last_response: 9999,
								last_rtt: 0.5,
								last_connection_attempt: 9880,
								last_sse_heartbeat: 5000,
							},
							1: {
								connected: true,
								last_response: 9999,
								last_rtt: 250,
							},
							2: {
								connected: true,
								last_response: 9999,
								last_rtt: 600,
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
			container.querySelector( '.aggregator-rtt.warning' )
		).toBeTruthy();
		expect(
			container.querySelector( '.aggregator-rtt.error' )
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
		// No fixture → useNodeField undefined; must still render loading.
		const { container } = mount();
		expect( container.textContent ).toContain( 'Loading server status' );
	} );

	it( 'keeps ticking the 1s ago clock (re-renders without re-polling)', () => {
		jest.useFakeTimers();
		registerSlices( {
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		// The clock rides a backbone somebody else owns, as a named Timer.
		let host;
		act( () => {
			host = mountExospine( () => {} );
		} );
		const { container } = mount();
		act( () => {
			jest.advanceTimersByTime( 1000 );
		} );
		expect( container.textContent ).toContain( 'server1' );
		expect( Core.node( 'aggregator-clock:timer' ) ).toBeTruthy();
		expect( Core.node( 'aggregator:clock' ) ).toBeNull();
		host.teardown();
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
				workers: {
					total: 9,
					live: 3,
					stale: 1,
					held: 0,
					idle: 4,
					down: 1,
				},
				worst_distance: 128,
				deadletter_segments: 5,
			},
		} );
		expect( container.textContent ).toContain(
			'3 live / 1 stale / 0 held / 4 idle / 1 down'
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

	it( 'renders one flat card per spoke, nesting no partition card', () => {
		registerSlices( {
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		const cards = [
			...container.querySelectorAll( '.newspack-nodes-card' ),
		];

		expect( cards ).toHaveLength( SAMPLE_SERVERS.length );
		expect(
			cards.every( ( card ) =>
				card.classList.contains( 'aggregator-server-card' )
			)
		).toBe( true );
		expect( container.querySelector( '.aggregator-partition' ) ).toBeNull();
		expect(
			container.querySelector( '.aggregator-status-servers' ).children
		).toHaveLength( SAMPLE_SERVERS.length );
	} );

	it( 'gives a one-partition spoke its host, one timings line and its cursors', () => {
		registerSlices( {
			summary: { serverNow: 2000, loading: false },
			servers: {
				servers: [
					{
						id: 'concord-41',
						vault_id: 'concord-41-vault',
						url: 'https://concord.example.test/wp/',
						partitions: {
							0: {
								connected: true,
								last_connection_attempt: 1903,
								last_sse_heartbeat: 1991,
								last_response: 1997,
								last_rtt: 37.25,
								last_http_code: 207,
							},
						},
						readers: [
							{
								stamp: 'firehose',
								partition: 0,
								cursor: '14:9021',
								distance: 1536,
							},
							{
								stamp: 'sources:php',
								partition: 0,
								cursor: ':40913',
								distance: 70254592,
							},
						],
					},
				],
				loading: false,
			},
		} );
		const { container } = mount();
		const card = container.querySelector( '.aggregator-server-card' );
		const lines = card.querySelectorAll( '.aggregator-partition-line' );
		const url = card.querySelector( '.aggregator-server-url' );

		expect(
			card.querySelector( '.aggregator-server-id' ).textContent
		).toBe( 'concord-41' );
		expect(
			card.querySelector(
				'.aggregator-server-header .aggregator-status-badge'
			).textContent
		).toBe( 'connected' );
		expect( url.textContent ).toBe( 'concord.example.test' );
		expect( url.getAttribute( 'title' ) ).toBe(
			'https://concord.example.test/wp/'
		);
		expect( lines ).toHaveLength( 1 );
		expect(
			card.querySelector( '.aggregator-partition-label' )
		).toBeNull();
		for ( const reading of [
			'2m ago',
			'9s ago',
			'37.3ms',
			'3s ago',
			'success',
			'207',
		] ) {
			expect( lines[ 0 ].textContent ).toContain( reading );
		}
		expect(
			[ ...card.querySelectorAll( '.aggregator-cursor' ) ].map(
				( cursor ) => [
					cursor.textContent,
					cursor.getAttribute( 'title' ),
				]
			)
		).toEqual( [
			[ 'firehose 1.5 KB', 'firehose 14:9021' ],
			[ 'php 67 MB', 'sources:php :40913' ],
		] );
	} );

	it( 'lays every partition out as the same five cells, a dash for each absent value', () => {
		registerSlices( {
			summary: { serverNow: IDLE_CLOCK, loading: false },
			servers: {
				servers: [
					{
						id: 'yak-1',
						url: 'https://yak.example.test',
						partitions: {
							0: {
								connected: true,
								last_connection_attempt: IDLE_CLOCK - 130,
								last_sse_heartbeat: IDLE_CLOCK - 9,
								last_response: IDLE_CLOCK - 3,
								last_rtt: 37.25,
								last_http_code: 207,
							},
						},
					},
					{
						id: 'yak-2',
						url: 'https://yak2.example.test',
						partitions: {
							0: {
								connected: false,
								scheduled_reconnect_at: IDLE_CLOCK + 11,
							},
						},
					},
					{
						id: 'yak-3',
						url: 'https://yak3.example.test',
						partitions: {
							0: {
								connected: false,
								connecting: true,
								last_connection_attempt: IDLE_CLOCK - 4,
							},
						},
					},
				],
				loading: false,
			},
		} );
		const { container } = mount();
		const cells = [
			...container.querySelectorAll( '.aggregator-server-card' ),
		].map( ( card ) =>
			[
				...card.querySelectorAll(
					'.aggregator-partition-line .aggregator-stat'
				),
			].map( ( cell ) => [
				cell.querySelector( '.newspack-nodes-stat-label' ).textContent,
				cell.querySelector( '.newspack-nodes-stat-value' ).textContent,
			] )
		);

		expect( cells ).toEqual( [
			[
				[ 'Connected', '2m ago' ],
				[ 'Server HB', '9s ago' ],
				[ 'Round trip', '37.3ms 3s ago' ],
				[ 'Status', 'success' ],
				[ 'HTTP', '207' ],
			],
			[
				[ 'Reconnects', 'in 11s' ],
				[ 'Server HB', '—' ],
				[ 'Round trip', '—' ],
				[ 'Status', 'pending' ],
				[ 'HTTP', '—' ],
			],
			[
				[ 'Attempt', '4s ago' ],
				[ 'Server HB', '—' ],
				[ 'Round trip', '—' ],
				[ 'Status', 'pending' ],
				[ 'HTTP', '—' ],
			],
		] );
	} );

	it( 'spans a grid row per partition, so the uniform rows stay one card tall', () => {
		registerSlices( {
			servers: {
				servers: [
					...SAMPLE_SERVERS,
					{
						id: 'ibex-3',
						url: 'https://ibex.example.test',
						partitions: { 0: {}, 1: {}, 2: {} },
					},
					...CONNECTED_AND_BROKEN,
				],
				loading: false,
			},
		} );
		const { container } = mount();

		expect(
			[ ...container.querySelectorAll( '.aggregator-server-card' ) ].map(
				( card ) => card.style.gridRow
			)
		).toEqual( [ 'span 2', '', 'span 3', '' ] );
	} );

	it( 'lists one labelled line per partition and sums them in the header badge', () => {
		registerSlices( {
			summary: { serverNow: IDLE_CLOCK, loading: false },
			servers: {
				servers: [
					{
						id: 'tapir-8',
						vault_id: 'tapir-8-vault',
						url: 'https://tapir.example.test',
						partitions: {
							0: {
								connected: true,
								last_response: IDLE_CLOCK - 2,
							},
							1: {
								connected: true,
								last_response: IDLE_CLOCK - 4,
							},
							2: {
								connected: false,
								scheduled_reconnect_at: IDLE_CLOCK + 13,
							},
							3: {
								connected: false,
								last_error: 'connection refused 8531',
							},
						},
						readers: [
							{
								stamp: 'firehose',
								partition: 3,
								cursor: '2:77',
								distance: null,
							},
						],
					},
				],
				loading: false,
			},
		} );
		const { container } = mount();
		const card = container.querySelector( '.aggregator-server-card' );
		const lines = [
			...card.querySelectorAll( '.aggregator-partition-line' ),
		];

		expect(
			lines.map(
				( line ) =>
					line.querySelector( '.aggregator-partition-label' )
						.textContent
			)
		).toEqual( [ 'p0', 'p1', 'p2', 'p3' ] );
		expect(
			lines.map(
				( line ) =>
					line.querySelector( '.aggregator-status-badge' ).textContent
			)
		).toEqual( [ 'connected', 'connected', 'idle', 'disconnected' ] );
		expect( lines[ 2 ].textContent ).toContain( 'in 13s' );
		expect(
			card.querySelector(
				'.aggregator-server-header .aggregator-status-badge'
			).textContent
		).toBe( '3/4 up' );
		expect( card.classList.contains( 'is-down' ) ).toBe( true );
		expect( card.querySelector( '.aggregator-cursor' ).textContent ).toBe(
			'p3 firehose lag unknown'
		);
	} );

	it( 'shows a spoke URL that names no host as stored', () => {
		registerSlices( {
			servers: {
				servers: [
					{
						id: 'gecko-5',
						url: 'gecko-5.example.test:8443',
						partitions: { 0: { connected: true } },
					},
					{
						id: 'gecko-6',
						url: 'https://[gecko-6',
						partitions: { 0: { connected: true } },
					},
				],
				loading: false,
			},
		} );
		const { container } = mount();

		expect(
			[ ...container.querySelectorAll( '.aggregator-server-url' ) ].map(
				( url ) => url.textContent
			)
		).toEqual( [ 'gecko-5.example.test:8443', 'https://[gecko-6' ] );
	} );

	it( 'probes from the button inside its own card', () => {
		registerSlices( {
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		const second = container.querySelectorAll(
			'.aggregator-server-card'
		)[ 1 ];
		const button = second.querySelector( '.aggregator-fleet-probe-button' );

		// The button closes the card, below the readings it probes behind.
		expect(
			second
				.querySelector( '.aggregator-server-header' )
				.compareDocumentPosition( button ) &
				window.Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		act( () =>
			button.dispatchEvent( new Event( 'click', { bubbles: true } ) )
		);
		answerProbe( 'server2-vault-cred', { error: 'spoke 2 refused' } );

		expect( probeServer ).toHaveBeenCalledWith( 'server2-vault-cred' );
		expect(
			second.querySelector( '.aggregator-fleet-rollup.is-error' )
				.textContent
		).toBe( 'spoke 2 refused' );
	} );

	it( 'renders an unknown worst lag as unknown, not as zero bytes', () => {
		registerSlices( {
			servers: { servers: SAMPLE_SERVERS, loading: false },
		} );
		const { container } = mount();
		clickProbe( container, 0 );
		answerProbe( 'server1-vault-cred', {
			result: { worst_distance: null, deadletter_segments: 7 },
		} );
		const rollup = container.querySelector( '.aggregator-fleet-rollup' );
		expect( rollup.textContent ).toContain( 'Worst lag unknown' );
		expect( rollup.textContent ).not.toContain( 'Worst lag 0' );
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
