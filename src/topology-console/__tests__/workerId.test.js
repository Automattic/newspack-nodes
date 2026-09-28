/**
 * workerId — the one spelling of a worker's `{topology}.p{N}` id in the
 * console, and parseWorkerId the one reading of it.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
	parseWorkerId,
	scopeFromCwd,
	workerId,
	workerOfPath,
} from '../utils/scope';

describe( 'workerId', () => {
	it( 'round-trips through scopeFromCwd', () => {
		const scope = scopeFromCwd( workerId( 'kea-7713', 3 ) );
		expect( scope ).toEqual( {
			key: 'kea-7713.p3',
			label: 'kea-7713',
			partition: 3,
			isWorker: true,
		} );
	} );
} );

/**
 * The case list PHP `CLI::parse_worker_id()` reads too, so the two grammars
 * cannot drift apart.
 */
describe( 'parseWorkerId parity with CLI::parse_worker_id()', () => {
	const cases = JSON.parse(
		readFileSync(
			join( __dirname, '../../../tests/fixtures/worker-ids.json' ),
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

describe( 'workerOfPath', () => {
	it( 'reads the worker a path is mounted on off its first segment', () => {
		expect( workerOfPath( 'foo.bar.p41/summarizer/in' ) ).toEqual( {
			topology: 'foo.bar',
			partition: 41,
		} );
		expect( workerOfPath( 'kea-7713.p3' ) ).toEqual( {
			topology: 'kea-7713',
			partition: 3,
		} );
	} );

	it( 'answers null when the first segment names no worker', () => {
		expect( workerOfPath( '_http/kea-7713.p3' ) ).toBeNull();
		expect( workerOfPath( 'kea-7713.p03/summarizer' ) ).toBeNull();
		expect( workerOfPath( '' ) ).toBeNull();
		expect( workerOfPath( null ) ).toBeNull();
	} );
} );

describe( 'scopeFromCwd through parseWorkerId', () => {
	it( 'reads a dotted topology under a node path', () => {
		expect( scopeFromCwd( 'foo.bar.p41/summarizer' ) ).toEqual( {
			key: 'foo.bar.p41',
			label: 'foo.bar',
			partition: 41,
			isWorker: true,
		} );
	} );

	it( 'keys a padded cwd as itself, never as the worker it resembles', () => {
		expect( scopeFromCwd( 'kea-7713.p03' ) ).toEqual( {
			key: 'kea-7713.p03',
			label: 'kea-7713.p03',
			partition: null,
			isWorker: false,
		} );
	} );
} );
