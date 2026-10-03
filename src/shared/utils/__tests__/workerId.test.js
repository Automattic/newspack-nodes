/**
 * workerId — the one JS spelling of a worker's `{topology}.p{N}` id, and
 * parseWorkerId the one JS reading of it, held to PHP `CLI::worker_id()` and
 * `CLI::parse_worker_id()` by one case list.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parseWorkerId, workerId } from '../workerId';

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
