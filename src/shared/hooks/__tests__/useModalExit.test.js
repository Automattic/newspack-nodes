/**
 * useModalExit: `close()` marks the dialog closing, then runs `onClose` once
 * MODAL_EXIT_MS later, or at once under reduced motion.
 */

import { renderHook, act } from '@testing-library/react';
import { useModalExit, MODAL_EXIT_MS } from '../useModalExit';

const REDUCED = '(prefers-reduced-motion: reduce)';

beforeEach( () => {
	jest.useFakeTimers();
} );

afterEach( () => {
	jest.useRealTimers();
	delete window.matchMedia;
} );

test( 'close sets closing and runs onClose once after 240ms', () => {
	const onClose = jest.fn();
	const { result } = renderHook( () => useModalExit( onClose ) );

	expect( result.current.closing ).toBe( false );
	act( () => result.current.close() );

	expect( result.current.closing ).toBe( true );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS - 1 ) );
	expect( onClose ).not.toHaveBeenCalled();
	act( () => jest.advanceTimersByTime( 1 ) );
	expect( onClose ).toHaveBeenCalledTimes( 1 );
} );

test( 'a second close while closing does not run onClose twice', () => {
	const onClose = jest.fn();
	const { result } = renderHook( () => useModalExit( onClose ) );

	act( () => result.current.close() );
	act( () => jest.advanceTimersByTime( 100 ) );
	act( () => result.current.close() );
	act( () => jest.advanceTimersByTime( 1000 ) );

	expect( onClose ).toHaveBeenCalledTimes( 1 );
} );

test( 'reduced motion runs onClose at once', () => {
	window.matchMedia = jest.fn( ( query ) => ( {
		matches: REDUCED === query,
	} ) );
	const onClose = jest.fn();
	const { result } = renderHook( () => useModalExit( onClose ) );

	act( () => result.current.close() );

	expect( window.matchMedia ).toHaveBeenCalledWith( REDUCED );
	expect( onClose ).toHaveBeenCalledTimes( 1 );
	expect( result.current.closing ).toBe( false );
} );

test( 'unmount during the exit runs the close at once and leaves no timer', () => {
	const onClose = jest.fn();
	const { result, unmount } = renderHook( () => useModalExit( onClose ) );

	act( () => result.current.close() );
	unmount();
	expect( onClose ).toHaveBeenCalledTimes( 1 );
	expect( jest.getTimerCount() ).toBe( 0 );
	act( () => jest.advanceTimersByTime( 1000 ) );

	expect( onClose ).toHaveBeenCalledTimes( 1 );
} );

test( 'unmount during the exit still runs a closeWith answer, once', () => {
	const onClose = jest.fn();
	const dotterel = jest.fn();
	const { result, unmount } = renderHook( () => useModalExit( onClose ) );

	act( () => result.current.closeWith( dotterel ) );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS - 100 ) );
	unmount();

	expect( dotterel ).toHaveBeenCalledTimes( 1 );
	expect( jest.getTimerCount() ).toBe( 0 );
	act( () => jest.advanceTimersByTime( 1000 ) );
	expect( dotterel ).toHaveBeenCalledTimes( 1 );
	expect( onClose ).not.toHaveBeenCalled();
} );

test( 'unmount with no close pending runs nothing', () => {
	const onClose = jest.fn();
	const { unmount } = renderHook( () => useModalExit( onClose ) );

	unmount();

	expect( onClose ).not.toHaveBeenCalled();
} );

test( 'a close whose onClose keeps the dialog open resets, and closes again', () => {
	const onClose = jest.fn();
	const { result } = renderHook( () => useModalExit( onClose ) );

	act( () => result.current.close() );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );
	expect( onClose ).toHaveBeenCalledTimes( 1 );
	expect( result.current.closing ).toBe( false );

	act( () => result.current.close() );
	expect( result.current.closing ).toBe( true );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );
	expect( onClose ).toHaveBeenCalledTimes( 2 );
	expect( result.current.closing ).toBe( false );
} );

test( 'reduced motion lets a kept-open dialog close again', () => {
	window.matchMedia = jest.fn( ( query ) => ( {
		matches: REDUCED === query,
	} ) );
	const onClose = jest.fn();
	const { result } = renderHook( () => useModalExit( onClose ) );

	act( () => result.current.close() );
	act( () => result.current.close() );

	expect( onClose ).toHaveBeenCalledTimes( 2 );
} );

test( 'without onClose, close does nothing', () => {
	const { result } = renderHook( () => useModalExit( undefined ) );

	act( () => result.current.close() );

	expect( result.current.closing ).toBe( false );
	expect( jest.getTimerCount() ).toBe( 0 );
} );

test( 'close runs the onClose of the latest render', () => {
	const first = jest.fn();
	const second = jest.fn();
	const { result, rerender } = renderHook(
		( { onClose } ) => useModalExit( onClose ),
		{ initialProps: { onClose: first } }
	);

	act( () => result.current.close() );
	rerender( { onClose: second } );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );

	expect( first ).not.toHaveBeenCalled();
	expect( second ).toHaveBeenCalledTimes( 1 );
} );

test( 'close handed a click event still runs onClose', () => {
	const onClose = jest.fn();
	const { result } = renderHook( () => useModalExit( onClose ) );

	act( () => result.current.close( new window.MouseEvent( 'click' ) ) );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );

	expect( onClose ).toHaveBeenCalledTimes( 1 );
} );

test( 'closeWith( run ) runs run in place of onClose once the exit has played', () => {
	const onClose = jest.fn();
	const redshank = jest.fn();
	const { result } = renderHook( () => useModalExit( onClose ) );

	act( () => result.current.closeWith( redshank ) );
	expect( redshank ).not.toHaveBeenCalled();
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );

	expect( redshank ).toHaveBeenCalledTimes( 1 );
	expect( onClose ).not.toHaveBeenCalled();
} );

test( 'only the first close runs: a closeWith during the exit is ignored', () => {
	const onClose = jest.fn();
	const knot = jest.fn();
	const { result } = renderHook( () => useModalExit( onClose ) );

	act( () => result.current.close() );
	act( () => result.current.closeWith( knot ) );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );

	expect( onClose ).toHaveBeenCalledTimes( 1 );
	expect( knot ).not.toHaveBeenCalled();
} );

test( 'reduced motion runs closeWith at once', () => {
	window.matchMedia = jest.fn( ( query ) => ( {
		matches: REDUCED === query,
	} ) );
	const onClose = jest.fn();
	const ruff = jest.fn();
	const { result } = renderHook( () => useModalExit( onClose ) );

	act( () => result.current.closeWith( ruff ) );

	expect( ruff ).toHaveBeenCalledTimes( 1 );
	expect( onClose ).not.toHaveBeenCalled();
	expect( result.current.closing ).toBe( false );
} );

test( 'without onClose, closeWith still plays the exit and runs run', () => {
	const stint = jest.fn();
	const { result } = renderHook( () => useModalExit( undefined ) );

	act( () => result.current.closeWith( stint ) );
	expect( result.current.closing ).toBe( true );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );

	expect( stint ).toHaveBeenCalledTimes( 1 );
} );

test( 'a throwing run surfaces its error and still resets the dialog', () => {
	const onClose = jest.fn();
	const { result } = renderHook( () => useModalExit( onClose ) );

	act( () =>
		result.current.closeWith( () => {
			throw new Error( 'godwit refused 52' );
		} )
	);
	expect( () =>
		act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) )
	).toThrow( 'godwit refused 52' );
	// The throw left act before it rendered the reset, as a browser would.
	act( () => {} );

	expect( result.current.closing ).toBe( false );
	act( () => result.current.close() );
	expect( result.current.closing ).toBe( true );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );
	expect( onClose ).toHaveBeenCalledTimes( 1 );
} );

test( 'under reduced motion a throwing run surfaces at once and still resets', () => {
	window.matchMedia = jest.fn( ( query ) => ( {
		matches: REDUCED === query,
	} ) );
	const onClose = jest.fn();
	const { result } = renderHook( () => useModalExit( onClose ) );

	expect( () =>
		result.current.closeWith( () => {
			throw new Error( 'curlew refused 8' );
		} )
	).toThrow( 'curlew refused 8' );
	act( () => result.current.close() );

	expect( onClose ).toHaveBeenCalledTimes( 1 );
} );
