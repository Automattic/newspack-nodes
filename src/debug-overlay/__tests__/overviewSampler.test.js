import { startOverviewSampler, stopOverviewSampler } from '../overviewSampler';
import { IoTelemetry, SAMPLE_INTERVAL_MS } from '../../runtime/io-telemetry';

beforeEach( () => {
	jest.useFakeTimers();
	delete window.__newspackNodesOverviewSamplerTimer;
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

test( 'the sampler samples on the 5s grid, whenever it starts', () => {
	jest.setSystemTime( 1_790_000_002_300 );
	const at = [];
	const spy = jest
		.spyOn( IoTelemetry, 'sample' )
		.mockImplementation( () => at.push( Math.floor( Date.now() / 1000 ) ) );
	startOverviewSampler();
	jest.advanceTimersByTime( 8_000 );
	expect( at ).toEqual( [ 1_790_000_005, 1_790_000_010 ] );
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

test( "an older bundle's interval record does not stop this sampler", () => {
	window.__newspackNodesOverviewSampler = { id: 77, refs: 1 };
	const spy = jest.spyOn( IoTelemetry, 'sample' );
	startOverviewSampler();
	jest.advanceTimersByTime( SAMPLE_INTERVAL_MS );
	expect( spy ).toHaveBeenCalledTimes( 1 );
	stopOverviewSampler();
	expect( window.__newspackNodesOverviewSampler ).toEqual( {
		id: 77,
		refs: 1,
	} );
	delete window.__newspackNodesOverviewSampler;
	spy.mockRestore();
} );

test( 'a lone stop with no active sampler is a no-op', () => {
	expect( () => stopOverviewSampler() ).not.toThrow();
} );
