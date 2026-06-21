import { formatCount } from '../formatters';

it( 'leaves small counts whole', () => {
	expect( formatCount( 0 ) ).toBe( '0' );
	expect( formatCount( 60 ) ).toBe( '60' );
	expect( formatCount( 999 ) ).toBe( '999' );
} );

it( 'compacts thousands / millions / billions', () => {
	expect( formatCount( 1500 ) ).toBe( '1.5K' );
	expect( formatCount( 2_000_000 ) ).toBe( '2M' );
	expect( formatCount( 3_400_000_000 ) ).toBe( '3.4B' );
} );

it( 'drops a trailing .0', () => {
	expect( formatCount( 2000 ) ).toBe( '2K' );
} );

it( 'promotes to the next unit when rounding hits 1000 (no "1000K")', () => {
	expect( formatCount( 999999 ) ).toBe( '1M' );
	expect( formatCount( 999950 ) ).toBe( '1M' );
	expect( formatCount( 999500 ) ).toBe( '999.5K' ); // rounds to 999.5, no promote
} );

it( 'guards non-finite / negative input', () => {
	expect( formatCount( undefined ) ).toBe( '0' );
	expect( formatCount( -5 ) ).toBe( '0' );
} );
