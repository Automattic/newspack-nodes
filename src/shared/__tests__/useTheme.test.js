import { render, act } from '@testing-library/react';
import { useEffect } from '@wordpress/element';
import { useThemeValue } from '../useTheme';
import { setTheme, resetThemeStore, THEME_STORAGE_KEY } from '../theme';

function Probe( { onValue } ) {
	const theme = useThemeValue();
	useEffect( () => {
		onValue( theme );
	} );
	return <div className={ `topology-app theme-${ theme }` } />;
}

afterEach( () => {
	resetThemeStore();
	window.localStorage.clear();
} );

test( 'reads the current stored theme', () => {
	window.localStorage.setItem( THEME_STORAGE_KEY, 'crt' );
	const values = [];
	render( <Probe onValue={ ( v ) => values.push( v ) } /> );
	expect( values[ values.length - 1 ] ).toBe( 'crt' );
} );

test( 're-renders in-window when setTheme is called (no storage event needed)', () => {
	window.localStorage.setItem( THEME_STORAGE_KEY, 'newspack' );
	const values = [];
	render( <Probe onValue={ ( v ) => values.push( v ) } /> );
	act( () => setTheme( 'nord' ) );
	expect( values[ values.length - 1 ] ).toBe( 'nord' );
} );

test( 'two independent subscribers re-render to the same value in one commit', () => {
	window.localStorage.setItem( THEME_STORAGE_KEY, 'newspack' );
	const a = [];
	const b = [];
	render(
		<>
			<Probe onValue={ ( v ) => a.push( v ) } />
			<Probe onValue={ ( v ) => b.push( v ) } />
		</>
	);
	act( () => setTheme( 'aurora' ) );
	expect( a[ a.length - 1 ] ).toBe( 'aurora' );
	expect( b[ b.length - 1 ] ).toBe( 'aurora' );
} );
