/**
 * installViewport answers each media query on its own terms: a width query
 * from the viewport, reduced motion only where a test opts in, and anything
 * else false.
 */

import { installViewport } from '../viewportWidth';

const REDUCED = '(prefers-reduced-motion: reduce)';

let viewport;
afterEach( () => viewport.restore() );

test( 'a narrow viewport answers its width query and leaves motion on', () => {
	viewport = installViewport( true );

	expect( window.matchMedia( '(width < 600px)' ).matches ).toBe( true );
	expect( window.matchMedia( REDUCED ).matches ).toBe( false );
} );

test( 'reduced motion answers true only for a test that opts in', () => {
	viewport = installViewport( false, { reducedMotion: true } );

	expect( window.matchMedia( REDUCED ).matches ).toBe( true );
	expect( window.matchMedia( '(width < 600px)' ).matches ).toBe( false );
} );

test( 'a query it does not model answers false', () => {
	viewport = installViewport( true );

	expect( window.matchMedia( '(prefers-color-scheme: dark)' ).matches ).toBe(
		false
	);
} );

test( 'setNarrow moves the width query alone', () => {
	viewport = installViewport( false );
	const width = window.matchMedia( '(width < 782px)' );
	const motion = window.matchMedia( REDUCED );

	viewport.setNarrow( true );

	expect( width.matches ).toBe( true );
	expect( motion.matches ).toBe( false );
} );
