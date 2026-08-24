/**
 * usePersistedState / usePersistedChoice — the read → validate → fall back →
 * write back state machine three dashboards wrote by hand.
 *
 * The type-preservation cases are the load-bearing ones: the Gyroscope's
 * refresh interval is a NUMBER of seconds and the Performance dashboard's is a
 * STRING of milliseconds, and localStorage hands both back as text. Matching an
 * option by its own `String( value )` is what returns each in its own type.
 */

import { renderHook, act } from '@testing-library/react';
import { usePersistedState, usePersistedChoice } from '../usePersistedState';

// Seeds no caller defaults to: neither 5/10/30s nor 5000/15000/30000ms.
const SECOND_OPTIONS = [
	{ label: '0.75s', value: 0.75 },
	{ label: '7s', value: 7 },
	{ label: '42s', value: 42 },
];

const MS_OPTIONS = [
	{ label: '250ms', value: '250' },
	{ label: '90s', value: '90000' },
];

beforeEach( () => window.localStorage.clear() );

it( 'restores through the caller-supplied decoder', () => {
	window.localStorage.setItem( 'persisted:list', '["ripe","olive"]' );

	const { result } = renderHook( () =>
		usePersistedState(
			'persisted:list',
			( raw ) => ( null === raw ? [ 'plum' ] : JSON.parse( raw ) ),
			JSON.stringify
		)
	);

	expect( result.current[ 0 ] ).toEqual( [ 'ripe', 'olive' ] );
} );

it( 'writes the new value back through the caller-supplied encoder', () => {
	const { result } = renderHook( () =>
		usePersistedState(
			'persisted:list',
			( raw ) => ( null === raw ? [ 'plum' ] : JSON.parse( raw ) ),
			JSON.stringify
		)
	);

	act( () => result.current[ 1 ]( [ 'quince' ] ) );

	expect( window.localStorage.getItem( 'persisted:list' ) ).toBe(
		'["quince"]'
	);
} );

it( 'keeps a stored numeric option A NUMBER, not the stored text', () => {
	window.localStorage.setItem( 'persisted:seconds', '0.75' );

	const { result } = renderHook( () =>
		usePersistedChoice( 'persisted:seconds', SECOND_OPTIONS, 7 )
	);

	expect( result.current[ 0 ] ).toBe( 0.75 );
} );

it( 'keeps a stored string option A STRING', () => {
	window.localStorage.setItem( 'persisted:ms', '90000' );

	const { result } = renderHook( () =>
		usePersistedChoice( 'persisted:ms', MS_OPTIONS, '250' )
	);

	expect( result.current[ 0 ] ).toBe( '90000' );
} );

it( 'falls back when the stored value is no longer an option', () => {
	window.localStorage.setItem( 'persisted:seconds', '3600' );

	const { result } = renderHook( () =>
		usePersistedChoice( 'persisted:seconds', SECOND_OPTIONS, 42 )
	);

	expect( result.current[ 0 ] ).toBe( 42 );
} );

it( 'persists a new choice as the option list spells it', () => {
	const { result } = renderHook( () =>
		usePersistedChoice( 'persisted:seconds', SECOND_OPTIONS, 7 )
	);

	act( () => result.current[ 1 ]( 42 ) );

	expect( result.current[ 0 ] ).toBe( 42 );
	expect( window.localStorage.getItem( 'persisted:seconds' ) ).toBe( '42' );
} );

it( 'falls back on a storage-blocked browser without throwing', () => {
	const getItem = jest
		.spyOn( window.localStorage.__proto__, 'getItem' )
		.mockImplementation( () => {
			throw new Error( 'SecurityError' );
		} );
	const setItem = jest
		.spyOn( window.localStorage.__proto__, 'setItem' )
		.mockImplementation( () => {
			throw new Error( 'SecurityError' );
		} );

	const { result } = renderHook( () =>
		usePersistedChoice( 'persisted:seconds', SECOND_OPTIONS, 7 )
	);

	expect( result.current[ 0 ] ).toBe( 7 );
	act( () => result.current[ 1 ]( 0.75 ) );
	expect( result.current[ 0 ] ).toBe( 0.75 );

	getItem.mockRestore();
	setItem.mockRestore();
} );
