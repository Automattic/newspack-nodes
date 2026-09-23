/**
 * statusLines — the browser console's `status` builtin summary (the JS analogue
 * of the PHP cli's `$shell->status_lines`): SSE session + cwd + attached worker.
 */

import { statusLines } from '../TopologyConsole';

describe( 'statusLines', () => {
	it( 'no SSE session → a single not-connected line', () => {
		expect(
			statusLines( { sseSession: null, cwd: '', worker: null } )
		).toEqual( [ 'Browser console — no SSE session (not connected).' ] );
	} );

	it( 'connected at the local graph root → session + root cwd + no attached worker', () => {
		expect(
			statusLines( {
				sseSession: '5e55104cafe0f00d5e55104cafe0f00d',
				cwd: '',
				worker: null,
			} )
		).toEqual( [
			'Browser console — SSE session 5e55104cafe0f00d5e55104cafe0f00d',
			'  cwd: /',
			'  no attached worker (local graph).',
		] );
	} );

	it( 'cd into a worker → attached worker line with topology.pN', () => {
		expect(
			statusLines( {
				sseSession: '5e55104cafe0f00d5e55104cafe0f00d',
				cwd: 'firehose-workers-and-jobs.p0',
				worker: {
					topology: 'firehose-workers-and-jobs',
					partition: 0,
				},
			} )
		).toEqual( [
			'Browser console — SSE session 5e55104cafe0f00d5e55104cafe0f00d',
			'  cwd: firehose-workers-and-jobs.p0',
			'  attached worker: firehose-workers-and-jobs.p0',
		] );
	} );
} );
