import {
	formatBytes,
	formatByteRate,
	formatAge,
	formatEta,
	etaSeconds,
} from '../formatters';

describe( 'formatters', () => {
	it( 'formatBytes', () => {
		expect( formatBytes( 0 ) ).toBe( '0 B' );
		expect( formatBytes( 1536 ) ).toBe( '1.5 KB' );
	} );
	it( 'formatByteRate', () => {
		expect( formatByteRate( 0 ) ).toBe( '0 B/s' );
		expect( formatByteRate( 2048 ) ).toBe( '2 KB/s' );
	} );
	it( 'formatAge', () => {
		expect( formatAge( 0, 100 ) ).toBe( '-' );
		expect( formatAge( 100, 130 ) ).toBe( '30s' );
		expect( formatAge( 100, 100 + 120 ) ).toBe( '2m' );
		expect( formatAge( 100, 100 + 3660 ) ).toBe( '1h1m' );
	} );
	it( 'formatEta', () => {
		expect( formatEta( 0, 10 ) ).toBe( '' );
		expect( formatEta( 100, 0 ) ).toBe( 'stalled' );
		expect( formatEta( 50, 10 ) ).toBe( '5s' );
		expect( formatEta( 1200, 10 ) ).toBe( '2m' );
		expect( formatEta( 7200, 1 ) ).toBe( '2h0m' );
	} );
	it( 'etaSeconds', () => {
		// Not behind → 0; stalled (rate<=0 with lag) → Infinity; else ceil(behind/rate).
		expect( etaSeconds( 0, 10 ) ).toBe( 0 );
		expect( etaSeconds( -5, 10 ) ).toBe( 0 );
		expect( etaSeconds( 100, 0 ) ).toBe( Infinity );
		expect( etaSeconds( 50, 10 ) ).toBe( 5 );
		expect( etaSeconds( 1200, 10 ) ).toBe( 120 );
		// formatEta is the formatted view of the same seconds.
		expect( formatEta( 50, 10 ) ).toBe( '5s' );
	} );
} );
