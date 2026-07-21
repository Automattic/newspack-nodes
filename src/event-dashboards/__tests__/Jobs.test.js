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
				handler: 'cron',
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
				handler: 'evtemplate',
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
				handler: 'slowjob',
				latest: {
					runs: 1,
					errors: 0,
					// Exercises formatMs's zero + seconds branches.
					avgDurationMs: 0,
					avgQueueMs: 0,
					itemsOk: 1,
					itemsErr: 0,
					lastTs: 0, // never-run sentinel → "-"
					lastDurationMs: 1500,
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

	it( 'feeds a Runs-rate and an Errors-rate panel to TopicsChart', () => {
		useNodeState.mockReturnValue( model() );
		render( <Jobs /> );
		const titles = globalThis.__jobsPanels.map( ( p ) => p.title );
		expect( titles.length ).toBe( 2 );
		expect( titles.some( ( t ) => /run/i.test( t ) ) ).toBe( true );
		expect( titles.some( ( t ) => /error/i.test( t ) ) ).toBe( true );
	} );
} );
