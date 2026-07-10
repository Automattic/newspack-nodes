/* global StorageEvent */
import { render, act } from '@testing-library/react';
import { useRef, useEffect } from '@wordpress/element';
import { useThemeToken } from '../useThemeToken';
import { THEME_STORAGE_KEY } from '../../topology-console/themes';

function Probe( { onValue } ) {
	const ref = useRef( null );
	const token = useThemeToken( ref );
	useEffect( () => {
		onValue( token );
	} );
	return (
		<div className="topology-app theme-newspack">
			<span ref={ ref } />
		</div>
	);
}

test( 'returns the current stored theme', () => {
	window.localStorage.setItem( THEME_STORAGE_KEY, 'crt' );
	let seen;
	render( <Probe onValue={ ( v ) => ( seen = v ) } /> );
	expect( seen ).toBe( 'crt' );
} );

test( 're-renders with the new theme on a cross-window storage event', () => {
	window.localStorage.setItem( THEME_STORAGE_KEY, 'newspack' );
	const values = [];
	render( <Probe onValue={ ( v ) => values.push( v ) } /> );
	act( () => {
		window.localStorage.setItem( THEME_STORAGE_KEY, 'nord' );
		window.dispatchEvent(
			new StorageEvent( 'storage', {
				key: THEME_STORAGE_KEY,
				newValue: 'nord',
			} )
		);
	} );
	expect( values[ values.length - 1 ] ).toBe( 'nord' );
} );

test( 're-renders when the themed ancestor class changes in-window (set_skin)', async () => {
	window.localStorage.setItem( THEME_STORAGE_KEY, 'newspack' );
	const values = [];
	const { container } = render(
		<Probe onValue={ ( v ) => values.push( v ) } />
	);
	const root = container.querySelector( '.topology-app' );
	// set_skin swaps the theme-* class; MutationObserver fires on a microtask.
	await act( async () => {
		window.localStorage.setItem( THEME_STORAGE_KEY, 'synthwave' );
		root.className = 'topology-app theme-synthwave';
		await Promise.resolve();
	} );
	expect( values[ values.length - 1 ] ).toBe( 'synthwave' );
} );

test( 'tears down its storage listener and observer on unmount', () => {
	window.localStorage.setItem( THEME_STORAGE_KEY, 'newspack' );
	const removeSpy = jest.spyOn( window, 'removeEventListener' );
	const disconnectSpy = jest.spyOn(
		window.MutationObserver.prototype,
		'disconnect'
	);
	const { unmount } = render( <Probe onValue={ () => {} } /> );
	unmount();
	expect( removeSpy ).toHaveBeenCalledWith(
		'storage',
		expect.any( Function )
	);
	expect( disconnectSpy ).toHaveBeenCalled();
	removeSpy.mockRestore();
	disconnectSpy.mockRestore();
} );
