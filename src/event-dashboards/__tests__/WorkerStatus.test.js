/**
 * WorkerStatus UI-surface tests — the thin view over the workerstatus node graph.
 *
 * The graph (poll → transform → view) is owned by useWorkerStatusGraph and tested
 * by its own suite (and the node suites cover the rate/segment math, the poll, and
 * the restart command). Here we mock the hook to hand back spy control callbacks,
 * and register a fixture `workerstatus:view` node in Core seeded with a render
 * model so the view can read it via useNodeState — mirroring RawLogs.test.js.
 *
 * Every DOM assertion that used to drive the component through a mocked
 * dump_graph response now feeds the SAME shaped model directly, so the
 * rendered DOM + SCSS classes stay byte-for-byte what they were.
 */

import { render, fireEvent } from '@testing-library/react';
import { Core } from '../../runtime/core';
import WorkerStatus, { initialRefresh } from '../WorkerStatus';

// The graph hook is exercised by its own suite; mock it to spy on the control
// callbacks the thin view wires to the restart buttons + refresh select, and to
// hand back the current refresh interval.
jest.mock( '../hooks/useWorkerStatusGraph', () => {
	const actual = jest.requireActual( '../hooks/useWorkerStatusGraph' );
	return {
		__esModule: true,
		// Keep the real localStorage-migration helper + options the view imports.
		initialRefresh: actual.initialRefresh,
		REFRESH_OPTIONS: actual.REFRESH_OPTIONS,
		useWorkerStatusGraph: jest.fn(),
	};
} );

const { useWorkerStatusGraph } = require( '../hooks/useWorkerStatusGraph' );

const VIEW_NODE = 'workerstatus:view';

// A minimal stand-in for the workerstatus:view node: the model lives in
// setStateCache.view (what useNodeState subscribes to). setState here notifies
// subscribers exactly like the real Node.setState. Seeding BEFORE render lets
// useNodeState find the node on the first render and read the model immediately.
function registerViewFixture( model ) {
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
	Core.nodes.set( VIEW_NODE, node );
	return node;
}

// Build the enriched render model the graph publishes, from the raw-metadata
// shape the old tests expressed. Rates / segment tracking default empty (the
// transform's first-snapshot output) unless a test overrides them.
function viewModel( {
	workers = [],
	supervisor = null,
	logs = [],
	graph = {},
	byteRates = {},
	writeRates = {},
	segmentSize = 64 * 1024 * 1024,
	timestamp = 0,
	prevSegments = {},
	removingSegments = {},
	error = null,
	loading = false,
} = {} ) {
	return {
		workers,
		supervisor,
		logs,
		graph,
		byteRates,
		writeRates,
		segmentSize,
		currentTime: timestamp,
		prevSegments,
		removingSegments,
		error,
		loading,
	};
}

// A graph with a single staffed logic node (one topology). Structure now comes
// from the graph, so a worker-only model would build no tree; this is the
// minimal graph that renders one section whose header/row reflects the worker.
function soloLogicGraph( topology ) {
	return {
		[ topology ]: {
			nodes: [ { name: topology, kind: 'logic' } ],
			edges: [],
		},
	};
}

describe( 'WorkerStatus', () => {
	let restart;
	let setRefreshInterval;

	beforeEach( () => {
		Core.reset();
		window.localStorage.clear();
		restart = jest.fn();
		setRefreshInterval = jest.fn();
		useWorkerStatusGraph.mockClear();
		useWorkerStatusGraph.mockReturnValue( {
			restart,
			setRefreshInterval,
			refreshMs: '2000',
		} );
	} );

	it( 'shows the loading placeholder before the first model is published', () => {
		// No view node registered → useNodeState yields undefined → EMPTY_MODEL
		// (loading:true, empty workers) → the loading gate.
		const { container } = render( <WorkerStatus /> );
		expect( container.textContent ).toMatch( /Loading worker status/ );
	} );

	it( 'renders Worker Status heading once a model arrives', () => {
		registerViewFixture( viewModel() );
		const { container } = render( <WorkerStatus /> );
		expect( container.textContent ).toMatch( /Worker Status/ );
	} );

	it( 'fullPage variant shows a refresh-interval select with REFRESH_OPTIONS', () => {
		registerViewFixture( viewModel() );
		const { container } = render( <WorkerStatus fullPage /> );
		const select = container.querySelector(
			'.newspack-nodes-refresh-select'
		);
		expect( select ).not.toBeNull();
		expect( select.options.length ).toBe( 4 ); // 1s/2s/5s/10s
	} );

	it( 'changing the refresh-interval calls the graph setRefreshInterval', () => {
		registerViewFixture( viewModel() );
		const { container } = render( <WorkerStatus fullPage /> );
		const select = container.querySelector(
			'.newspack-nodes-refresh-select'
		);
		fireEvent.change( select, { target: { value: '5000' } } );
		expect( setRefreshInterval ).toHaveBeenCalledWith( '5000' );
	} );

	it( 'reflects the persisted refresh-interval reported by the graph hook', () => {
		useWorkerStatusGraph.mockReturnValue( {
			restart,
			setRefreshInterval,
			refreshMs: '10000',
		} );
		registerViewFixture( viewModel() );
		const { container } = render( <WorkerStatus fullPage /> );
		const select = container.querySelector(
			'.newspack-nodes-refresh-select'
		);
		expect( select.value ).toBe( '10000' );
	} );

	it( 'surfaces a disconnect error through the shared ConnectionBanner', () => {
		registerViewFixture(
			viewModel( { error: 'Server disconnected. Reconnecting...' } )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		const banner = container.querySelector(
			'.newspack-nodes-connection-banner'
		);
		expect( banner ).not.toBeNull();
		expect( banner.textContent ).toMatch( /Server disconnected/ );
		// The bespoke inline banner is gone in favor of the shared component.
		expect(
			container.querySelector( '.worker-status-error-inline' )
		).toBeNull();
	} );

	it( 'renders no ConnectionBanner when the model has no error', () => {
		registerViewFixture( viewModel( { error: null } ) );
		const { container } = render( <WorkerStatus fullPage /> );
		expect(
			container.querySelector( '.newspack-nodes-connection-banner' )
		).toBeNull();
	} );

	it( 'renders a non-fullPage variant without the header chrome', () => {
		registerViewFixture( viewModel() );
		const { container } = render( <WorkerStatus fullPage={ false } /> );
		expect( container.querySelector( '.worker-status-header' ) ).toBeNull();
		expect( container.querySelector( '.worker-status' ) ).not.toBeNull();
	} );

	it( 'renders a topology section when workers list is non-empty', () => {
		registerViewFixture(
			viewModel( {
				workers: [
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						handlerName: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						inputs: [],
						outputs: [],
						inputs_status: [],
						outputs_status: [],
					},
				],
				graph: {
					'firehose-workers': {
						nodes: [ { name: 'firehose-workers', kind: 'logic' } ],
						edges: [],
					},
				},
				segmentSize: 1024,
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		expect( container.querySelector( '.topology-section' ) ).not.toBeNull();
		expect( container.textContent ).toMatch( /Firehose Workers/ );
	} );

	it( 'trims persisted fold keys to what is currently on the page', () => {
		// A stale key (removed/renamed topology) must be dropped from storage.
		window.localStorage.setItem(
			'newspack-nodes-worker-status-collapsed',
			JSON.stringify( [ 'firehose-workers', 'ghost-topology' ] )
		);
		registerViewFixture(
			viewModel( {
				workers: [
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						inputs: [],
						outputs: [],
						inputs_status: [],
						outputs_status: [],
					},
				],
				graph: {
					'firehose-workers': {
						nodes: [ { name: 'firehose-workers', kind: 'logic' } ],
						edges: [],
					},
				},
			} )
		);
		render( <WorkerStatus fullPage /> );
		const stored = JSON.parse(
			window.localStorage.getItem(
				'newspack-nodes-worker-status-collapsed'
			)
		);
		expect( stored ).toContain( 'firehose-workers' );
		expect( stored ).not.toContain( 'ghost-topology' );
	} );

	it( 'renders the supervisor card when the descriptor is present', () => {
		registerViewFixture(
			viewModel( {
				supervisor: {
					type: 'supervisor',
					status: 'running',
					started_at: 1000,
					heartbeat_age: 2,
					restart_pending: false,
				},
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		expect(
			container.querySelector( '.supervisor-section' )
		).not.toBeNull();
		expect( container.querySelector( '.supervisor-row' ) ).not.toBeNull();
	} );

	// Tree placement (buildTopologySections, not exported here): asserted via rendered DOM order.

	it( 'tree: producer-consumer pair nests the log between the workers', () => {
		registerViewFixture(
			viewModel( {
				workers: [
					{
						type: 'combined',
						handler: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						inputs: [],
						outputs: [ 'firehose.log' ],
						inputs_status: [],
						outputs_status: [
							{
								name: 'firehose.log',
								segments: [ { id: 1, size: 100 } ],
								total_size: 100,
							},
						],
					},
					{
						type: 'combined',
						handler: 'request-workers',
						partition: 0,
						started_at: 1000,
						inputs: [ 'firehose.log' ],
						outputs: [],
						inputs_status: [
							{
								name: 'firehose.log',
								segments: [ { id: 1, size: 100 } ],
								total_size: 100,
								cursor_seg: 1,
								cursor_offset: 50,
							},
						],
						outputs_status: [],
					},
				],
				graph: {
					combined: {
						nodes: [
							{ name: 'firehose-workers', kind: 'logic' },
							{
								name: 'firehose-out',
								kind: 'partition',
								writes: 'firehose.log',
							},
							{
								name: 'firehose-in',
								kind: 'consumer',
								reads: 'firehose.log',
							},
							{ name: 'request-workers', kind: 'logic' },
						],
						edges: [
							[ 'firehose-workers', 'firehose-out' ],
							[ 'firehose-in', 'request-workers' ],
						],
					},
				},
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		// firehose-workers (producer) above the log, request-workers (consumer) below.
		const section = container.querySelector( '.topology-section' );
		expect( section ).not.toBeNull();
		const text = section.textContent;
		expect( text ).toMatch( /Firehose Workers/ );
		expect( text ).toMatch( /Request Workers/ );
		expect( text ).toMatch( /firehose\.log/ );
		const firehoseIdx = text.indexOf( 'Firehose Workers' );
		const logIdx = text.indexOf( 'firehose.log' );
		const requestIdx = text.indexOf( 'Request Workers' );
		expect( firehoseIdx ).toBeLessThan( logIdx );
		expect( logIdx ).toBeLessThan( requestIdx );
	} );

	it( 'tree: terminal output (no consumer) nests below its producer', () => {
		registerViewFixture(
			viewModel( {
				workers: [
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						inputs: [],
						outputs: [ 'errors.log' ],
						inputs_status: [],
						outputs_status: [
							{
								name: 'errors.log',
								segments: [ { id: 1, size: 50 } ],
								total_size: 50,
							},
						],
					},
				],
				graph: {
					'firehose-workers': {
						nodes: [
							{ name: 'firehose-workers', kind: 'logic' },
							{
								name: 'errors-out',
								kind: 'partition',
								writes: 'errors.log',
							},
						],
						edges: [ [ 'firehose-workers', 'errors-out' ] ],
					},
				},
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		const section = container.querySelector( '.topology-section' );
		const text = section.textContent;
		const workerIdx = text.indexOf( 'Firehose Workers' );
		const logIdx = text.indexOf( 'errors.log' );
		expect( workerIdx ).toBeLessThan( logIdx );
		expect( workerIdx ).toBeGreaterThanOrEqual( 0 );
	} );

	it( 'tree: renders one flat log row per concrete catalog partition entry', () => {
		// Flat layout: the catalog holds one CONCRETE per-partition entry; the
		// partition-token consumer vertex expands into one flat log row each.
		registerViewFixture(
			viewModel( {
				workers: [
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						inputs: [ 'firehose.p0' ],
						outputs: [],
						inputs_status: [
							{
								name: 'firehose.p0',
								segments: [],
								cursor_seg: 0,
								cursor_offset: 0,
							},
						],
						outputs_status: [],
					},
				],
				graph: {
					'firehose-workers': {
						nodes: [
							{
								name: 'firehose-in',
								kind: 'consumer',
								reads: 'firehose.p<partition>',
							},
							{ name: 'firehose-workers', kind: 'logic' },
						],
						edges: [ [ 'firehose-in', 'firehose-workers' ] ],
					},
				},
				logs: [
					{
						name: 'firehose.p0',
						partitions: [
							{ partition: 0, segments: [], total_size: 0 },
						],
					},
					{
						name: 'firehose.p1',
						partitions: [
							{ partition: 1, segments: [], total_size: 0 },
						],
					},
				],
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		expect(
			container.querySelectorAll( '.log-partition-row' ).length
		).toBeGreaterThanOrEqual( 2 );
	} );

	it( 'tree: an orphan catalog log (no producer/consumer worker) is not rendered', () => {
		// Topology-grouped: logs render as children of nodes within a topology, so a
		// catalog log with no producer/consumer worker has no tree to hang from.
		registerViewFixture(
			viewModel( {
				workers: [
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						inputs: [],
						outputs: [],
						inputs_status: [],
						outputs_status: [],
					},
				],
				graph: {
					'firehose-workers': {
						nodes: [ { name: 'firehose-workers', kind: 'logic' } ],
						edges: [],
					},
				},
				logs: [
					{
						name: 'untouched.log',
						partitions: [
							{ partition: 0, segments: [], total_size: 0 },
						],
					},
				],
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		expect( container.textContent ).not.toMatch( /untouched\.log/ );
	} );

	it( 'empty workers list renders no topology sections', () => {
		// With no workers there are no topologies, so the sections region is empty.
		registerViewFixture(
			viewModel( {
				logs: [
					{
						name: 'orphan.log',
						partitions: [
							{ partition: 0, segments: [], total_size: 0 },
						],
					},
				],
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		expect(
			container.querySelector( '.topology-sections' )
		).not.toBeNull();
		expect( container.querySelector( '.topology-section' ) ).toBeNull();
		expect( container.textContent ).not.toMatch( /orphan\.log/ );
	} );

	it( 'tree: a standalone worker (no inputs/outputs) renders as a section root node', () => {
		// A worker with empty inputs AND outputs is its own topology section, rendered
		// as a top-level node entity with no child logs.
		registerViewFixture(
			viewModel( {
				workers: [
					{
						type: 'digest',
						handler: 'digest',
						partition: 0,
						started_at: 1000,
						status: 'running',
						inputs: [],
						outputs: [],
						inputs_status: [],
						outputs_status: [],
					},
				],
				graph: {
					digest: {
						nodes: [ { name: 'digest', kind: 'logic' } ],
						edges: [],
					},
				},
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		const section = container.querySelector( '.topology-section' );
		expect( section ).not.toBeNull();
		expect( section.textContent ).toMatch( /Digest/ );
		// No log children hang off a standalone node.
		expect( section.querySelector( '.log-name' ) ).toBeNull();
	} );

	// Sub-component rendering: SegmentBar / TopologySection / SupervisorStatus.

	it( 'renders SegmentBar with cursor-relative classes', () => {
		registerViewFixture(
			viewModel( {
				workers: [
					{
						type: 'request-workers',
						handler: 'request-workers',
						partition: 0,
						started_at: 1000,
						inputs: [ 'firehose.log' ],
						outputs: [],
						inputs_status: [
							{
								name: 'firehose.log',
								segments: [
									{ id: 1, size: 1000 },
									{ id: 2, size: 1000 },
									{ id: 3, size: 1000 },
								],
								total_size: 3000,
								cursor_seg: 2,
								cursor_offset: 500,
							},
						],
						outputs_status: [],
					},
				],
				graph: {
					'request-workers': {
						nodes: [
							{
								name: 'firehose-in',
								kind: 'consumer',
								reads: 'firehose.log',
							},
							{ name: 'request-workers', kind: 'logic' },
						],
						edges: [ [ 'firehose-in', 'request-workers' ] ],
					},
				},
				logs: [
					{
						name: 'firehose.log',
						partitions: [
							{
								partition: 0,
								segments: [
									{ id: 1, size: 1000 },
									{ id: 2, size: 1000 },
									{ id: 3, size: 1000 },
								],
								total_size: 3000,
							},
						],
					},
				],
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		const bars = container.querySelectorAll( '.worker-segment-h' );
		expect( bars.length ).toBe( 3 );
		expect(
			container.querySelectorAll( '.segment-fill-h.processed' ).length
		).toBeGreaterThan( 0 );
	} );

	it( 'SegmentBar fill uses per-log segment_size override, not global default', () => {
		// Per-log segment_size override must scale bars against its own cap, not the global default.
		registerViewFixture(
			viewModel( {
				segmentSize: 64 * 1024 * 1024, // global default — 64 MiB
				workers: [
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						inputs: [],
						outputs: [ 'completed.log' ],
						inputs_status: [],
						outputs_status: [],
					},
				],
				graph: {
					'firehose-workers': {
						nodes: [
							{ name: 'firehose-workers', kind: 'logic' },
							{
								name: 'completed-out',
								kind: 'partition',
								writes: 'completed.log',
							},
						],
						edges: [ [ 'firehose-workers', 'completed-out' ] ],
					},
				},
				logs: [
					{
						name: 'completed.log',
						segment_size: 1048576, // 1 MiB override
						partitions: [
							{
								partition: 0,
								segments: [ { id: 0, size: 1048576 } ], // full at 1 MiB
								total_size: 1048576,
							},
						],
					},
				],
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );

		const fills = container.querySelectorAll( '.segment-fill-h' );
		expect( fills.length ).toBeGreaterThan( 0 );
		// A 1 MiB segment under a 1 MiB cap is 100% wide (was ~1.5% against the global).
		const widthPercent = parseFloat( fills[ 0 ].style.width );
		expect( widthPercent ).toBeGreaterThanOrEqual( 99 );
	} );

	it( 'TopologySection renders ALL RUN badge when every worker is running', () => {
		registerViewFixture(
			viewModel( {
				workers: [
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						status: 'running',
						inputs: [],
						outputs: [],
						inputs_status: [],
						outputs_status: [],
					},
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						partition: 1,
						started_at: 1000,
						status: 'running',
						inputs: [],
						outputs: [],
						inputs_status: [],
						outputs_status: [],
					},
				],
				graph: {
					'firehose-workers': {
						nodes: [ { name: 'firehose-workers', kind: 'logic' } ],
						edges: [],
					},
				},
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		expect( container.textContent ).toMatch( /ALL RUN/ );
	} );

	it( 'TopologySection renders ALL DEAD badge when every worker is dead', () => {
		registerViewFixture(
			viewModel( {
				workers: [
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						status: 'dead',
						inputs: [],
						outputs: [],
						inputs_status: [],
						outputs_status: [],
					},
				],
				graph: soloLogicGraph( 'firehose-workers' ),
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		expect( container.textContent ).toMatch( /ALL DEAD/ );
	} );

	it( 'TopologySection restart button calls the graph restart callback', () => {
		registerViewFixture(
			viewModel( {
				workers: [
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						status: 'running',
						inputs: [],
						outputs: [],
						inputs_status: [],
						outputs_status: [],
					},
				],
				graph: soloLogicGraph( 'firehose-workers' ),
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		const restartBtn = container.querySelector( '.worker-restart-btn' );
		expect( restartBtn ).not.toBeNull();
		fireEvent.click( restartBtn );
		expect( restart ).toHaveBeenCalledWith( 'firehose-workers' );
	} );

	it( 'SupervisorStatus exposes a restart button when supervisor is alive and not pending', () => {
		registerViewFixture(
			viewModel( {
				supervisor: {
					type: 'supervisor',
					status: 'running',
					started_at: 1000,
					heartbeat_age: 2,
					restart_pending: false,
				},
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		const btn = container.querySelector(
			'.supervisor-section .worker-restart-btn'
		);
		expect( btn ).not.toBeNull();
	} );

	it( 'SupervisorStatus restart button calls the graph restart callback with "supervisor"', () => {
		registerViewFixture(
			viewModel( {
				supervisor: {
					type: 'supervisor',
					status: 'running',
					started_at: 1000,
					heartbeat_age: 2,
					restart_pending: false,
				},
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		const btn = container.querySelector(
			'.supervisor-section .worker-restart-btn'
		);
		fireEvent.click( btn );
		expect( restart ).toHaveBeenCalledWith( 'supervisor' );
	} );

	it( 'SupervisorStatus replaces the restart button with a pending label when restart_pending', () => {
		registerViewFixture(
			viewModel( {
				supervisor: {
					type: 'supervisor',
					status: 'running',
					started_at: 1000,
					heartbeat_age: 2,
					restart_pending: true,
				},
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		expect(
			container.querySelector( '.supervisor-section .worker-restart-btn' )
		).toBeNull();
		expect( container.textContent ).toMatch( /restarting/ );
	} );

	it( 'renders worker heartbeat age + stale class above 30s', () => {
		registerViewFixture(
			viewModel( {
				workers: [
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						status: 'running',
						heartbeat_age: 99,
						inputs: [],
						outputs: [],
						inputs_status: [],
						outputs_status: [],
					},
				],
				graph: soloLogicGraph( 'firehose-workers' ),
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		const hb = container.querySelector( '.connector-heartbeat.stale' );
		expect( hb ).not.toBeNull();
		expect( hb.textContent ).toMatch( /99s/ );
	} );

	it( 'renders behind/eta when worker is lagging', () => {
		registerViewFixture(
			viewModel( {
				workers: [
					{
						type: 'request-workers',
						handler: 'request-workers',
						partition: 0,
						started_at: 1000,
						status: 'running',
						behind: 2 * 1024 * 1024, // >1MB triggers warning class
						inputs: [],
						outputs: [],
						inputs_status: [],
						outputs_status: [],
					},
				],
				graph: soloLogicGraph( 'request-workers' ),
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		const behind = container.querySelector( '.connector-behind.warning' );
		expect( behind ).not.toBeNull();
		expect( container.textContent ).toMatch( /stalled/ );
	} );

	it( 'renders restart_pending state', () => {
		registerViewFixture(
			viewModel( {
				workers: [
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						status: 'running',
						restart_pending: true,
						inputs: [],
						outputs: [],
						inputs_status: [],
						outputs_status: [],
					},
				],
				graph: soloLogicGraph( 'firehose-workers' ),
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		expect( container.textContent ).toMatch( /restarting/ );
		expect(
			container.querySelectorAll( '.worker-restart-btn' ).length
		).toBe( 0 );
	} );

	it( 'displays total read/write rates header in fullPage mode', () => {
		registerViewFixture( viewModel() );
		const { container } = render( <WorkerStatus fullPage /> );
		const totals = container.querySelectorAll( '.total-rate-value' );
		expect( totals.length ).toBe( 2 );
		expect( totals[ 0 ].textContent ).toMatch( /B\/s/ );
		expect( totals[ 1 ].textContent ).toMatch( /B\/s/ );
	} );

	it( 'sums byteRates/writeRates from the model into the header totals', () => {
		registerViewFixture(
			viewModel( {
				byteRates: { 'request-workers-0-': 1024 },
				writeRates: { 'firehose.p0': 2048 },
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		const totals = container.querySelectorAll( '.total-rate-value' );
		// W total = 2048 = 2 KB/s; R total = 1024 = 1 KB/s.
		expect( totals[ 0 ].textContent ).toMatch( /2 KB\/s/ );
		expect( totals[ 1 ].textContent ).toMatch( /1 KB\/s/ );
	} );

	it( 'gracefully handles workers with no inputs/outputs arrays', () => {
		registerViewFixture(
			viewModel( {
				workers: [
					{
						type: 'job-workers',
						handler: 'job-workers',
						partition: 0,
						started_at: 1000,
						status: 'running',
						// No inputs/outputs/inputs_status/outputs_status keys.
					},
				],
				graph: soloLogicGraph( 'job-workers' ),
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		expect( container.querySelector( '.topology-section' ) ).not.toBeNull();
		expect( container.textContent ).toMatch( /Job Workers/ );
	} );

	it( 'segments animation: a removing segment renders with segment-slide-out', () => {
		// removingSegments comes pre-computed in the model; the view merges them in
		// and tags them with the slide-out class.
		registerViewFixture(
			viewModel( {
				workers: [
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						inputs: [],
						outputs: [ 'firehose.log' ],
						inputs_status: [],
						outputs_status: [],
					},
				],
				graph: {
					'firehose-workers': {
						nodes: [
							{ name: 'firehose-workers', kind: 'logic' },
							{
								name: 'firehose-out',
								kind: 'partition',
								writes: 'firehose.log',
							},
						],
						edges: [ [ 'firehose-workers', 'firehose-out' ] ],
					},
				},
				logs: [
					{
						name: 'firehose.log',
						partitions: [
							{
								partition: 0,
								segments: [ { id: 2, size: 100 } ],
								total_size: 100,
							},
						],
					},
				],
				removingSegments: {
					// Grouped render keys on the CONCRETE partition name; a token-free
					// `firehose.log` is its own concrete name (partition 0).
					'firehose.log': [ { id: 1, size: 100 } ],
				},
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		expect(
			container.querySelector( '.segment-slide-out' )
		).not.toBeNull();
	} );

	it( 'segments animation: a new segment renders with segment-slide-in', () => {
		// prevSegments lacks id 2, so the render path flags it new (slide-in).
		registerViewFixture(
			viewModel( {
				workers: [
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						inputs: [],
						outputs: [ 'firehose.log' ],
						inputs_status: [],
						outputs_status: [],
					},
				],
				graph: {
					'firehose-workers': {
						nodes: [
							{ name: 'firehose-workers', kind: 'logic' },
							{
								name: 'firehose-out',
								kind: 'partition',
								writes: 'firehose.log',
							},
						],
						edges: [ [ 'firehose-workers', 'firehose-out' ] ],
					},
				},
				logs: [
					{
						name: 'firehose.log',
						partitions: [
							{
								partition: 0,
								segments: [
									{ id: 1, size: 100 },
									{ id: 2, size: 100 },
								],
								total_size: 200,
							},
						],
					},
				],
				prevSegments: { 'firehose.log': new Set( [ 1 ] ) },
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		expect( container.querySelector( '.segment-slide-in' ) ).not.toBeNull();
	} );

	it( 'seeds the collapsed set from localStorage so a matching entity renders folded on first render', () => {
		// A persisted fold for the root log's position key collapses it on mount.
		window.localStorage.setItem(
			'newspack-nodes-worker-status-collapsed',
			JSON.stringify( [ 'firehose.log' ] )
		);
		registerViewFixture(
			viewModel( {
				workers: [
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						inputs: [ 'firehose.log' ],
						outputs: [],
						inputs_status: [
							{
								name: 'firehose.log',
								segments: [],
								cursor_seg: 0,
								cursor_offset: 0,
							},
						],
						outputs_status: [],
					},
				],
				graph: {
					'firehose-workers': {
						nodes: [
							{
								name: 'firehose-in',
								kind: 'consumer',
								reads: 'firehose.log',
							},
							{ name: 'firehose-workers', kind: 'logic' },
						],
						edges: [ [ 'firehose-in', 'firehose-workers' ] ],
					},
				},
				logs: [
					{
						name: 'firehose.log',
						partitions: [
							{ partition: 0, segments: [], total_size: 0 },
						],
					},
				],
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		// The root log is collapsed → its partition rows + child node are hidden.
		expect( container.querySelector( '.log-partition-row' ) ).toBeNull();
		expect( container.textContent ).not.toMatch( /Firehose Workers/ );
	} );

	it( 'persists the collapsed set to localStorage when a fold is toggled', () => {
		registerViewFixture(
			viewModel( {
				workers: [
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						inputs: [ 'firehose.log' ],
						outputs: [],
						inputs_status: [
							{
								name: 'firehose.log',
								segments: [],
								cursor_seg: 0,
								cursor_offset: 0,
							},
						],
						outputs_status: [],
					},
				],
				graph: {
					'firehose-workers': {
						nodes: [
							{
								name: 'firehose-in',
								kind: 'consumer',
								reads: 'firehose.log',
							},
							{ name: 'firehose-workers', kind: 'logic' },
						],
						edges: [ [ 'firehose-in', 'firehose-workers' ] ],
					},
				},
				logs: [
					{
						name: 'firehose.log',
						partitions: [
							{ partition: 0, segments: [], total_size: 0 },
						],
					},
				],
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		// Toggle the root log's fold caret.
		fireEvent.click( container.querySelector( '.caret' ) );
		expect(
			JSON.parse(
				window.localStorage.getItem(
					'newspack-nodes-worker-status-collapsed'
				)
			)
		).toEqual( [ 'firehose.log' ] );
	} );

	it( 'log rate key strips .log suffix for rate lookups', () => {
		registerViewFixture(
			viewModel( {
				workers: [
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						inputs: [],
						outputs: [ 'firehose.log' ],
						inputs_status: [],
						outputs_status: [],
					},
				],
				graph: {
					'firehose-workers': {
						nodes: [
							{ name: 'firehose-workers', kind: 'logic' },
							{
								name: 'firehose-out',
								kind: 'partition',
								writes: 'firehose.log',
							},
						],
						edges: [ [ 'firehose-workers', 'firehose-out' ] ],
					},
				},
				logs: [
					{
						name: 'firehose.log',
						partitions: [
							{ partition: 0, segments: [], total_size: 0 },
						],
					},
				],
			} )
		);
		const { container } = render( <WorkerStatus fullPage /> );
		// Concrete-name key (firehose.log). Empty stats → "0 B/s".
		expect( container.textContent ).toMatch( /W 0 B\/s/ );
	} );
} );

describe( 'initialRefresh (localStorage key migration)', () => {
	test( 'migrates a saved refresh pref from the legacy key', () => {
		window.localStorage.clear();
		window.localStorage.setItem(
			'newspack-event-logger-nodes-worker-refresh',
			'10000'
		);
		expect( initialRefresh( '2000' ) ).toBe( '10000' ); // legacy honored
		expect(
			window.localStorage.getItem( 'newspack-nodes-worker-refresh' )
		).toBe( '10000' ); // written forward
	} );

	test( 'prefers the new key when both exist', () => {
		window.localStorage.clear();
		window.localStorage.setItem(
			'newspack-event-logger-nodes-worker-refresh',
			'10000'
		);
		window.localStorage.setItem( 'newspack-nodes-worker-refresh', '5000' );
		expect( initialRefresh( '2000' ) ).toBe( '5000' );
	} );

	test( 'falls back to the default when neither key is set or the value is invalid', () => {
		window.localStorage.clear();
		expect( initialRefresh( '2000' ) ).toBe( '2000' );
		window.localStorage.setItem( 'newspack-nodes-worker-refresh', 'bogus' ); // not in REFRESH_OPTIONS
		expect( initialRefresh( '2000' ) ).toBe( '2000' );
	} );
} );
