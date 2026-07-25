/**
 * formatBytes tests — the log-browser meta formatter: one decimal, B/KB/MB.
 */

import formatBytes from '../formatBytes';

it( 'renders zero and falsy sizes as 0 B', () => {
	expect( formatBytes( 0 ) ).toBe( '0 B' );
	expect( formatBytes( null ) ).toBe( '0 B' );
	expect( formatBytes( undefined ) ).toBe( '0 B' );
} );

it( 'renders sub-KB sizes as whole bytes', () => {
	expect( formatBytes( 512 ) ).toBe( '512 B' );
	expect( formatBytes( 1023 ) ).toBe( '1023 B' );
} );

it( 'renders KB and MB with one decimal place', () => {
	expect( formatBytes( 2048 ) ).toBe( '2.0 KB' );
	expect( formatBytes( 881_869 ) ).toBe( '861.2 KB' );
	expect( formatBytes( 3 * 1024 * 1024 ) ).toBe( '3.0 MB' );
} );

it( 'caps the unit at MB (no GB tier)', () => {
	expect( formatBytes( 4.5 * 1024 * 1024 * 1024 ) ).toBe( '4608.0 MB' );
} );
