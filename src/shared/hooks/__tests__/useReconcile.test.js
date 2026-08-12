/**
 * useReconcile tests — the convergence primitive behind every load that used to
 * run once at mount. The bug it exists for: a console tab left overnight loaded
 * its graph an hour before the command session expired, so nothing it had ever
 * sent was in flight to discover the refusal, and the graph stayed empty until
 * the operator cycled visibility by hand.
 */

import { renderHook, act } from '@testing-library/react';
import { Core, renewSession, forgetSession } from '@newspack-nodes/runtime';
import useReconcile from '../useReconcile';

const flush = async () => {
	await act( async () => {
		await Promise.resolve();
	} );
};

describe( 'useReconcile', () => {
	beforeEach( () => {
		jest.useFakeTimers();
		forgetSession();
	} );

	afterEach( () => {
		// Never useRealTimers() — see jest-node-timers.js. Just drop pending work.
		jest.clearAllTimers();
	} );

	it( 'runs the load once and settles on success', async () => {
		const load = jest.fn().mockResolvedValue( undefined );

		const { result } = renderHook( () => useReconcile( { load } ) );
		await flush();

		expect( load ).toHaveBeenCalledTimes( 1 );
		expect( result.current.settled ).toBe( true );
	} );

	it( 'does not re-run while settled', async () => {
		const load = jest.fn().mockResolvedValue( undefined );

		renderHook( () => useReconcile( { load } ) );
		await flush();
		await act( async () => {
			jest.advanceTimersByTime( 30_000 );
		} );

		expect( load ).toHaveBeenCalledTimes( 1 );
	} );

	it( 're-attempts after the backoff when the load fails', async () => {
		const load = jest.fn().mockRejectedValue( new Error( 'refused-4471' ) );

		renderHook( () => useReconcile( { load } ) );
		await flush();
		expect( load ).toHaveBeenCalledTimes( 1 );

		await act( async () => {
			jest.advanceTimersByTime( 1200 );
		} );

		expect( load.mock.calls.length ).toBeGreaterThan( 1 );
	} );

	it( 'widens the backoff while the load keeps failing', async () => {
		const load = jest.fn().mockRejectedValue( new Error( 'refused-8823' ) );

		renderHook( () => useReconcile( { load } ) );
		await flush();
		await act( async () => {
			jest.advanceTimersByTime( 1200 );
		} );
		const afterFirstWindow = load.mock.calls.length;

		// A second window of the SAME width must not fit another attempt.
		await act( async () => {
			jest.advanceTimersByTime( 1200 );
		} );

		expect( load.mock.calls.length ).toBe( afterFirstWindow );
	} );

	it( 're-attempts when the auth generation is invalidated', async () => {
		const load = jest.fn().mockResolvedValue( undefined );

		renderHook( () => useReconcile( { load } ) );
		await flush();
		expect( load ).toHaveBeenCalledTimes( 1 );

		act( () => {
			renewSession();
		} );
		await act( async () => {
			jest.advanceTimersByTime( 1200 );
		} );

		expect( load ).toHaveBeenCalledTimes( 2 );
	} );

	it( 're-attempts when the graph is rebuilt under it', async () => {
		// A load that PUSHES into a graph node is undone by Reset Graph, so a
		// rebuild invalidates what settled exactly as an expired session does.
		const load = jest.fn().mockResolvedValue( undefined );

		renderHook( () => useReconcile( { load } ) );
		await flush();
		expect( load ).toHaveBeenCalledTimes( 1 );

		act( () => {
			Core.bumpGraphGeneration();
		} );
		await act( async () => {
			jest.advanceTimersByTime( 1200 );
		} );

		expect( load ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'discards an attempt that resolves after its inputs changed', async () => {
		let release;
		const load = jest.fn(
			() =>
				new Promise( ( resolve ) => {
					release = resolve;
				} )
		);

		const { result, rerender } = renderHook(
			( { partition } ) => useReconcile( { load, deps: [ partition ] } ),
			{ initialProps: { partition: 'firehose.p7' } }
		);
		await flush();
		expect( load ).toHaveBeenCalledTimes( 1 );

		// The invalidation lands while the first attempt is still in flight.
		rerender( { partition: 'errors.p3' } );
		await act( async () => {
			release();
			await Promise.resolve();
		} );

		expect( result.current.settled ).toBe( false );
		await act( async () => {
			jest.advanceTimersByTime( 1200 );
		} );
		expect( load ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'does not load while disabled, and loads once enabled', async () => {
		const load = jest.fn().mockResolvedValue( undefined );

		const { rerender } = renderHook(
			( { enabled } ) => useReconcile( { load, enabled } ),
			{ initialProps: { enabled: false } }
		);
		await flush();
		expect( load ).not.toHaveBeenCalled();

		rerender( { enabled: true } );
		await flush();

		expect( load ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'surfaces the load failure so a caller can render it', async () => {
		const load = jest.fn().mockRejectedValue( new Error( 'refused-5512' ) );

		const { result } = renderHook( () => useReconcile( { load } ) );
		await flush();

		expect( result.current.settled ).toBe( false );
		expect( result.current.error?.message ).toBe( 'refused-5512' );
	} );

	it( 'clears its timer on unmount', async () => {
		const load = jest.fn().mockRejectedValue( new Error( 'refused-9931' ) );

		const { unmount } = renderHook( () => useReconcile( { load } ) );
		await flush();
		const atUnmount = load.mock.calls.length;
		unmount();

		await act( async () => {
			jest.advanceTimersByTime( 60_000 );
		} );

		expect( load.mock.calls.length ).toBe( atUnmount );
	} );
} );
