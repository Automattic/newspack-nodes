/* global StorageEvent */
import { render, act } from '@testing-library/react';
import { useEffect } from '@wordpress/element';
import { useThemeToken } from '../useThemeToken';
import { applySkin, SKIN_EVENT, THEME_STORAGE_KEY } from '../../shared/theme';

function Probe( { onValue } ) {
	const token = useThemeToken();
	useEffect( () => {
		onValue( token );
	} );
	return <span />;
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

test( 're-renders on same-window applySkin without a topology ancestor', () => {
	window.localStorage.setItem( THEME_STORAGE_KEY, 'newspack' );
	const values = [];
	render( <Probe onValue={ ( v ) => values.push( v ) } /> );

	act( () => applySkin( 'synthwave' ) );

	expect( values[ values.length - 1 ] ).toBe( 'synthwave' );
} );

test( 'tears down its skin-event listener on unmount', () => {
	window.localStorage.setItem( THEME_STORAGE_KEY, 'newspack' );
	const removeSpy = jest.spyOn( window, 'removeEventListener' );
	const { unmount } = render( <Probe onValue={ () => {} } /> );
	unmount();
	expect( removeSpy ).toHaveBeenCalledWith(
		SKIN_EVENT,
		expect.any( Function )
	);
	removeSpy.mockRestore();
} );
