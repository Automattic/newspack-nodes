import { renderHook, act } from '@testing-library/react';
import { useOverviewStats } from '../useOverviewStats';
import { IoTelemetry, OVERVIEW_STORAGE_KEY } from '../../runtime/io-telemetry';

beforeEach( () => {
	IoTelemetry.reset();
	try {
		window.localStorage.removeItem( OVERVIEW_STORAGE_KEY );
	} catch ( _e ) {
		// ignore
	}
} );

test( 'starts at zero totals and empty series', () => {
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

test( 'reflects telemetry totals, current rates, and series after a sample', () => {
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
	expect( result.current.rates.byteIn ).toBeCloseTo( 20 );
	expect( result.current.rates.msgOut ).toBeCloseTo( 1 / 5 );
	expect( result.current.msgRateSeries.In.points ).toHaveLength( 1 );
	expect( result.current.byteRateSeries.Out.points ).toHaveLength( 1 );
} );

test( 'unsubscribes on unmount (no notify after teardown)', () => {
	const { unmount } = renderHook( () => useOverviewStats() );
	unmount();
	expect( () => {
		IoTelemetry.recordIn( 1 );
		IoTelemetry.sample( 0 );
		IoTelemetry.recordIn( 1 );
		IoTelemetry.sample( 5 );
	} ).not.toThrow();
} );
