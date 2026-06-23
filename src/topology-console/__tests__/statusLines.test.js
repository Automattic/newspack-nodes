/**
 * statusLines — the browser console's `status` builtin summary (the JS analogue
 * of the PHP cli's `$shell->status_lines`): SSE session + cwd + worker pivot.
 */

import { statusLines } from '../TopologyConsole';

describe( 'statusLines', () => {
	it( 'no SSE session → a single not-connected line', () => {
		expect(
			statusLines( { ssePid: null, cwd: '', worker: null } )
		).toEqual( [ 'Browser console — no SSE session (not connected).' ] );
	} );

	it( 'connected at the local graph root → session + root cwd + no worker pivot', () => {
		expect(
			statusLines( { ssePid: '1247', cwd: '', worker: null } )
		).toEqual( [
			'Browser console — SSE session 1247',
			'  cwd: /',
			'  no worker pivot (local graph).',
		] );
	} );

	it( 'pivoted into a worker → worker pivot line with topology.pN', () => {
		expect(
			statusLines( {
				ssePid: '1247',
				cwd: 'firehose-workers-and-jobs.p0',
				worker: {
					topology: 'firehose-workers-and-jobs',
					partition: 0,
				},
			} )
		).toEqual( [
			'Browser console — SSE session 1247',
			'  cwd: firehose-workers-and-jobs.p0',
			'  worker pivot: firehose-workers-and-jobs.p0',
		] );
	} );
} );
