/**
 * useSkinGutters paints `<body>` with the skin surface and the WordPress
 * component colours resolved inside an element the page already printed as a
 * skin root, so a server-rendered page needs no second provider box.
 */
import { useRef } from '@wordpress/element';
import { render } from '@testing-library/react';
import useSkinGutters from '../useSkinGutters';
import { THEME_STORAGE_KEY } from '@newspack-nodes/shared/theme';

/**
 * Paints from a root the test printed itself, as a PHP page does.
 *
 * @param {Object}  props
 * @param {Element} props.root The printed skin root.
 * @return {null} Nothing.
 */
function PrintedRoot( { root } ) {
	useSkinGutters( useRef( root ) );
	return null;
}

describe( 'useSkinGutters', () => {
	afterEach( () => {
		window.localStorage.clear();
		document.documentElement.className = '';
		document.body.removeAttribute( 'style' );
	} );

	it( 'paints <body> from inside a printed root, and restores it on unmount', () => {
		window.localStorage.setItem( THEME_STORAGE_KEY, 'nord' );
		const root = document.createElement( 'div' );
		document.body.appendChild( root );
		document.body.style.background = 'rgb(9, 9, 9)';
		const real = window.getComputedStyle.bind( window );
		const spy = jest
			.spyOn( window, 'getComputedStyle' )
			.mockImplementation( ( el, pseudo ) =>
				el?.tagName === 'SPAN' && el.parentNode === root
					? {
							backgroundColor: 'rgb(46, 52, 64)',
							getPropertyValue: ( name ) =>
								'--wp-components-color-accent' === name
									? 'rgb(136, 192, 208)'
									: '',
					  }
					: real( el, pseudo )
			);
		const { unmount } = render( <PrintedRoot root={ root } /> );

		expect(
			document.documentElement.classList.contains( 'theme-nord' )
		).toBe( true );
		expect( document.body.style.background ).toBe( 'rgb(46, 52, 64)' );
		expect(
			document.body.style.getPropertyValue(
				'--wp-components-color-accent'
			)
		).toBe( 'rgb(136, 192, 208)' );
		unmount();
		expect( document.body.style.background ).toBe( 'rgb(9, 9, 9)' );
		expect(
			document.body.style.getPropertyValue(
				'--wp-components-color-accent'
			)
		).toBe( '' );
		spy.mockRestore();
		root.remove();
	} );
} );
