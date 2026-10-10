/**
 * splitStamp — the one JS reader of the reader stamp a FROM trail opens with,
 * held to PHP `Log_Discovery::dir_from_stamp()` by one case list.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { anyCarries, isGlob, remoteOf, splitStamp } from '../log-stamp';

describe( 'isGlob, as Log_Discovery::is_glob()', () => {
	test( 'a star anywhere in a subscription makes it a glob', () => {
		expect( isGlob( 'jobstats.p*' ) ).toBe( true );
		expect( isGlob( 'offsets/fire*.p3' ) ).toBe( true );
		expect( isGlob( 'firehose.p0' ) ).toBe( false );
		expect( isGlob( 'sources/php' ) ).toBe( false );
	} );
} );

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

describe( 'remoteOf parity with Log_Discovery::remote_of()', () => {
	const cases = JSON.parse(
		readFileSync(
			join( __dirname, '../../../tests/fixtures/log-remotes.json' ),
			'utf8'
		)
	);

	it.each( cases )( '%s', ( _label, vaultId, _stamp, name, kind ) => {
		expect( remoteOf( name ) ).toEqual( { vaultId, kind } );
	} );

	it.each( [
		'firehose.p0',
		'sources/php',
		'remote',
		'remote/',
		'remote/austin-9',
		'remote/:firehose.p0',
		'remote/austin-9:',
		'remote/austin-9:firehose.p0/hub.p2',
		null,
	] )( 'reads no remote log in %p', ( name ) => {
		expect( remoteOf( name ) ).toBeNull();
	} );
} );

describe( 'carries parity with Log_Discovery::carries()', () => {
	const cases = JSON.parse(
		readFileSync(
			join(
				__dirname,
				'../../../tests/fixtures/subscription-carries.json'
			),
			'utf8'
		)
	);

	it.each( cases )( '%s', ( _label, sub, stamp, expected ) => {
		expect( anyCarries( [ sub ], stamp ) ).toBe( expected );
	} );
} );

describe( 'carries', () => {
	it( 'compiles a glob once, however often it is asked', () => {
		const compile = jest.spyOn( global, 'RegExp' );
		try {
			expect( anyCarries( [ 'wren-4417.*' ], 'wren-4417.p2' ) ).toBe(
				true
			);
			expect( anyCarries( [ 'wren-4417.*' ], 'wren-4417.p9' ) ).toBe(
				true
			);
			expect( compile ).toHaveBeenCalledTimes( 1 );
		} finally {
			compile.mockRestore();
		}
	} );
} );
