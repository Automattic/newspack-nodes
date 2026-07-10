import {
	formatBytes,
	formatByteRate,
	formatMsgRate,
	formatAge,
	formatEta,
	etaSeconds,
} from '../formatters';

describe( 'formatters', () => {
	it( 'formatBytes', () => {
		expect( formatBytes( 0 ) ).toBe( '0 B' );
		expect( formatBytes( 1536 ) ).toBe( '1.5 KB' );
		// >= 10 in-unit drops the decimal (46.875 KB → "47 KB").
		expect( formatBytes( 48000 ) ).toBe( '47 KB' );
	} );
	it( 'formatByteRate', () => {
		expect( formatByteRate( 0 ) ).toBe( '0 B/s' );
		expect( formatByteRate( 2048 ) ).toBe( '2 KB/s' );
		// Sub-1 B/s must not underflow the unit index into `undefined` → NaN.
		expect( formatByteRate( 0.5 ) ).toBe( '0.5 B/s' );
		// >= 10 in-unit drops the decimal (46.4 KB/s → "46 KB/s").
		expect( formatByteRate( 47514 ) ).toBe( '46 KB/s' );
	} );
	it( 'formatMsgRate', () => {
		expect( formatMsgRate( 0 ) ).toBe( '0/s' );
		expect( formatMsgRate( 2996 ) ).toBe( '3K/s' );
		// Fractional per-second rates must not produce "NaN/s" (neg unit idx).
		expect( formatMsgRate( 0.4 ) ).toBe( '0.4/s' );
		expect( formatMsgRate( 2.5 ) ).toBe( '2.5/s' );
		// >= 10 in-unit drops the decimal (15.4K/s → "15K/s").
		expect( formatMsgRate( 15400 ) ).toBe( '15K/s' );
		// >= 10 plain per-second too (46.4/s → "46/s").
		expect( formatMsgRate( 46.4 ) ).toBe( '46/s' );
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
		// Not behind → 0; stalled → Infinity; else ceil(behind/rate).
		expect( etaSeconds( 0, 10 ) ).toBe( 0 );
		expect( etaSeconds( -5, 10 ) ).toBe( 0 );
		expect( etaSeconds( 100, 0 ) ).toBe( Infinity );
		expect( etaSeconds( 50, 10 ) ).toBe( 5 );
		expect( etaSeconds( 1200, 10 ) ).toBe( 120 );
		// formatEta is the formatted view of the same seconds.
		expect( formatEta( 50, 10 ) ).toBe( '5s' );
	} );
} );
