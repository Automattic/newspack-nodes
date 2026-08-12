/**
 * The default-export entry: the same scaler `./formatters` exports by name,
 * reached through the import path the event-logger plugin still uses.
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

it( 'renders KB and MB in the compact convention', () => {
	expect( formatBytes( 2048 ) ).toBe( '2 KB' );
	expect( formatBytes( 881_869 ) ).toBe( '861 KB' );
	expect( formatBytes( 3 * 1024 * 1024 ) ).toBe( '3 MB' );
} );

it( 'carries the GB and TB tiers', () => {
	expect( formatBytes( 4.5 * 1024 * 1024 * 1024 ) ).toBe( '4.5 GB' );
	expect( formatBytes( 2 ** 40 ) ).toBe( '1 TB' );
} );
