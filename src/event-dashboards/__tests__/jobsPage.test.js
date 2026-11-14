/**
 * The Jobs tab — its default layout's charts and its job table over the
 * durable jobstats.p0 log, and the topic probe's jobs backlog. `useSource`
 * hands back each source's model as the test seeds it; a panel is what the
 * time-chart block hands `TimeChart` from the layout's attributes and the
 * source's declared field.
 */

const mockModels = {};
jest.mock( '@newspack-nodes/shared/sources', () => ( {
	...jest.requireActual( '@newspack-nodes/shared/sources' ),
	useSource: ( name ) => ( {
		model: mockModels[ name ] ?? null,
		error: null,
		loading: ! mockModels[ name ],
		stale: false,
	} ),
} ) );

import { render } from '@testing-library/react';
import { sourceDeclaration } from '@newspack-nodes/shared/sources';
import { axisDuration } from '@newspack-nodes/shared/utils/axis-ticks';
import { publishSkippedLines } from '@newspack-nodes/shared/test-utils/skippedLines';
import { bucketsFrom } from './bucketTestUtils';
import { Core } from '../../runtime/core';
import { JobsTab } from '../stationTabs';
import LAYOUTS from '../../../tests/fixtures/station-layouts.json';
import { localizeStationPages } from '../../station/__tests__/localizeStationPages';

/**
 * Every time chart a layout's tree holds, in order.
 *
 * @param {Array<Object>} tree The tree.
 * @return {Array<Object>} Each chart's attributes.
 */
const chartsOf = ( tree ) =>
	tree.flatMap( ( node ) =>
		'newspack-nodes/time-chart' === node.name
			? [ node.attributes ]
			: chartsOf( node.inner )
	);

/**
 * Each panel the default layout draws, as the time-chart block hands it to
 * `TimeChart`: the chart's title and stacking, and its one metric's axis,
 * formatters and series, derived from the models seeded now.
 *
 * @return {Array<Object>} The panels.
 */
const panels = () =>
	chartsOf( LAYOUTS[ 'newspack-nodes/station-jobs' ] ).map(
		( { source, metrics: [ key ], stacked, title } ) => {
			const field = sourceDeclaration( source ).fields[ key ];
			return Object.fromEntries(
				Object.entries( {
					title,
					stacked,
					yLabel: field.axis ?? field.label,
					formatFor: field.formatFor,
					formatValue: field.format,
					series: field.value( mockModels[ source ] ?? {} ),
				} ).filter( ( [ , value ] ) => undefined !== value )
			);
		}
	);

/**
 * Seed the sources the page reads.
 *
 * @param {?Object} stats   The probe stats model.
 * @param {?Object} [probe] The topic probe model.
 */
function seed( stats, probe ) {
	for ( const name of Object.keys( mockModels ) ) {
		delete mockModels[ name ];
	}
	if ( stats ) {
		mockModels[ 'nodes/jobstats' ] = stats;
	}
	if ( probe ) {
		mockModels[ 'nodes/topicprobe' ] = probe;
	}
}

function model() {
	return {
		handlers: {
			'cron:films': {
				key: 'cron:films',
				handler: 'cron',
				// Windowed totals differ from the newest cumulative record so a
				// table reading `latest` is caught.
				windowed: {
					runs: 12,
					errors: 5,
					avgDurationMs: 210,
					itemsOk: 60,
					itemsErr: 9,
				},
				latest: {
					runs: 4,
					errors: 1,
					avgDurationMs: 200,
					avgQueueMs: 100,
					itemsOk: 20,
					itemsErr: 3,
					lastTs: Math.floor( Date.now() / 1000 ) - 30,
					lastDurationMs: 250,
					lastStatus: 'error',
					lastMessage: 'Job failed: 3 error(s), no items processed',
				},
				buckets: bucketsFrom( [
					{
						ts: 1,
						elapsed: 15,
						runsDelta: 30,
						errorsDelta: 15,
						itemsOkDelta: 75,
					},
				] ),
			},
			evtemplate: {
				key: 'evtemplate',
				handler: 'evtemplate',
				windowed: {
					runs: 40,
					errors: 0,
					avgDurationMs: 55,
					itemsOk: 40,
					itemsErr: 0,
				},
				latest: {
					runs: 9,
					errors: 0,
					avgDurationMs: 50,
					avgQueueMs: 10,
					itemsOk: 9,
					itemsErr: 0,
					lastTs: Math.floor( Date.now() / 1000 ) - 5,
					lastDurationMs: 45,
					lastStatus: 'success',
					lastMessage: 'Job completed successfully',
				},
				buckets: bucketsFrom( [
					{
						ts: 1,
						elapsed: 15,
						runsDelta: 45,
						errorsDelta: 0,
						itemsOkDelta: 45,
					},
				] ),
			},
			slowjob: {
				key: 'slowjob',
				handler: 'slowjob',
				windowed: {
					runs: 6,
					errors: 0,
					// A zero mean prints, unlike a null one.
					avgDurationMs: 0,
					itemsOk: 6,
					itemsErr: 0,
				},
				latest: {
					runs: 1,
					errors: 0,
					avgQueueMs: 0,
					itemsOk: 1,
					itemsErr: 0,
					lastTs: 0, // never-run sentinel → "-"
					lastDurationMs: 1500, // ≥1s → seconds branch
					lastStatus: 'success',
					lastMessage: 'Job completed successfully',
				},
				buckets: bucketsFrom( [
					{
						ts: 1,
						elapsed: 15,
						runsDelta: 15,
						errorsDelta: 0,
						itemsOkDelta: 15,
					},
				] ),
			},
		},
	};
}

beforeEach( () => {
	Core.reset();
	seed( null );
	localizeStationPages();
} );

describe( 'the Jobs tab', () => {
	it( 'replays both probe logs from their start', () => {
		for ( const [ name, log ] of [
			[ 'nodes/jobstats', 'jobstats.p0' ],
			[ 'nodes/topicprobe', 'topicprobe.p0' ],
		] ) {
			const decl = sourceDeclaration( name );
			expect( [ decl.mode, decl.subscribe( {} ) ] ).toEqual( [
				'history',
				log,
			] );
		}
	} );

	it( 'shows the lines each of its streams skipped as its own named notice', () => {
		publishSkippedLines( 'jobstats.p0', 2 );
		publishSkippedLines( 'topicprobe.p0', 3 );
		const { container } = render( <JobsTab /> );
		const notices = [
			...container.querySelectorAll(
				'.newspack-nodes-banner.is-warning'
			),
		].map( ( n ) => n.textContent );
		expect( notices ).toEqual( [
			'Job statistics: 2 lines would not parse and were skipped.',
			'Job backlog: 3 lines would not parse and were skipped.',
		] );
	} );

	it( 'renders backlog + queue-latency panels; backlog holds jobs sources only', () => {
		seed( model(), {
			consumers: {
				'job-worker.jobs.p0': {
					source: 'jobs.p0',
					buckets: bucketsFrom( [ { ts: 1, backlog: 4096 } ] ),
				},
				'combined.firehose.p0': {
					source: 'firehose.p0',
					buckets: bucketsFrom( [ { ts: 1, backlog: 9999 } ] ),
				},
			},
		} );
		render( <JobsTab /> );

		const titles = panels().map( ( p ) => p.title );
		expect( titles ).toContain( 'Job Backlog' );
		expect( titles ).toContain( 'Job Queue Latency' );

		const backlog = panels().find( ( p ) => 'Job Backlog' === p.title );
		expect( Object.keys( backlog.series ) ).toContain( 'jobs.p0' );
		expect( Object.keys( backlog.series ) ).not.toContain( 'firehose.p0' );
	} );

	it( 'charts each worker’s jobs backlog apart, as the Overview does', () => {
		seed( model(), {
			consumers: {
				'job-worker.jobs.p2': {
					source: 'jobs.p2',
					buckets: bucketsFrom( [
						{
							ts: 1,
							backlog: 4471,
							worker: 'job-worker-4417.p2',
						},
					] ),
				},
			},
		} );
		render( <JobsTab /> );
		const backlog = panels().find( ( p ) => 'Job Backlog' === p.title );
		expect( Object.keys( backlog.series ) ).toEqual( [
			'jobs.p2 · job-worker-4417.p2',
		] );
	} );

	it( 'renders a row per job identity with runs, failures, status and message', () => {
		seed( model() );
		const { getByText, getAllByText } = render( <JobsTab /> );

		expect(
			getByText( 'cron:films', { selector: '.nodes-probe-tab__name' } )
		).toBeTruthy();
		expect(
			getByText( 'evtemplate', { selector: '.nodes-probe-tab__name' } )
		).toBeTruthy();
		// The failing cron job's run/failure counts + message surface.
		expect(
			getByText( 'Job failed: 3 error(s), no items processed' )
		).toBeTruthy();
		// Both status badges render.
		expect( getByText( 'error' ) ).toBeTruthy();
		expect( getAllByText( 'success' ).length ).toBeGreaterThanOrEqual( 1 );
		// Sub-second durations show ms; ≥1s shows seconds; a never-run job shows "-".
		expect( getByText( '1.50s' ) ).toBeTruthy();
		expect( getAllByText( '-' ).length ).toBeGreaterThanOrEqual( 1 );
	} );

	it( 'renders WINDOWED runs/failures totals, not the latest cumulative record', () => {
		seed( model() );
		const { getByText, container } = render( <JobsTab /> );
		// cron:films: windowed runs = 12 (latest cumulative is 4).
		expect( getByText( '12' ) ).toBeTruthy();
		// cron:films: windowed failures = 5 (latest cumulative is 1).
		const failing = container.querySelector(
			'.nodes-probe-tab__count.is-nonzero'
		);
		expect( failing.textContent ).toBe( '5' );
	} );

	it( 'uses the canonical themed table class, not wp-list-table', () => {
		seed( model() );
		const { container } = render( <JobsTab /> );
		const table = container.querySelector( 'table' );
		expect( table.classList.contains( 'newspack-nodes-table' ) ).toBe(
			true
		);
		expect( table.classList.contains( 'wp-list-table' ) ).toBe( false );
	} );

	it( 'shows an empty state before any job has run', () => {
		seed( { handlers: {} } );
		const { container, queryByRole } = render( <JobsTab /> );
		expect( queryByRole( 'table' ) ).toBeNull();
		expect(
			container.querySelector( '.nodes-probe-tab__empty' )
		).toBeTruthy();
	} );

	it( 'shows the empty state while its log has answered nothing', () => {
		seed( null );
		const { container } = render( <JobsTab /> );
		expect(
			container.querySelector( '.nodes-probe-tab__empty' ).textContent
		).toBe( 'No job activity yet.' );
	} );

	it( 'feeds runs, errors, backlog and latency panels to TimeChart', () => {
		seed( model() );
		render( <JobsTab /> );
		const titles = panels().map( ( p ) => p.title );
		expect( titles.length ).toBe( 4 );
		expect( titles.some( ( t ) => /run/i.test( t ) ) ).toBe( true );
		expect( titles.some( ( t ) => /error/i.test( t ) ) ).toBe( true );
		expect( titles.some( ( t ) => /backlog/i.test( t ) ) ).toBe( true );
		expect( titles.some( ( t ) => /latency/i.test( t ) ) ).toBe( true );
	} );

	it( 'charts each job identity on each worker as its own stacked series, one point per bucket', () => {
		const m = model();
		m.handlers[ 'cron:films' ].buckets = bucketsFrom( [
			{
				ts: 100,
				elapsed: 15,
				runsDelta: 30,
				errorsDelta: 15,
				queueDelta: 1200,
				worker: 'job-worker-4417.p2',
			},
			{
				ts: 107,
				elapsed: 15,
				runsDelta: 75,
				errorsDelta: 0,
				queueDelta: 6000,
				worker: 'job-worker-4417.p6',
			},
		] );
		seed( m );
		render( <JobsTab /> );
		const [ runs, errors, backlog, latency ] = panels();
		for ( const panel of [ runs, errors ] ) {
			expect( panel.stacked ).toBe( true );
			expect( Object.keys( panel.series ) ).toEqual(
				expect.arrayContaining( [
					'cron:films · job-worker-4417.p2',
					'cron:films · job-worker-4417.p6',
				] )
			);
			expect( panel.series ).not.toHaveProperty( 'cron' );
		}
		expect(
			runs.series[ 'cron:films · job-worker-4417.p6' ].points.map(
				( p ) => p.value
			)
		).toEqual( [ 5 ] );
		// A mean over two workers' buckets is one point per identity per bucket.
		expect( latency.stacked ).toBeFalsy();
		expect( Object.keys( latency.series ) ).toContain( 'cron:films' );
		expect(
			latency.series[ 'cron:films' ].points.map( ( p ) => p.value )
		).toEqual( [ ( 1200 + 6000 ) / ( 30 + 75 ) ] );
		expect( latency ).not.toHaveProperty( 'stackable' );
		expect( latency.series[ 'cron:films' ].mode.agg ).toBe( 'mean' );
		// A duration axis picks one unit from the panel's peak.
		expect( latency.formatFor ).toBe( axisDuration );
		expect( latency ).not.toHaveProperty( 'formatValue' );
		// Each jobs.pN backlog is its own debt, so the column sums them.
		expect( backlog.stacked ).toBe( true );
		// Each series says how it charts; the panel does not name a metric.
		for ( const panel of [ runs, errors, backlog, latency ] ) {
			expect( panel ).not.toHaveProperty( 'metric' );
			expect( panel ).not.toHaveProperty( 'totalLabel' );
		}
	} );

	it( 'titles each panel Y-axis with the quantity it plots', () => {
		seed( model() );
		render( <JobsTab /> );
		expect( panels().map( ( p ) => p.yLabel ) ).toEqual( [
			'Runs',
			'Errors',
			'Backlog',
			'Latency',
		] );
	} );

	it( 'sorts the most failing identity first, by failures then by name', () => {
		const row = ( key, errors ) => ( {
			key,
			handler: key,
			windowed: { runs: 9, errors, avgDurationMs: 12, avgQueueMs: 3 },
			latest: {
				lastTs: 0,
				lastDurationMs: 12,
				lastStatus: 'success',
				lastMessage: '',
			},
			buckets: [],
		} );
		seed( {
			handlers: {
				'alpha:low': row( 'alpha:low', 0 ),
				'mid:two': row( 'mid:two', 2 ),
				'zulu:worst': row( 'zulu:worst', 7 ),
			},
		} );
		const { container } = render( <JobsTab /> );
		expect(
			[ ...container.querySelectorAll( 'tbody tr' ) ].map(
				( r ) => r.dataset.jobKey
			)
		).toEqual( [ 'zulu:worst', 'mid:two', 'alpha:low' ] );
	} );

	it( 'shows the window’s longest run in a Max column after Avg', () => {
		const m = model();
		m.handlers[ 'cron:films' ].windowed.maxDurationMs = 4870;
		seed( m );
		const { container } = render( <JobsTab /> );
		const heads = [ ...container.querySelectorAll( 'th' ) ].map(
			( h ) => h.textContent
		);
		expect( heads.slice( 3, 6 ) ).toEqual( [ 'Avg', 'Max', 'Last' ] );
		const cells = [
			...container.querySelector( '[data-job-key="cron:films"]' )
				.children,
		].map( ( c ) => c.textContent );
		expect( cells[ 4 ] ).toBe( '4.87s' );
	} );

	it( 'reads a mean or max with no runs behind it as -', () => {
		const m = model();
		Object.assign( m.handlers.evtemplate.windowed, {
			runs: 0,
			avgDurationMs: null,
			maxDurationMs: null,
			avgQueueMs: null,
		} );
		seed( m );
		const { container } = render( <JobsTab /> );
		const cells = [
			...container.querySelector( '[data-job-key="evtemplate"]' )
				.children,
		].map( ( c ) => c.textContent );
		// Avg (3), Max (4) and Queued (6).
		expect( [ cells[ 3 ], cells[ 4 ], cells[ 6 ] ] ).toEqual( [
			'-',
			'-',
			'-',
		] );
	} );

	it( 'prints counts whole, grouped by locale', () => {
		const m = model();
		Object.assign( m.handlers[ 'cron:films' ].windowed, {
			runs: 12345,
			errors: 4321,
		} );
		seed( m );
		const { container } = render( <JobsTab /> );
		const cells = [
			...container.querySelector( '[data-job-key="cron:films"]' )
				.children,
		].map( ( c ) => c.textContent );
		expect( cells.slice( 1, 3 ) ).toEqual( [ '12,345', '4,321' ] );
	} );
} );
