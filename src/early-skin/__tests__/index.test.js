/**
 * The head script puts the stored skin on `<html>` before first paint, from
 * the same store and slug list `theme.js` reads.
 */
import { THEME_STORAGE_KEY } from '../../shared/skinStore';

const load = () =>
	jest.isolateModules( () => {
		require( '../index' );
	} );

describe( 'early skin', () => {
	afterEach( () => {
		window.localStorage.clear();
		document.documentElement.className = '';
	} );

	it( 'applies a stored skin and drops the one the page carried', () => {
		document.documentElement.className = 'wp-toolbar theme-crt';
		window.localStorage.setItem( THEME_STORAGE_KEY, 'solarized' );
		load();
		expect( [ ...document.documentElement.classList ] ).toEqual( [
			'wp-toolbar',
			'theme-solarized',
		] );
	} );

	it( 'falls back to the default for a stale slug no skin answers', () => {
		window.localStorage.setItem( THEME_STORAGE_KEY, 'retired-skin-4471' );
		load();
		expect( [ ...document.documentElement.classList ] ).toEqual( [
			'theme-newspack',
		] );
	} );
} );
