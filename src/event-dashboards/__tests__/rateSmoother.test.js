import { RateSmoother } from '../rateSmoother';

describe( 'RateSmoother', () => {
	it( 'averages over the window then EMA-smooths (10s window, 0.1 alpha)', () => {
		const sm = new RateSmoother( 10, 0.1 );
		// 10 events in one second → window total 10 over 10s = rate 1/s; EMA from
		// 0 toward 1 by alpha → 0.1.
		expect( sm.add( 10, 0 ) ).toBeCloseTo( 0.1 );
		// Another 10 in the same second → total 20 → rate 2; EMA 0.1 + (2-0.1)*0.1.
		expect( sm.add( 10, 0 ) ).toBeCloseTo( 0.29 );
	} );

	it( 'aggregates same-second adds into one bucket', () => {
		const sm = new RateSmoother( 10, 0.1 );
		sm.add( 5, 200 );
		sm.add( 5, 900 );
		expect( sm.buckets ).toHaveLength( 1 );
		expect( sm.buckets[ 0 ].count ).toBe( 10 );
	} );

	it( 'expires buckets older than the window from the running total', () => {
		const sm = new RateSmoother( 10, 0.1 );
		sm.add( 100, 0 );
		// 11s later the sec-0 bucket falls out of the 10s window.
		sm.add( 0, 11000 );
		expect( sm.buckets.every( ( b ) => b.sec >= 1 ) ).toBe( true );
		expect( sm.windowTotal ).toBe( 0 );
	} );

	it( 'clamps negative counts (e.g. a counter reset) to zero', () => {
		const sm = new RateSmoother( 10, 0.1 );
		expect( sm.add( -50, 0 ) ).toBe( 0 );
		expect( sm.windowTotal ).toBe( 0 );
	} );

	it( 'reset clears the buckets, total, and smoothed value', () => {
		const sm = new RateSmoother( 10, 0.1 );
		sm.add( 10, 0 );
		sm.reset();
		expect( sm.buckets ).toEqual( [] );
		expect( sm.windowTotal ).toBe( 0 );
		expect( sm.smoothed ).toBe( 0 );
	} );
} );
