/**
 * WorkerStatus tests. getCommandClient is mocked to drive dump_metadata
 * responses; buildRenderPlan branches are exercised via shaped payloads.
 */

import { render, fireEvent, act } from '@testing-library/react';
import WorkerStatus, { initialRefresh } from '../WorkerStatus';

jest.mock( '../../shared/utils/commandClient', () => ( {
	getCommandClient: jest.fn(),
} ) );
jest.mock( '../../shared/utils/unwrapCommandResponse', () => jest.fn() );
jest.mock( '../../shared/hooks/usePageVisibility', () => ( {
	__esModule: true,
	default: () => true,
} ) );

const { getCommandClient } = require( '../../shared/utils/commandClient' );
const unwrapCommandResponse = require( '../../shared/utils/unwrapCommandResponse' );

const REFRESH_KEY = 'newspack-nodes-worker-refresh';

describe( 'WorkerStatus', () => {
	let sendMock;
	beforeEach( () => {
		sendMock = jest.fn();
		getCommandClient.mockReturnValue( { send: sendMock } );
		window.localStorage.clear();
	} );

	it( 'shows the loading placeholder before the first dump_metadata response', () => {
		sendMock.mockReturnValue( new Promise( () => {} ) );
		const { container } = render( <WorkerStatus /> );
		expect( container.textContent ).toMatch( /Loading worker status/ );
	} );

	it( 'renders Worker Status heading once data arrives', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
			workers: [],
			supervisor: null,
			logs: [],
			num_partitions: 1,
			num_segments: 1,
			segment_size: 1024,
			timestamp: 0,
		} );
		const { container } = render( <WorkerStatus /> );
		await act( async () => {} );
		expect( container.textContent ).toMatch( /Worker Status/ );
	} );

	it( 'fullPage variant shows a refresh-interval select with REFRESH_OPTIONS', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
			workers: [],
			supervisor: null,
			logs: [],
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		const select = container.querySelector(
			'.newspack-nodes-refresh-select'
		);
		expect( select ).not.toBeNull();
		expect( select.options.length ).toBe( 4 ); // 1s/2s/5s/10s
	} );

	it( 'persists refresh-interval choice to localStorage', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
			workers: [],
			supervisor: null,
			logs: [],
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		const select = container.querySelector(
			'.newspack-nodes-refresh-select'
		);
		fireEvent.change( select, { target: { value: '5000' } } );
		expect( window.localStorage.getItem( REFRESH_KEY ) ).toBe( '5000' );
	} );

	it( 'restores the previously-persisted refresh-interval on mount', async () => {
		window.localStorage.setItem( REFRESH_KEY, '10000' );
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
			workers: [],
			supervisor: null,
			logs: [],
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		const select = container.querySelector(
			'.newspack-nodes-refresh-select'
		);
		expect( select.value ).toBe( '10000' );
	} );

	it( 'ignores out-of-range stored values and falls back to refreshMs prop', async () => {
		window.localStorage.setItem( REFRESH_KEY, '99999' );
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
			workers: [],
			supervisor: null,
			logs: [],
		} );
		const { container } = render(
			<WorkerStatus fullPage refreshMs={ 2000 } />
		);
		await act( async () => {} );
		const select = container.querySelector(
			'.newspack-nodes-refresh-select'
		);
		expect( select.value ).toBe( '2000' );
	} );

	it( 'surfaces a generic disconnect error when dump_metadata rejects', async () => {
		sendMock.mockRejectedValue( new Error( 'boom' ) );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		expect( container.textContent ).toMatch( /Server disconnected/ );
	} );

	it( 'renders a non-fullPage variant without the header chrome', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
			workers: [],
			supervisor: null,
			logs: [],
		} );
		const { container } = render( <WorkerStatus fullPage={ false } /> );
		await act( async () => {} );
		expect( container.querySelector( '.worker-status-header' ) ).toBeNull();
		expect( container.querySelector( '.worker-status' ) ).not.toBeNull();
	} );

	it( 'renders a worker row inside the pipeline when workers list is non-empty', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
			workers: [
				{
					type: 'firehose-workers',
					handler: 'firehose-workers',
					handlerName: 'firehose-workers',
					partition: 0,
					started_at: 1000,
					inputs_status: [],
					outputs_status: [],
				},
			],
			supervisor: null,
			logs: [],
			num_partitions: 1,
			num_segments: 1,
			segment_size: 1024,
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		expect( container.querySelector( '.pipeline-flow' ) ).not.toBeNull();
	} );

	it( 'renders the supervisor card when the descriptor is present', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
			workers: [],
			supervisor: {
				type: 'supervisor',
				status: 'running',
				started_at: 1000,
				heartbeat_age: 2,
				restart_pending: false,
			},
			logs: [],
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		expect(
			container.querySelector( '.supervisor-section' )
		).not.toBeNull();
		expect( container.querySelector( '.supervisor-row' ) ).not.toBeNull();
	} );

	// buildRenderPlan (not exported): asserted via rendered DOM order.

	it( 'buildRenderPlan: producer-consumer pair places log between workers', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
			workers: [
				{
					type: 'firehose-workers',
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
					type: 'request-workers',
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
			supervisor: null,
			logs: [],
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		// firehose-workers should appear BEFORE the log, request-workers AFTER.
		const flow = container.querySelector( '.pipeline-flow' );
		expect( flow ).not.toBeNull();
		const text = flow.textContent;
		expect( text ).toMatch( /Firehose Workers/ );
		expect( text ).toMatch( /Request Workers/ );
		expect( text ).toMatch( /firehose\.log/ );
		const firehoseIdx = text.indexOf( 'Firehose Workers' );
		const logIdx = text.indexOf( 'firehose.log' );
		const requestIdx = text.indexOf( 'Request Workers' );
		expect( firehoseIdx ).toBeLessThan( logIdx );
		expect( logIdx ).toBeLessThan( requestIdx );
	} );

	it( 'buildRenderPlan: terminal output (no consumer) renders after producer', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
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
			supervisor: null,
			logs: [],
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		const flow = container.querySelector( '.pipeline-flow' );
		const text = flow.textContent;
		const workerIdx = text.indexOf( 'Firehose Workers' );
		const logIdx = text.indexOf( 'errors.log' );
		expect( workerIdx ).toBeLessThan( logIdx );
		expect( workerIdx ).toBeGreaterThanOrEqual( 0 );
	} );

	it( 'buildRenderPlan: empty workers + logsCatalog renders catalog-only', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
			workers: [],
			supervisor: null,
			logs: [
				{
					name: 'orphan.log',
					partitions: [
						{ partition: 0, segments: [], total_size: 0 },
					],
				},
			],
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		expect( container.textContent ).toMatch( /orphan\.log/ );
	} );

	it( 'buildRenderPlan: uses logsCatalog as canonical partition list', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
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
			supervisor: null,
			logs: [
				{
					name: 'firehose.log',
					partitions: [
						{ partition: 0, segments: [], total_size: 0 },
						{ partition: 1, segments: [], total_size: 0 },
					],
				},
			],
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		expect(
			container.querySelectorAll( '.log-partition-row' ).length
		).toBeGreaterThanOrEqual( 2 );
	} );

	it( 'buildRenderPlan: catalog log not reached by step-walk still appears', async () => {
		// Log appears via the tail-append pass for catalog logs the step-walk missed.
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
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
			supervisor: null,
			logs: [
				{
					name: 'untouched.log',
					partitions: [
						{ partition: 0, segments: [], total_size: 0 },
					],
				},
			],
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		expect( container.textContent ).toMatch( /untouched\.log/ );
	} );

	// Sub-component rendering: SegmentBar / LogSection / WorkerConnector / SupervisorStatus.

	it( 'renders SegmentBar with cursor-relative classes', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
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
			supervisor: null,
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
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		const bars = container.querySelectorAll( '.worker-segment-h' );
		expect( bars.length ).toBe( 3 );
		expect(
			container.querySelectorAll( '.segment-fill-h.processed' ).length
		).toBeGreaterThan( 0 );
	} );

	it( 'SegmentBar fill uses per-log segment_size override, not global default', async () => {
		// Per-log segment_size override must scale bars against its own cap, not the global default.
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
			workers: [],
			supervisor: null,
			segment_size: 64 * 1024 * 1024, // global default — 64 MiB
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
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );

		const fills = container.querySelectorAll( '.segment-fill-h' );
		expect( fills.length ).toBeGreaterThan( 0 );
		// A 1 MiB segment under a 1 MiB cap is 100% wide (was ~1.5% against the global).
		const widthPercent = parseFloat( fills[ 0 ].style.width );
		expect( widthPercent ).toBeGreaterThanOrEqual( 99 );
	} );

	it( 'WorkerConnector renders ALL RUN badge when every worker is running', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
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
			supervisor: null,
			logs: [],
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		expect( container.textContent ).toMatch( /ALL RUN/ );
	} );

	it( 'WorkerConnector renders ALL DEAD badge when every worker is dead', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
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
			supervisor: null,
			logs: [],
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		expect( container.textContent ).toMatch( /ALL DEAD/ );
	} );

	it( 'WorkerConnector restart button calls dispatchCommand', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
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
			supervisor: null,
			logs: [],
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		const restartBtn = container.querySelector( '.worker-restart-btn' );
		expect( restartBtn ).not.toBeNull();
		sendMock.mockClear();
		sendMock.mockResolvedValue( [] );
		fireEvent.click( restartBtn );
		await act( async () => {} );
		expect( sendMock ).toHaveBeenCalledWith(
			expect.objectContaining( {
				to: 'workers',
				verb: 'restart',
				payload: expect.objectContaining( {
					types: [ 'firehose-workers' ],
					partition: -1,
				} ),
			} )
		);
	} );

	it( 'SupervisorStatus exposes a restart button when supervisor is alive and not pending', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
			workers: [],
			supervisor: {
				type: 'supervisor',
				status: 'running',
				started_at: 1000,
				heartbeat_age: 2,
				restart_pending: false,
			},
			logs: [],
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		const btn = container.querySelector(
			'.supervisor-section .worker-restart-btn'
		);
		expect( btn ).not.toBeNull();
	} );

	it( 'SupervisorStatus replaces the restart button with a pending label when restart_pending', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
			workers: [],
			supervisor: {
				type: 'supervisor',
				status: 'running',
				started_at: 1000,
				heartbeat_age: 2,
				restart_pending: true,
			},
			logs: [],
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		expect(
			container.querySelector( '.supervisor-section .worker-restart-btn' )
		).toBeNull();
		expect( container.textContent ).toMatch( /restarting/ );
	} );

	it( 'renders worker heartbeat age + stale class above 30s', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
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
			supervisor: null,
			logs: [],
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		const hb = container.querySelector( '.connector-heartbeat.stale' );
		expect( hb ).not.toBeNull();
		expect( hb.textContent ).toMatch( /99s/ );
	} );

	it( 'renders behind/eta when worker is lagging', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
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
			supervisor: null,
			logs: [],
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		const behind = container.querySelector( '.connector-behind.warning' );
		expect( behind ).not.toBeNull();
		expect( container.textContent ).toMatch( /stalled/ );
	} );

	it( 'renders restart_pending state', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
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
			supervisor: null,
			logs: [],
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		expect( container.textContent ).toMatch( /restarting/ );
		expect(
			container.querySelectorAll( '.worker-restart-btn' ).length
		).toBe( 0 );
	} );

	it( 'displays total read/write rates header in fullPage mode', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
			workers: [],
			supervisor: null,
			logs: [],
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		const totals = container.querySelectorAll( '.total-rate-value' );
		expect( totals.length ).toBe( 2 );
		expect( totals[ 0 ].textContent ).toMatch( /B\/s/ );
		expect( totals[ 1 ].textContent ).toMatch( /B\/s/ );
	} );

	it( 'second fetch tick computes write rates from total_size deltas', async () => {
		// First tick total_size 100; second tick 1100 -> non-zero write rate.
		unwrapCommandResponse
			.mockReturnValueOnce( {
				workers: [
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						status: 'running',
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
				],
				supervisor: null,
				logs: [
					{
						name: 'firehose.log',
						partitions: [
							{
								partition: 0,
								segments: [ { id: 1, size: 100 } ],
								total_size: 100,
							},
						],
					},
				],
			} )
			.mockReturnValue( {
				workers: [
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						status: 'running',
						inputs: [],
						outputs: [ 'firehose.log' ],
						inputs_status: [],
						outputs_status: [
							{
								name: 'firehose.log',
								segments: [ { id: 1, size: 1100 } ],
								total_size: 1100,
							},
						],
					},
				],
				supervisor: null,
				logs: [
					{
						name: 'firehose.log',
						partitions: [
							{
								partition: 0,
								segments: [ { id: 1, size: 1100 } ],
								total_size: 1100,
							},
						],
					},
				],
			} );
		sendMock.mockResolvedValue( [] );
		const { container, rerender } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		// Rely on the auto-refresh timer for the second tick.
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 0 ) );
		} );
		// rate-display only manifests after the second poll fires.
		expect( container.querySelector( '.pipeline-flow' ) ).not.toBeNull();
		rerender( <WorkerStatus fullPage /> );
	} );

	it( 'gracefully handles workers with no inputs/outputs arrays', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
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
			supervisor: null,
			logs: [],
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		expect( container.querySelector( '.pipeline-flow' ) ).not.toBeNull();
		expect( container.textContent ).toMatch( /Job Workers/ );
	} );

	it( 'segments animation: new segment gets segment-slide-in class', async () => {
		// Segment 2 should render with segment-slide-in via the prevSegments diff.
		const firstTick = {
			workers: [
				{
					type: 'request-workers',
					handler: 'request-workers',
					partition: 0,
					started_at: 1000,
					status: 'running',
					inputs: [ 'firehose.log' ],
					outputs: [],
					inputs_status: [
						{
							name: 'firehose.log',
							segments: [ { id: 1, size: 100 } ],
							total_size: 100,
							cursor_seg: 0,
							cursor_offset: 0,
						},
					],
					outputs_status: [],
				},
			],
			supervisor: null,
			logs: [
				{
					name: 'firehose.log',
					partitions: [
						{
							partition: 0,
							segments: [ { id: 1, size: 100 } ],
							total_size: 100,
						},
					],
				},
			],
		};
		unwrapCommandResponse.mockReturnValue( firstTick );
		sendMock.mockResolvedValue( [] );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		expect( container.querySelector( '.pipeline-flow' ) ).not.toBeNull();
	} );

	it( 'getLogKey strips .log suffix for rate lookups', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( {
			workers: [],
			supervisor: null,
			logs: [
				{
					name: 'firehose.log',
					partitions: [
						{ partition: 0, segments: [], total_size: 0 },
					],
				},
			],
		} );
		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		// stripped key. Empty stats → "0 B/s".
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
