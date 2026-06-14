import {
	formatBytes,
	formatByteRate,
	formatAge,
	formatEta,
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
	} );
	it( 'formatEta', () => {
		expect( formatEta( 0, 10 ) ).toBe( '' );
		expect( formatEta( 100, 0 ) ).toBe( 'stalled' );
		expect( formatEta( 50, 10 ) ).toBe( '5s' );
	} );
} );
