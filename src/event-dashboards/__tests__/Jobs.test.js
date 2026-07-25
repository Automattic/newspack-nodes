/* global globalThis */
/**
 * Jobs — the hub's per-handler job-outcome board over the durable jobstats.p0 log.
 * useJobstatsStream (link) is stubbed; the view model is fed via useNodeState.
 * TopicsChart (d3) is stubbed to capture the rate panels each metric is fed.
 */

import { render } from '@testing-library/react';
import Jobs from '../Jobs';

jest.mock( '../hooks/useJobstatsStream', () => ( {
	useJobstatsStream: jest.fn(),
} ) );
jest.mock( '../hooks/useTopicProbeStream', () => ( {
	useTopicProbeStream: jest.fn(),
} ) );
jest.mock( '../../runtime/react', () => ( {
	...jest.requireActual( '../../runtime/react' ),
	useNodeState: jest.fn(),
} ) );
jest.mock( '../TopicsChart', () => {
	const el = require( '@wordpress/element' );
	return {
		TopicsChart: ( props ) => {
			( globalThis.__jobsPanels ||= [] ).push( props );
			return el.createElement(
				'div',
				{ className: 'nodes-topics' },
				props.title
			);
		},
	};
} );

import { useNodeState } from '../../runtime/react';

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
					// Exercises formatMs's zero branch on the Avg column.
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
	globalThis.__jobsPanels = [];
} );

describe( 'Jobs', () => {
	it( 'renders backlog + queue-latency panels; backlog holds jobs sources only', () => {
		useNodeState.mockImplementation( ( node ) =>
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

	it( 'renders a row per job identity with runs, failures, status and message', () => {
		useNodeState.mockReturnValue( model() );
		const { getByText, getAllByText } = render( <Jobs /> );

		expect( getByText( 'cron:films' ) ).toBeTruthy();
		expect(
			getByText( 'evtemplate', { selector: '.nodes-jobs__handler' } )
		).toBeTruthy();
		// The failing cron job's run/failure counts + message surface.
		expect(
			getByText( 'Job failed: 3 error(s), no items processed' )
		).toBeTruthy();
		// Both status badges render.
		expect( getByText( 'error' ) ).toBeTruthy();
		expect( getAllByText( 'success' ).length ).toBeGreaterThanOrEqual( 1 );
		// Sub-second durations show ms; ≥1s shows seconds; a never-run job shows "-".
		expect( getByText( '1.5s' ) ).toBeTruthy();
		expect( getAllByText( '-' ).length ).toBeGreaterThanOrEqual( 1 );
	} );

	it( 'renders WINDOWED runs/failures totals, not the latest cumulative record', () => {
		useNodeState.mockReturnValue( model() );
		const { getByText, container } = render( <Jobs /> );
		// cron:films: windowed runs = 12 (latest cumulative is 4).
		expect( getByText( '12' ) ).toBeTruthy();
		// cron:films: windowed failures = 5 (latest cumulative is 1).
		const failing = container.querySelector(
			'.nodes-jobs__failures.is-nonzero'
		);
		expect( failing.textContent ).toBe( '5' );
	} );

	it( 'uses the canonical themed table class, not wp-list-table', () => {
		useNodeState.mockReturnValue( model() );
		const { container } = render( <Jobs /> );
		const table = container.querySelector( 'table' );
		expect( table.classList.contains( 'newspack-nodes-table' ) ).toBe(
			true
		);
		expect( table.classList.contains( 'wp-list-table' ) ).toBe( false );
	} );

	it( 'shows an empty state when no jobs have run', () => {
		useNodeState.mockReturnValue( { handlers: {} } );
		const { container, queryByRole } = render( <Jobs /> );
		expect( queryByRole( 'table' ) ).toBeNull();
		expect( container.querySelector( '.nodes-jobs__empty' ) ).toBeTruthy();
	} );

	it( 'tolerates an unready view model (no crash, empty state)', () => {
		useNodeState.mockReturnValue( undefined );
		const { container } = render( <Jobs /> );
		expect( container.querySelector( '.nodes-jobs__empty' ) ).toBeTruthy();
	} );

	it( 'feeds runs, errors, backlog and latency panels to TopicsChart', () => {
		useNodeState.mockReturnValue( model() );
		render( <Jobs /> );
		const titles = globalThis.__jobsPanels.map( ( p ) => p.title );
		expect( titles.length ).toBe( 4 );
		expect( titles.some( ( t ) => /run/i.test( t ) ) ).toBe( true );
		expect( titles.some( ( t ) => /error/i.test( t ) ) ).toBe( true );
		expect( titles.some( ( t ) => /backlog/i.test( t ) ) ).toBe( true );
		expect( titles.some( ( t ) => /latency/i.test( t ) ) ).toBe( true );
	} );
} );
