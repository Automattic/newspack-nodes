/**
 * The console's reads of a worker id: a scope round-trips through the shared
 * `workerId()`, and `workerOfPath()` reads a path's first segment.
 */

import { workerId } from '@newspack-nodes/shared/utils/workerId';
import { scopeFromCwd, workerOfPath } from '../utils/scope';

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
