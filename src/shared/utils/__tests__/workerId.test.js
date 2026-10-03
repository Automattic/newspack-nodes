/**
 * workerId — the one JS spelling of a worker's `{topology}.p{N}` id, and
 * parseWorkerId the one JS reading of it, held to PHP `CLI::worker_id()` and
 * `CLI::parse_worker_id()` by one case list.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parseWorkerId, workerId, workerOfFrom } from '../workerId';

describe( 'parseWorkerId parity with CLI::parse_worker_id()', () => {
	const cases = JSON.parse(
		readFileSync(
			join( __dirname, '../../../../tests/fixtures/worker-ids.json' ),
			'utf8'
		)
	);

	const workers = cases.filter( ( [ , , expected ] ) => expected );

	it.each( cases )( '%s', ( _label, id, expected ) => {
		const worker = expected && {
			topology: expected[ 0 ],
			partition: expected[ 1 ],
		};
		expect( parseWorkerId( id ) ).toEqual( worker );
	} );

	it.each( workers )( '%s round-trips through workerId', ( _l, id, w ) => {
		expect( workerId( w[ 0 ], w[ 1 ] ) ).toBe( id );
	} );

	it( 'tolerates a null or undefined id', () => {
		expect( parseWorkerId( null ) ).toBeNull();
		expect( parseWorkerId( undefined ) ).toBeNull();
	} );
} );

describe( 'workerOfFrom', () => {
	it.each( [
		[
			'a worker behind a plain stamp',
			'jobstats.p0/job-worker.p2/jobstats',
			'job-worker.p2',
		],
		[
			'a worker behind a grouped stamp',
			'offsets/x.p0/job-worker.p2/jobstats',
			'job-worker.p2',
		],
		[ 'a bare probe behind a plain stamp', 'jobstats.p0/jobstats', '' ],
		[ 'a bare probe behind a grouped stamp', 'offsets/x.p0/jobstats', '' ],
		[ 'a padded partition', 'jobstats.p0/foo.p01/jobstats', '' ],
		[ 'a longer trail', 'jobstats.p0/a/b/c', '' ],
		[ 'a stamp alone', 'jobstats.p0', '' ],
		[ 'an empty FROM', '', '' ],
		[
			'a deadletter group',
			'deadletter/x.p0/tablestats.p7/tablestats',
			'tablestats.p7',
		],
	] )( '%s', ( _label, from, expected ) => {
		expect( workerOfFrom( from ) ).toBe( expected );
	} );

	it( 'tolerates a null FROM', () => {
		expect( workerOfFrom( null ) ).toBe( '' );
	} );
} );
