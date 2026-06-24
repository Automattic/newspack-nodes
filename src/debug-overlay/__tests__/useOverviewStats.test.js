import { renderHook, act } from '@testing-library/react';
import { useOverviewStats } from '../useOverviewStats';
import { IoTelemetry, OVERVIEW_STORAGE_KEY } from '../../runtime/io-telemetry';

beforeEach( () => {
	IoTelemetry.reset();
	// The hook runs a 20Hz interval; fake timers keep it from firing (and
	// leaking) except where a test advances it explicitly. Pin the clock to 0 so
	// the rate's `Date.now()/1000` deltas stay exact (subtracting two real-epoch
	// seconds loses sub-ms precision).
	jest.useFakeTimers();
	jest.setSystemTime( 0 );
	try {
		window.localStorage.removeItem( OVERVIEW_STORAGE_KEY );
	} catch ( _e ) {
		// ignore
	}
} );

afterEach( () => {
	jest.useRealTimers();
} );

test( 'starts at zero totals, zero rates, and empty series', () => {
	const { result } = renderHook( () => useOverviewStats() );
	expect( result.current.totals.bytesIn ).toBe( 0 );
	expect( result.current.msgRateSeries.In.points ).toEqual( [] );
	expect( result.current.rates ).toEqual( {
		msgIn: 0,
		msgOut: 0,
		byteIn: 0,
		byteOut: 0,
	} );
} );

test( 'reflects telemetry totals + the 5s chart series after a sample', () => {
	const { result } = renderHook( () => useOverviewStats() );
	act( () => {
		IoTelemetry.recordIn( 100, 2 );
		IoTelemetry.recordOut( 40, 1 );
		IoTelemetry.sample( 0 ); // baseline, no emit
		IoTelemetry.recordIn( 100, 2 );
		IoTelemetry.recordOut( 40, 1 );
		IoTelemetry.sample( 5 ); // emit -> notify -> re-render
	} );
	expect( result.current.totals.bytesIn ).toBe( 200 );
	expect( result.current.totals.msgsIn ).toBe( 4 );
	expect( result.current.totals.bytesOut ).toBe( 80 );
	expect( result.current.msgRateSeries.In.points ).toHaveLength( 1 );
	expect( result.current.byteRateSeries.Out.points ).toHaveLength( 1 );
} );

test( 'feeds per-tick deltas into the shared RateSmoother (10s window + EMA)', () => {
	const { result } = renderHook( () => useOverviewStats() );
	act( () => {
		IoTelemetry.recordIn( 1000, 10 );
		jest.advanceTimersByTime( 50 ); // tick 1: baseline (prev=null)
		IoTelemetry.recordIn( 1000, 10 );
		jest.advanceTimersByTime( 50 ); // tick 2: delta 1000 B / 10 msgs
	} );
	// RateSmoother: 1000 B / 10s window = 100 B/s, EMA 0 + (100-0)*0.1 = 10.
	// msgs: 10 / 10 = 1, EMA 0.1. (Heavily smoothed — same as Raw Logs lps.)
	expect( result.current.rates.byteIn ).toBeCloseTo( 10 );
	expect( result.current.rates.msgIn ).toBeCloseTo( 0.1 );
} );

test( 'a telemetry reset drops the smoothed rate back to zero', () => {
	const { result } = renderHook( () => useOverviewStats() );
	act( () => {
		IoTelemetry.recordIn( 1000, 10 );
		jest.advanceTimersByTime( 50 );
		IoTelemetry.recordIn( 1000, 10 );
		jest.advanceTimersByTime( 50 );
		IoTelemetry.clear(); // counters back to zero
		jest.advanceTimersByTime( 50 ); // tick sees the backward counter
	} );
	expect( result.current.rates.byteIn ).toBe( 0 );
	expect( result.current.rates.msgIn ).toBe( 0 );
} );

test( 'unsubscribes + clears the tick on unmount (no work after teardown)', () => {
	const { unmount } = renderHook( () => useOverviewStats() );
	unmount();
	expect( () => {
		IoTelemetry.recordIn( 1 );
		IoTelemetry.sample( 0 );
		IoTelemetry.recordIn( 1 );
		IoTelemetry.sample( 5 );
		jest.advanceTimersByTime( 200 );
	} ).not.toThrow();
} );
