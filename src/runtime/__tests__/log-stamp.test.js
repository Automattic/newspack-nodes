/**
 * splitStamp — the one JS reader of the reader stamp a FROM trail opens with,
 * held to PHP `Log_Discovery::dir_from_stamp()` by one case list.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { splitStamp } from '../log-stamp';

describe( 'splitStamp parity with Log_Discovery::dir_from_stamp()', () => {
	const cases = JSON.parse(
		readFileSync(
			join( __dirname, '../../../tests/fixtures/log-stamps.json' ),
			'utf8'
		)
	);

	it.each( cases )( '%s', ( _label, from, dir ) => {
		expect( splitStamp( from ).dir ).toBe( dir );
	} );
} );

describe( 'splitStamp', () => {
	it( 'hands back the segments after the stamp', () => {
		expect(
			splitStamp( 'offsets/kea-7713.p3/job-worker.p2/jobstats' ).rest
		).toEqual( [ 'job-worker.p2', 'jobstats' ] );
		expect( splitStamp( 'jobstats.p0/jobstats' ).rest ).toEqual( [
			'jobstats',
		] );
		expect( splitStamp( 'jobstats.p0' ).rest ).toEqual( [] );
	} );

	it( 'reads a sources stamp as one stamp', () => {
		expect( splitStamp( 'sources/php/php-errors:tail' ) ).toEqual( {
			dir: 'sources/php',
			rest: [ 'php-errors:tail' ],
		} );
	} );

	it( 'tolerates a null or undefined FROM', () => {
		expect( splitStamp( null ) ).toEqual( { dir: '', rest: [] } );
		expect( splitStamp( undefined ) ).toEqual( { dir: '', rest: [] } );
	} );
} );
