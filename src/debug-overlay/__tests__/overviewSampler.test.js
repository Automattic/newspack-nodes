import { startOverviewSampler, stopOverviewSampler } from '../overviewSampler';
import { IoTelemetry, SAMPLE_INTERVAL_MS } from '../../runtime/io-telemetry';

beforeEach( () => {
	jest.useFakeTimers();
	delete window.__newspackNodesOverviewSampler;
	IoTelemetry.reset();
} );

afterEach( () => {
	jest.clearAllTimers();
	jest.useRealTimers();
} );

test( 'the sampler ticks IoTelemetry.sample on the 5s cadence', () => {
	const spy = jest.spyOn( IoTelemetry, 'sample' );
	startOverviewSampler();
	jest.advanceTimersByTime( SAMPLE_INTERVAL_MS * 3 );
	expect( spy ).toHaveBeenCalledTimes( 3 );
	stopOverviewSampler();
	spy.mockRestore();
} );

test( 'start is idempotent — two starts share ONE interval', () => {
	const spy = jest.spyOn( IoTelemetry, 'sample' );
	startOverviewSampler();
	startOverviewSampler();
	jest.advanceTimersByTime( SAMPLE_INTERVAL_MS );
	// One interval, so one tick per cadence (not two).
	expect( spy ).toHaveBeenCalledTimes( 1 );
	stopOverviewSampler();
	stopOverviewSampler();
	spy.mockRestore();
} );

test( 'the interval keeps running until the LAST balanced stop (ref-counted)', () => {
	const spy = jest.spyOn( IoTelemetry, 'sample' );
	startOverviewSampler();
	startOverviewSampler();
	stopOverviewSampler(); // one ref left — still running
	jest.advanceTimersByTime( SAMPLE_INTERVAL_MS );
	expect( spy ).toHaveBeenCalledTimes( 1 );
	stopOverviewSampler(); // last ref — stops
	jest.advanceTimersByTime( SAMPLE_INTERVAL_MS * 5 );
	expect( spy ).toHaveBeenCalledTimes( 1 );
	spy.mockRestore();
} );

test( 'a lone stop with no active sampler is a no-op', () => {
	expect( () => stopOverviewSampler() ).not.toThrow();
} );
