/**
 * Jobs — the station's per-handler job-outcome board over the durable jobstats.p0 log.
 * useProbeStream (link) is stubbed; the view model is fed via useNodeField.
 * TopicsChart (d3) is stubbed to capture the rate panels each metric is fed.
 */

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { render } from '@testing-library/react';
import { axisDuration } from '@newspack-nodes/shared/utils/axis-ticks';
import Jobs from '../Jobs';
import { useProbeStream } from '../hooks/useProbeStream';
import { Core } from '../../runtime/core';
import { publishSkippedLines } from '@newspack-nodes/shared/test-utils/skippedLines';

jest.mock( '../hooks/useProbeStream', () => ( {
	useProbeStream: jest.fn(),
} ) );
jest.mock( '../../runtime/react', () => ( {
	...jest.requireActual( '../../runtime/react' ),
	useNodeField: jest.fn(),
} ) );
jest.mock( '../TopicsChart', () => {
	const el = require( '@wordpress/element' );
	const TopicsChart = ( props ) => {
		( globalThis.__jobsPanels ||= [] ).push( props );
		return el.createElement(
			'div',
			{ className: 'nodes-topics' },
			props.title
		);
	};
	return {
		...jest.requireActual( '../TopicsChart' ),
		TopicsChart,
		TopicsPanels: ( { panels } ) =>
			panels.map( ( p ) =>
				el.createElement( TopicsChart, { key: p.title, ...p } )
			),
	};
} );

import { useNodeField } from '../../runtime/react';

function model() {
	return {
		handlers: {
			'cron:films': {
				key: 'cron:films',
				handler: 'cron',
				// Windowed totals differ from the newest cumulative record so a
				// table still reading `latest` (the bug) is caught.
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
				series: [ { ts: 1, runsRate: 2, errorsRate: 1, itemsRate: 5 } ],
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
				series: [ { ts: 1, runsRate: 3, errorsRate: 0, itemsRate: 3 } ],
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
				series: [ { ts: 1, runsRate: 1, errorsRate: 0, itemsRate: 1 } ],
			},
		},
	};
}

beforeEach( () => {
	Core.reset();
	globalThis.__jobsPanels = [];
} );

describe( 'Jobs', () => {
	it( 'replays both probe logs from their start', () => {
		render( <Jobs /> );
		expect( useProbeStream ).toHaveBeenCalledWith( 'jobstats', {
			mode: 'history',
		} );
		expect( useProbeStream ).toHaveBeenCalledWith( 'topicprobe', {
			mode: 'history',
		} );
	} );

	it( 'shows the lines each of its streams skipped as its own named notice', () => {
		publishSkippedLines( 'jobstats:link', 2 );
		publishSkippedLines( 'topicprobe:link', 3 );
		useNodeField.mockReturnValue( undefined );
		const { container } = render( <Jobs /> );
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
		useNodeField.mockImplementation( ( node ) =>
			'topicprobe:view' === node
				? {
						consumers: {
							'job-worker.jobs.p0': {
								source: 'jobs.p0',
								series: [ { ts: 1, backlog: 4096 } ],
							},
							'combined.firehose.p0': {
								source: 'firehose.p0',
								series: [ { ts: 1, backlog: 9999 } ],
							},
						},
				  }
				: model()
		);
		render( <Jobs /> );

		const titles = globalThis.__jobsPanels.map( ( p ) => p.title );
		expect( titles ).toContain( 'Job Backlog' );
		expect( titles ).toContain( 'Job Queue Latency' );

		const backlog = globalThis.__jobsPanels.find(
			( p ) => 'Job Backlog' === p.title
		);
		expect( Object.keys( backlog.series ) ).toContain( 'jobs.p0' );
		expect( Object.keys( backlog.series ) ).not.toContain( 'firehose.p0' );
	} );

	it( 'charts each worker’s jobs backlog apart, as the Overview does', () => {
		useNodeField.mockImplementation( ( node ) =>
			'topicprobe:view' === node
				? {
						consumers: {
							'job-worker.jobs.p2': {
								source: 'jobs.p2',
								series: [
									{
										ts: 1,
										backlog: 4471,
										worker: 'job-worker-4417.p2',
									},
								],
							},
						},
				  }
				: model()
		);
		render( <Jobs /> );
		const backlog = globalThis.__jobsPanels.find(
			( p ) => 'Job Backlog' === p.title
		);
		expect( Object.keys( backlog.series ) ).toEqual( [
			'jobs.p2 · job-worker-4417.p2',
		] );
	} );

	it( 'renders a row per job identity with runs, failures, status and message', () => {
		useNodeField.mockReturnValue( model() );
		const { getByText, getAllByText } = render( <Jobs /> );

		expect( getByText( 'cron:films' ) ).toBeTruthy();
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
		useNodeField.mockReturnValue( model() );
		const { getByText, container } = render( <Jobs /> );
		// cron:films: windowed runs = 12 (latest cumulative is 4).
		expect( getByText( '12' ) ).toBeTruthy();
		// cron:films: windowed failures = 5 (latest cumulative is 1).
		const failing = container.querySelector(
			'.nodes-probe-tab__count.is-nonzero'
		);
		expect( failing.textContent ).toBe( '5' );
	} );

	it( 'uses the canonical themed table class, not wp-list-table', () => {
		useNodeField.mockReturnValue( model() );
		const { container } = render( <Jobs /> );
		const table = container.querySelector( 'table' );
		expect( table.classList.contains( 'newspack-nodes-table' ) ).toBe(
			true
		);
		expect( table.classList.contains( 'wp-list-table' ) ).toBe( false );
	} );

	it( 'shows an empty state when no jobs have run', () => {
		useNodeField.mockReturnValue( { handlers: {} } );
		const { container, queryByRole } = render( <Jobs /> );
		expect( queryByRole( 'table' ) ).toBeNull();
		expect(
			container.querySelector( '.nodes-probe-tab__empty' )
		).toBeTruthy();
	} );

	it( 'tolerates an unready view model (no crash, empty state)', () => {
		useNodeField.mockReturnValue( undefined );
		const { container } = render( <Jobs /> );
		expect(
			container.querySelector( '.nodes-probe-tab__empty' )
		).toBeTruthy();
	} );

	it( 'feeds runs, errors, backlog and latency panels to TopicsChart', () => {
		useNodeField.mockReturnValue( model() );
		render( <Jobs /> );
		const titles = globalThis.__jobsPanels.map( ( p ) => p.title );
		expect( titles.length ).toBe( 4 );
		expect( titles.some( ( t ) => /run/i.test( t ) ) ).toBe( true );
		expect( titles.some( ( t ) => /error/i.test( t ) ) ).toBe( true );
		expect( titles.some( ( t ) => /backlog/i.test( t ) ) ).toBe( true );
		expect( titles.some( ( t ) => /latency/i.test( t ) ) ).toBe( true );
	} );

	it( 'charts each job identity on each worker as its own stacked series', () => {
		const m = model();
		m.handlers[ 'cron:films' ].series = [
			{
				ts: 100,
				runsRate: 3,
				errorsRate: 1,
				queueLatencyMs: 40,
				runsDelta: 2,
				worker: 'job-worker-4417.p2',
			},
			{
				ts: 107,
				runsRate: 5,
				errorsRate: 0,
				queueLatencyMs: 80,
				runsDelta: 6,
				worker: 'job-worker-4417.p6',
			},
		];
		useNodeField.mockReturnValue( m );
		render( <Jobs /> );
		const [ runs, errors, backlog, latency ] = globalThis.__jobsPanels;
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
		// A mean over two workers' samples is one series per identity.
		expect( latency.stacked ).toBeFalsy();
		expect( Object.keys( latency.series ) ).toContain( 'cron:films' );
		expect( latency.series[ 'cron:films' ].points ).toHaveLength( 2 );
		expect( latency.stackable ).toBe( false );
		// A duration axis picks one unit from the panel's peak.
		expect( latency.formatFor ).toBe( axisDuration );
		expect( latency ).not.toHaveProperty( 'formatValue' );
		// Each jobs.pN backlog is its own debt, so the column sums them.
		expect( backlog.stacked ).toBe( true );
		// Each series says how it charts; the panel names no metric.
		for ( const panel of [ runs, errors, backlog, latency ] ) {
			expect( panel ).not.toHaveProperty( 'metric' );
			expect( panel ).not.toHaveProperty( 'totalLabel' );
		}
	} );

	it( 'titles each panel Y-axis with the quantity it plots', () => {
		useNodeField.mockReturnValue( model() );
		render( <Jobs /> );
		expect( globalThis.__jobsPanels.map( ( p ) => p.yLabel ) ).toEqual( [
			'Runs',
			'Errors',
			'Backlog',
			'Latency',
		] );
	} );

	it( 'lays the panels in columns no drawn chart can widen', () => {
		// A chart SVG carries the width it measured, and a `1fr` track can
		// never be narrower than its content: the wider panel of a row would
		// pin its column, the other redraw to fit what was left, and every
		// poll ratchet the imbalance. `minmax(0, …)` takes content out of it.
		const source = readFileSync(
			resolvePath( __dirname, '../styles/probe-tab.scss' ),
			'utf8'
		);
		const panels = source.slice(
			source.indexOf( '.nodes-probe-tab__panels' )
		);
		expect( panels ).toMatch(
			/grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\);/
		);
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
			series: [],
		} );
		useNodeField.mockReturnValue( {
			handlers: {
				'alpha:low': row( 'alpha:low', 0 ),
				'mid:two': row( 'mid:two', 2 ),
				'zulu:worst': row( 'zulu:worst', 7 ),
			},
		} );
		const { container } = render( <Jobs /> );
		expect(
			[ ...container.querySelectorAll( 'tbody tr' ) ].map(
				( r ) => r.dataset.jobKey
			)
		).toEqual( [ 'zulu:worst', 'mid:two', 'alpha:low' ] );
	} );

	it( 'shows the window’s longest run in a Max column after Avg', () => {
		const m = model();
		m.handlers[ 'cron:films' ].windowed.maxDurationMs = 4870;
		useNodeField.mockReturnValue( m );
		const { container } = render( <Jobs /> );
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
		useNodeField.mockReturnValue( m );
		const { container } = render( <Jobs /> );
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
		useNodeField.mockReturnValue( m );
		const { container } = render( <Jobs /> );
		const cells = [
			...container.querySelector( '[data-job-key="cron:films"]' )
				.children,
		].map( ( c ) => c.textContent );
		expect( cells.slice( 1, 3 ) ).toEqual( [ '12,345', '4,321' ] );
	} );

	it( 'keeps its panel series stable across renders of an unready model', () => {
		useNodeField.mockReturnValue( undefined );
		const { rerender } = render( <Jobs /> );
		const first = globalThis.__jobsPanels.slice( 0, 4 );
		rerender( <Jobs /> );
		const second = globalThis.__jobsPanels.slice( -4 );
		second.forEach( ( panel, i ) =>
			expect( panel.series ).toBe( first[ i ].series )
		);
	} );
} );
