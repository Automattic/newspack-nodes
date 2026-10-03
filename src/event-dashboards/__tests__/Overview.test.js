/* global Element */
/**
 * Overview — the merged station board. Every active topology renders as a TopologyRow
 * (folded compact ↔ unfolded detail), in the user's persisted drag order (NOT
 * health), with a de-emphasized stopped group. TopologyRow is stubbed here (its
 * own suite owns the heading/tree DOM); this suite asserts the tab wired the right
 * props (folded flag, handlers, order) and persisted order + fold state.
 */

import { render, fireEvent, act } from '@testing-library/react';
import Overview from '../Overview';
import { useProbeStream } from '../hooks/useProbeStream';
import { Core } from '../../runtime/core';
import { publishSkippedLines } from '@newspack-nodes/shared/test-utils/skippedLines';

jest.mock( '../hooks/useTopologyManager', () => ( {
	useTopologyManager: jest.fn(),
} ) );
// Persistence is its own suite; mocked to assert read-on-init + write-through.
jest.mock( '../overviewPrefs', () => ( {
	readOrder: jest.fn( () => [] ),
	writeOrder: jest.fn(),
	readExpanded: jest.fn( () => new Set() ),
	writeExpanded: jest.fn(),
	readCollapsed: jest.fn( () => new Set() ),
	writeCollapsed: jest.fn(),
} ) );
// Probe stream is its own suite; link no-op, view model fed via useNodeField.
jest.mock( '../hooks/useProbeStream', () => ( {
	useProbeStream: jest.fn(),
} ) );
jest.mock( '../../runtime/react', () => ( {
	...jest.requireActual( '../../runtime/react' ),
	useNodeField: jest.fn(),
} ) );
// TopicsChart (d3, own suite) stubbed to capture the props each panel is fed.
jest.mock( '../TopicsChart', () => {
	const el = require( '@wordpress/element' );
	const TopicsChart = ( props ) => {
		( globalThis.__topicsPanels ||= [] ).push( props );
		return el.createElement(
			'div',
			{ className: 'nodes-topics' },
			el.createElement(
				'div',
				{ className: 'newspack-nodes-chart__title' },
				props.title
			)
		);
	};
	return {
		TopicsChart,
		TopicsPanels: ( { panels, totalLabel } ) =>
			panels.map( ( p ) =>
				el.createElement( TopicsChart, {
					key: p.title,
					...p,
					totalLabel: p.stacked ? totalLabel : undefined,
				} )
			),
	};
} );
// SummaryCards has its own suite; stubbed to capture the props the tab feeds.
jest.mock( '../SummaryCards', () => {
	const el = require( '@wordpress/element' );
	return ( props ) => {
		( globalThis.__summaryCards ||= [] ).push( props );
		return el.createElement( 'div', { className: 'nodes-cards-stub' } );
	};
} );
// TopologyControls has its own suite; stubbed to capture its wired props.
jest.mock( '../TopologyControls', () => {
	const el = require( '@wordpress/element' );
	return ( props ) => {
		( globalThis.__topologyControls ||= [] ).push( props );
		return el.createElement( 'span', { className: 'nodes-ctl-stub' } );
	};
} );
// Prop-capturing stub (its own suite owns the tree); keep real consoleHref.
jest.mock( '../TopologyRow', () => {
	const el = require( '@wordpress/element' );
	const actual = jest.requireActual( '../TopologyRow' );
	return {
		...actual,
		TopologyRow: ( props ) => {
			( globalThis.__topologyRows ||= [] ).push( props );
			return el.createElement( 'div', {
				className: 'nodes-tm__topology-stub',
				'data-name': props.topology.name,
				'data-topology-row': props.topology.name,
				'data-folded': String( !! props.folded ),
				'data-dragging': String( !! props.isDragging ),
			} );
		},
	};
} );

const { useTopologyManager } = require( '../hooks/useTopologyManager' );
const { useNodeField } = require( '../../runtime/react' );
const overviewPrefs = require( '../overviewPrefs' );

// Find the captured TopologyControls props for a topology by name.
function controlFor( name ) {
	return globalThis.__topologyControls.find( ( c ) => c.name === name );
}

// A worker descriptor (server `dump_graph` shape, passed through verbatim).
function worker( overrides = {} ) {
	return {
		partition: 0,
		state: 'live',
		started_at: 1000,
		heartbeat_age: 2,
		behind: 0,
		restart_pending: false,
		...overrides,
	};
}

function active( name, health, workers, source = 'user' ) {
	return {
		name,
		source,
		active: true,
		health,
		status: { workers },
	};
}

function hookValue( overrides = {} ) {
	return {
		topologies: [],
		currentTime: 5000,
		readRate: 0,
		writeRate: 0,
		logPartitions: 0,
		activate: jest.fn(),
		deactivate: jest.fn(),
		restart: jest.fn(),
		connected: true,
		...overrides,
	};
}

beforeEach( () => {
	Core.reset();
	useNodeField.mockReturnValue( undefined );
	overviewPrefs.readOrder.mockReturnValue( [] );
	overviewPrefs.readExpanded.mockReturnValue( new Set() );
	overviewPrefs.writeOrder.mockClear();
	overviewPrefs.writeExpanded.mockClear();
	globalThis.__topicsPanels = [];
	globalThis.__summaryCards = [];
	globalThis.__topologyControls = [];
	globalThis.__topologyRows = [];
} );
afterEach( () => {
	useTopologyManager.mockReset();
	useNodeField.mockReset();
} );

// Active rows are TopologyRow stubs; DOM order = display order.
function rowNames( container ) {
	return [ ...container.querySelectorAll( '.nodes-tm__topology-stub' ) ].map(
		( n ) => n.dataset.name
	);
}
function foldedByName( container ) {
	const out = {};
	for ( const n of container.querySelectorAll(
		'.nodes-tm__topology-stub'
	) ) {
		out[ n.dataset.name ] = n.dataset.folded === 'true';
	}
	return out;
}
// Latest captured props for a topology row (last render wins).
function rowProps( name ) {
	return globalThis.__topologyRows
		.filter( ( r ) => r.topology.name === name )
		.at( -1 );
}

describe( 'Overview fleet board', () => {
	it( 'replays the topic probe log from its start', () => {
		useTopologyManager.mockReturnValue( hookValue() );
		render( <Overview /> );
		expect( useProbeStream ).toHaveBeenCalledWith( 'topicprobe', {
			mode: 'history',
		} );
	} );

	it( 'feeds SummaryCards the fleet topologies and the hook R/W rates + partition count', () => {
		const topologies = [
			active( 'alpha', 'ok', [
				worker( { partition: 0 } ),
				worker( { partition: 1 } ),
			] ),
			active( 'beta', 'stalled', [
				worker( { partition: 0, state: 'down' } ),
			] ),
			{ name: 'gamma', source: 'stock', active: false },
		];
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies,
				readRate: 4096,
				writeRate: 8192,
				logPartitions: 3,
			} )
		);
		render( <Overview /> );
		const cards = globalThis.__summaryCards[ 0 ];
		expect( cards.topologies ).toBe( topologies );
		expect( cards.readRate ).toBe( 4096 );
		expect( cards.writeRate ).toBe( 8192 );
		expect( cards.logPartitions ).toBe( 3 );
	} );

	it( 'shows the probe read and the probe stream skips as two named notices', () => {
		publishSkippedLines( 'topicprobe:link', 4 );
		useTopologyManager.mockReturnValue(
			hookValue( { unparseableLines: 5 } )
		);
		const { container } = render( <Overview /> );
		const notices = [
			...container.querySelectorAll(
				'.newspack-nodes-banner.is-warning'
			),
		].map( ( n ) => n.textContent );
		expect( notices ).toEqual( [
			'Consumer rows: 5 lines would not parse and were skipped.',
			'Topics charts: 4 lines would not parse and were skipped.',
		] );
	} );

	it( 'names each unreadable topology and refused producer in an error banner', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				unreadable: { 'marmot-5140': 'include orphaned-5141 failed' },
				refusedProducers: {
					'firehose-5142.p{partition}':
						'log producer firehose-5142.p{partition} declares no dir',
				},
			} )
		);
		const { container } = render( <Overview /> );
		const banners = [
			...container.querySelectorAll( '.newspack-nodes-error-banner' ),
		].map( ( n ) => n.textContent );
		expect( banners ).toEqual( [
			'Topology marmot-5140 will not read, so this board leaves it out: include orphaned-5141 failed',
			'The log catalog leaves out firehose-5142.p{partition}, and the log sweep refuses to run: log producer firehose-5142.p{partition} declares no dir',
		] );
	} );

	it( 'shows only the notice of the source that skipped a line', () => {
		publishSkippedLines( 'topicprobe:link', 6 );
		useTopologyManager.mockReturnValue( hookValue() );
		const { container } = render( <Overview /> );
		const notices = [
			...container.querySelectorAll(
				'.newspack-nodes-banner.is-warning'
			),
		].map( ( n ) => n.textContent );
		expect( notices ).toEqual( [
			'Topics charts: 6 lines would not parse and were skipped.',
		] );
	} );

	it( 'renders each active topology as a TopologyRow wired with the hook handlers + folded flag', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'behind', [ worker( { behind: 4096 } ) ] ),
				],
			} )
		);
		render( <Overview /> );
		const row = rowProps( 'alpha' );
		expect( row.folded ).toBe( true );
		expect( typeof row.onExpand ).toBe( 'function' );
		expect( typeof row.onGripPointerDown ).toBe( 'function' );
		expect( typeof row.onGripPointerMove ).toBe( 'function' );
		expect( typeof row.onGripPointerUp ).toBe( 'function' );
		expect( row.onRestart ).toBe(
			useTopologyManager.mock.results[ 0 ].value.restart
		);
	} );

	it( 'does NOT reorder by health — rows stay alphabetical (nothing stored), badge aside', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'aaa-ok', 'ok', [ worker() ] ),
					active( 'zzz-stalled', 'stalled', [
						worker( { state: 'down' } ),
					] ),
				],
			} )
		);
		const { container } = render( <Overview /> );
		// Alphabetical — the stalled one stays put (no float-to-top).
		expect( rowNames( container ) ).toEqual( [ 'aaa-ok', 'zzz-stalled' ] );
	} );

	it( 'renders active rows in the persisted stored order, not alphabetical', () => {
		overviewPrefs.readOrder.mockReturnValue( [ 'zzz', 'aaa' ] );
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'aaa', 'ok', [ worker() ] ),
					active( 'mmm', 'ok', [ worker() ] ),
					active( 'zzz', 'ok', [ worker() ] ),
				],
			} )
		);
		const { container } = render( <Overview /> );
		// Stored 'zzz','aaa' first; the unstored 'mmm' appended at the end.
		expect( rowNames( container ) ).toEqual( [ 'zzz', 'aaa', 'mmm' ] );
	} );

	it( 'puts stopped topologies in a de-emphasized group: plain name, Edit only, no live link', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					{ name: 'beta', source: 'stock', active: false },
				],
			} )
		);
		const { container } = render( <Overview /> );
		// Inactive topologies are never active rows.
		expect(
			container.querySelector( '.nodes-tm__topology-stub' )
		).toBeNull();
		const stopped = container.querySelector( '.nodes-overview__stopped' );
		expect( stopped ).not.toBeNull();
		const stoppedItem = stopped.querySelector(
			'.nodes-overview__stopped-item'
		);
		expect( stoppedItem.classList.contains( 'newspack-nodes-badge' ) ).toBe(
			true
		);
		expect(
			stoppedItem.classList.contains( 'newspack-nodes-status-badge' )
		).toBe( false );
		const name = stopped.querySelector( '.nodes-overview__name' );
		expect( name.textContent ).toBe( 'beta' );
		expect( name.tagName ).not.toBe( 'A' );
		const ctl = controlFor( 'beta' );
		expect( ctl.active ).toBe( false );
		expect( ctl.editHref ).toContain( 'edit=1' );
	} );

	it( 'renders the four Topics panels (message rate, byte rate, backlog, cache size)', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [ active( 'alpha', 'ok', [ worker() ] ) ],
			} )
		);
		const { container } = render( <Overview /> );
		const titles = [
			...container.querySelectorAll( '.newspack-nodes-chart__title' ),
		].map( ( n ) => n.textContent );
		expect( titles ).toEqual( [
			'Topics Message Rate',
			'Topics Byte Rate',
			'Topics Backlog',
			'Topics Cache Size',
		] );
	} );

	it( 'titles each Topics panel Y-axis with the quantity it plots', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [ active( 'alpha', 'ok', [ worker() ] ) ],
			} )
		);
		render( <Overview /> );
		expect( globalThis.__topicsPanels.map( ( p ) => p.yLabel ) ).toEqual( [
			'Messages',
			'Bytes',
			'Backlog',
			'Cache Size',
		] );
	} );

	it( 'feeds each panel its per-topic 24h series rolled up from the probe view', () => {
		useNodeField.mockReturnValue( {
			consumers: {
				'firehose.p0': {
					source: 'firehose.p0',
					series: [
						{ ts: 100, msgRate: 1, byteRate: 4096, backlog: 0 },
						{ ts: 115, msgRate: 2, byteRate: 8192, backlog: 0 },
					],
				},
			},
		} );
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [ active( 'alpha', 'ok', [ worker() ] ) ],
			} )
		);
		render( <Overview /> );
		const panel = ( title ) =>
			globalThis.__topicsPanels.find( ( p ) => p.title === title );
		expect(
			panel( 'Topics Byte Rate' ).series[ 'firehose.p0' ].points.map(
				( p ) => p.value
			)
		).toEqual( [ 4096, 8192 ] );
		expect(
			panel( 'Topics Backlog' ).series[ 'firehose.p0' ].points.map(
				( p ) => p.value
			)
		).toEqual( [ 0, 0 ] );
	} );

	it( 'charts each worker’s readers of a partition as their own stacked series', () => {
		const reader = ( workerId, msgRate, backlog ) => ( {
			source: 'firehose.p3',
			series: [
				{
					ts: 100,
					msgRate,
					byteRate: msgRate * 64,
					backlog,
					cacheSize: backlog / 2,
					worker: workerId,
				},
			],
		} );
		useNodeField.mockReturnValue( {
			consumers: {
				'request-builder.firehose.p3': reader(
					'request-builder-6612.p3',
					7,
					300
				),
				'job-router.firehose.p3': reader(
					'job-router-6612.p3',
					11,
					500
				),
				// A co-reader inside the same process sums into its series.
				'flame-builder.firehose.p3': reader(
					'job-router-6612.p3',
					13,
					900
				),
			},
		} );
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [ active( 'alpha', 'ok', [ worker() ] ) ],
			} )
		);
		render( <Overview /> );
		const panels = globalThis.__topicsPanels.slice( -4 );
		for ( const p of panels ) {
			expect( p.stacked ).toBe( true );
			expect( p.totalLabel ).toBe( 'Total' );
			expect( Object.keys( p.series ).sort() ).toEqual( [
				'firehose.p3 · job-router-6612.p3',
				'firehose.p3 · request-builder-6612.p3',
			] );
		}
		const value = ( p, key ) => p.series[ key ].points[ 0 ].value;
		expect( value( panels[ 0 ], 'firehose.p3 · job-router-6612.p3' ) ).toBe(
			24
		);
		expect(
			value( panels[ 2 ], 'firehose.p3 · request-builder-6612.p3' )
		).toBe( 300 );
		expect( value( panels[ 2 ], 'firehose.p3 · job-router-6612.p3' ) ).toBe(
			1400
		);
	} );

	it( 'offers a New Topology deep-link in the header controls', () => {
		useTopologyManager.mockReturnValue( hookValue() );
		// No headerControlsSlot (standalone) → the control renders inline.
		const { getByText } = render( <Overview /> );
		expect(
			getByText( '+ New Topology' ).getAttribute( 'href' )
		).toContain( 'new=1' );
	} );
} );

describe( 'Overview fold/unfold merge', () => {
	it( 'renders every active topology FOLDED by default', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		const { container } = render( <Overview /> );
		expect( foldedByName( container ) ).toEqual( {
			alpha: true,
			beta: true,
		} );
	} );

	it( 'unfolds a topology when its onExpand handler fires', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		const { container } = render( <Overview /> );
		act( () => rowProps( 'alpha' ).onExpand( 'alpha' ) );
		expect( foldedByName( container ) ).toEqual( {
			alpha: false,
			beta: true,
		} );
	} );

	it( 'collapsing an unfolded row via onCollapseTopology folds it back', () => {
		overviewPrefs.readExpanded.mockReturnValue( new Set( [ 'alpha' ] ) );
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [ active( 'alpha', 'ok', [ worker() ] ) ],
			} )
		);
		const { container } = render( <Overview /> );
		expect( foldedByName( container ) ).toEqual( { alpha: false } );
		act( () => rowProps( 'alpha' ).onCollapseTopology( 'alpha' ) );
		expect( foldedByName( container ) ).toEqual( { alpha: true } );
	} );

	it( 'Unfold all expands every active topology; Fold all collapses them', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		const { getByText, container } = render( <Overview /> );
		const fold = container.querySelector( '.nodes-overview__foldall' );
		const unfold = container.querySelector( '.nodes-overview__unfoldall' );
		expect( fold.classList.contains( 'button' ) ).toBe( true );
		expect( fold.classList.contains( 'button-small' ) ).toBe( true );
		expect( unfold.classList.contains( 'button' ) ).toBe( true );
		expect( unfold.classList.contains( 'button-small' ) ).toBe( true );
		fireEvent.click( getByText( 'Unfold all' ) );
		expect( foldedByName( container ) ).toEqual( {
			alpha: false,
			beta: false,
		} );
		fireEvent.click( getByText( 'Fold all' ) );
		expect( foldedByName( container ) ).toEqual( {
			alpha: true,
			beta: true,
		} );
	} );

	it( 'shows the fold-all toolbar only when there is at least one active topology', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					{ name: 'beta', source: 'stock', active: false },
				],
			} )
		);
		const { queryByText } = render( <Overview /> );
		expect( queryByText( 'Fold all' ) ).toBeNull();
		expect( queryByText( 'Unfold all' ) ).toBeNull();
	} );

	it( 'never renders an active row for inactive topologies', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					{ name: 'beta', source: 'stock', active: false },
				],
			} )
		);
		const { container } = render( <Overview /> );
		expect(
			container.querySelector( '.nodes-tm__topology-stub' )
		).toBeNull();
		expect(
			container.querySelector( '.nodes-overview__stopped' )
		).not.toBeNull();
	} );
} );

describe( 'Overview — remaining interactions', () => {
	it( 'lists stopped topologies alphabetically', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					{ name: 'zeta', source: 'stock', active: false },
					{ name: 'alpha', source: 'stock', active: false },
				],
			} )
		);
		const { container } = render( <Overview /> );
		const names = [
			...container.querySelectorAll(
				'.nodes-overview__stopped .nodes-overview__name'
			),
		].map( ( n ) => n.textContent );
		expect( names ).toEqual( [ 'alpha', 'zeta' ] );
	} );

	it( 'toggles a node-fold key on and off via onToggleFold', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [ active( 'alpha', 'ok', [ worker() ] ) ],
			} )
		);
		render( <Overview /> );
		act( () => rowProps( 'alpha' ).onToggleFold( 'node-x' ) );
		expect( rowProps( 'alpha' ).collapsed.has( 'node-x' ) ).toBe( true );
		act( () => rowProps( 'alpha' ).onToggleFold( 'node-x' ) );
		expect( rowProps( 'alpha' ).collapsed.has( 'node-x' ) ).toBe( false );
	} );

	it( 'portals the New Topology control into the header slot when one is provided', () => {
		useTopologyManager.mockReturnValue( hookValue() );
		const slot = document.createElement( 'div' );
		document.body.appendChild( slot );
		try {
			render( <Overview headerControlsSlot={ slot } /> );
			expect( slot.textContent ).toContain( '+ New Topology' );
		} finally {
			document.body.removeChild( slot );
		}
	} );

	it( 'renders nothing into the header when the slot is still pending (null)', () => {
		useTopologyManager.mockReturnValue( hookValue() );
		const { queryByText } = render(
			<Overview headerControlsSlot={ null } />
		);
		// A null slot means "pending" — the control is not rendered at all.
		expect( queryByText( '+ New Topology' ) ).toBeNull();
	} );

	it( 'dismisses the alert modal when its OK button is clicked', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [ active( 'alpha', 'ok', [ worker() ] ) ],
			} )
		);
		const { container } = render( <Overview /> );
		// A refused mutation raises the alert through the hook's onError: the
		// answer lands on the node that asked, not on a row's promise.
		const { onError } = useTopologyManager.mock.calls.at( -1 )[ 0 ];
		act( () => onError( { name: 'alpha', message: 'boom' } ) );
		expect( container.querySelector( '.nodes-tm__alert' ) ).not.toBeNull();
		fireEvent.click(
			container.querySelector( '.nodes-tm__alert-actions .button' )
		);
		expect( container.querySelector( '.nodes-tm__alert' ) ).toBeNull();
	} );

	it( 'ignores a pointer move when no drag is in progress', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [ active( 'alpha', 'ok', [ worker() ] ) ],
			} )
		);
		const rafSpy = jest.spyOn( window, 'requestAnimationFrame' );
		render( <Overview /> );
		act( () => rowProps( 'alpha' ).onGripPointerMove( { clientY: 10 } ) );
		// No drag → no animation frame scheduled.
		expect( rafSpy ).not.toHaveBeenCalled();
		rafSpy.mockRestore();
	} );

	it( 'ignores a pointer-up when no drag is in progress', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [ active( 'alpha', 'ok', [ worker() ] ) ],
			} )
		);
		render( <Overview /> );
		overviewPrefs.writeOrder.mockClear();
		act( () => rowProps( 'alpha' ).onGripPointerUp() );
		// Early return → no reorder committed/persisted.
		expect( overviewPrefs.writeOrder ).not.toHaveBeenCalled();
	} );

	it( 'coalesces rapid pointer moves into a single animation frame', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		// Schedule but never run the frame, so dragRafRef stays pending.
		const rafSpy = jest
			.spyOn( window, 'requestAnimationFrame' )
			.mockImplementation( () => 7 );
		render( <Overview /> );
		act( () =>
			rowProps( 'alpha' ).onGripPointerDown( 'alpha', {
				preventDefault: jest.fn(),
				pointerId: 1,
				clientY: 50,
				currentTarget: { setPointerCapture: jest.fn() },
			} )
		);
		act( () => rowProps( 'alpha' ).onGripPointerMove( { clientY: 60 } ) );
		act( () => rowProps( 'alpha' ).onGripPointerMove( { clientY: 70 } ) );
		// The second move returns early because a frame is already pending.
		expect( rafSpy ).toHaveBeenCalledTimes( 1 );
		rafSpy.mockRestore();
	} );

	it( 'skips the drag frame when the dragged row is no longer present', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		const rafSpy = jest
			.spyOn( window, 'requestAnimationFrame' )
			.mockImplementation( ( cb ) => {
				cb();
				return 1;
			} );
		const { container } = render( <Overview /> );
		// Grab a name that matches no rendered row → from index is -1.
		act( () =>
			rowProps( 'alpha' ).onGripPointerDown( 'ghost', {
				preventDefault: jest.fn(),
				pointerId: 1,
				clientY: 50,
				currentTarget: { setPointerCapture: jest.fn() },
			} )
		);
		expect( () =>
			act( () =>
				rowProps( 'alpha' ).onGripPointerMove( { clientY: 60 } )
			)
		).not.toThrow();
		// The frame returned before applying any transform.
		expect(
			container.querySelector( '[data-topology-row="alpha"]' ).style
				.transform
		).toBe( '' );
		rafSpy.mockRestore();
	} );

	it( 'cancels a pending drag frame when unmounting mid-drag', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		const rafSpy = jest
			.spyOn( window, 'requestAnimationFrame' )
			.mockImplementation( () => 7 );
		const cancelSpy = jest
			.spyOn( window, 'cancelAnimationFrame' )
			.mockImplementation( () => {} );
		const { unmount } = render( <Overview /> );
		act( () =>
			rowProps( 'alpha' ).onGripPointerDown( 'alpha', {
				preventDefault: jest.fn(),
				pointerId: 1,
				clientY: 50,
				currentTarget: { setPointerCapture: jest.fn() },
			} )
		);
		act( () => rowProps( 'alpha' ).onGripPointerMove( { clientY: 60 } ) );
		unmount();
		expect( cancelSpy ).toHaveBeenCalledWith( 7 );
		rafSpy.mockRestore();
		cancelSpy.mockRestore();
	} );
} );

describe( 'Overview persistence + drag-to-reorder', () => {
	it( 'initializes the unfolded set from readExpanded()', () => {
		overviewPrefs.readExpanded.mockReturnValue( new Set( [ 'alpha' ] ) );
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		const { container } = render( <Overview /> );
		expect( foldedByName( container ) ).toEqual( {
			alpha: false,
			beta: true,
		} );
	} );

	it( 'write-throughs the unfolded set on expand, unfold-all, and fold-all', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		const { getByText } = render( <Overview /> );
		act( () => rowProps( 'alpha' ).onExpand( 'alpha' ) );
		expect( overviewPrefs.writeExpanded ).toHaveBeenLastCalledWith(
			new Set( [ 'alpha' ] )
		);
		fireEvent.click( getByText( 'Unfold all' ) );
		expect(
			[ ...overviewPrefs.writeExpanded.mock.calls.at( -1 )[ 0 ] ].sort()
		).toEqual( [ 'alpha', 'beta' ] );
		fireEvent.click( getByText( 'Fold all' ) );
		expect( overviewPrefs.writeExpanded ).toHaveBeenLastCalledWith(
			new Set()
		);
	} );

	it( 'pointer-down on the grip marks the row as dragging', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		const { container } = render( <Overview /> );
		act( () =>
			rowProps( 'alpha' ).onGripPointerDown( 'alpha', {
				preventDefault: jest.fn(),
				pointerId: 1,
				currentTarget: { setPointerCapture: jest.fn() },
			} )
		);
		expect(
			container
				.querySelector( '[data-name="alpha"]' )
				.getAttribute( 'data-dragging' )
		).toBe( 'true' );
	} );

	it( 'a pointer drag (down → move past a lower row → up) reorders + persists', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		// Pointer moves are rAF-coalesced; run the frame synchronously here.
		const rafSpy = jest
			.spyOn( window, 'requestAnimationFrame' )
			.mockImplementation( ( cb ) => {
				cb();
				return 1;
			} );
		// Geometry: alpha [0–100], beta [100–200] (jsdom has no layout).
		const rectSpy = jest
			.spyOn( Element.prototype, 'getBoundingClientRect' )
			.mockImplementation( function () {
				const name = this.getAttribute?.( 'data-topology-row' );
				const idx = 'beta' === name ? 1 : 0;
				return {
					top: idx * 100,
					bottom: idx * 100 + 100,
					left: 0,
					right: 0,
					width: 0,
					height: 100,
					x: 0,
					y: idx * 100,
				};
			} );
		const { container } = render( <Overview /> );
		const rowEl = ( name ) =>
			container.querySelector( `[data-topology-row="${ name }"]` );
		// Grab alpha at y=50, drag past beta's midpoint (y=160), release.
		act( () =>
			rowProps( 'alpha' ).onGripPointerDown( 'alpha', {
				preventDefault: jest.fn(),
				pointerId: 1,
				clientY: 50,
				currentTarget: { setPointerCapture: jest.fn() },
			} )
		);
		act( () => rowProps( 'alpha' ).onGripPointerMove( { clientY: 160 } ) );
		// Mid-drag moves via transform only; the list itself does NOT reorder.
		expect( rowEl( 'alpha' ).style.transform ).toBe( 'translateY(110px)' );
		expect( rowEl( 'beta' ).style.transform ).toBe( 'translateY(-100px)' );
		expect( rowNames( container ) ).toEqual( [ 'alpha', 'beta' ] );
		act( () => rowProps( 'alpha' ).onGripPointerUp() );
		// On drop: transforms cleared, reorder committed + persisted once.
		expect( rowEl( 'alpha' ).style.transform ).toBe( '' );
		expect( rowEl( 'beta' ).style.transform ).toBe( '' );
		expect( overviewPrefs.writeOrder ).toHaveBeenLastCalledWith( [
			'beta',
			'alpha',
		] );
		rectSpy.mockRestore();
		rafSpy.mockRestore();
	} );
} );
