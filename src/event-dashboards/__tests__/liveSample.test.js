import { isLiveSample, streamHead } from '../liveSample';

const HEAD = 1786540928;

describe( 'isLiveSample', () => {
	it( 'holds a sample live for one minute behind the stream head', () => {
		expect( isLiveSample( { ts: HEAD - 30 }, HEAD ) ).toBe( true );
		expect( isLiveSample( { ts: HEAD - 60 }, HEAD ) ).toBe( true );
		expect( isLiveSample( { ts: HEAD - 61 }, HEAD ) ).toBe( false );
	} );

	it( 'never counts a sample that carries no timestamp', () => {
		expect( isLiveSample( {}, HEAD ) ).toBe( false );
		expect( isLiveSample( undefined, HEAD ) ).toBe( false );
		expect( isLiveSample( { ts: '1786540928' }, HEAD ) ).toBe( false );
	} );
} );

describe( 'streamHead', () => {
	it( "is the newest reader's latest timestamp", () => {
		expect(
			streamHead( {
				a: { latest: { ts: HEAD - 7200 } },
				b: { latest: { ts: HEAD } },
				c: { latest: { ts: HEAD - 15 } },
			} )
		).toBe( HEAD );
	} );

	it( 'skips a reader with no numeric timestamp', () => {
		expect(
			streamHead( {
				a: { latest: { ts: HEAD - 9 } },
				b: { latest: { ts: '9999999999' } },
				c: { latest: { ts: NaN } },
				d: {},
			} )
		).toBe( HEAD - 9 );
	} );

	it( 'is -Infinity for a map with no dated sample', () => {
		expect( streamHead( {} ) ).toBe( -Infinity );
		expect( streamHead( null ) ).toBe( -Infinity );
	} );
} );
