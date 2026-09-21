/**
 * The `?` picker's page ring. It exists because the one target the size of
 * the page cannot use the outline every other target uses, and it mounts once
 * per armed session rather than appearing and vanishing under the pointer.
 */

import { render, act } from '@testing-library/react';
import AskPageRing from '../AskPageRing';
import { ASK_PAGE_ATTR } from '../../hooks/useAskPicker';

const boxes = [];

const pageBox = ( {
	top = 96,
	left = 36,
	outer = 1200,
	inner = 1183,
} = {} ) => {
	const el = document.createElement( 'div' );
	el.setAttribute( ASK_PAGE_ATTR, '' );
	el.getBoundingClientRect = () => ( {
		top,
		left,
		width: outer,
		height: 900,
		right: left + outer,
		bottom: top + 900,
	} );
	Object.defineProperty( el, 'clientWidth', { value: inner } );
	Object.defineProperty( el, 'clientHeight', { value: 880 } );
	Object.defineProperty( el, 'clientTop', { value: 2 } );
	Object.defineProperty( el, 'clientLeft', { value: 3 } );
	document.body.appendChild( el );
	boxes.push( el );
	return el;
};

const ring = () => document.querySelector( '.newspack-nodes-ask-ring' );

afterEach( () => {
	while ( boxes.length ) {
		boxes.pop().remove();
	}
} );

test( 'a disarmed picker rings nothing', () => {
	pageBox();
	render( <AskPageRing active={ false } /> );

	expect( ring() ).toBeNull();
} );

test( 'it rings the page box it measures, inside that box own scrollbar', () => {
	pageBox();
	render( <AskPageRing active={ true } /> );

	// 1200 outside, 1183 inside: the 17px scrollbar is the box's own, and a
	// line drawn outside it reads as a browser edge rather than the page's.
	// The origin is the PADDING box, so the 2px and 3px borders count.
	expect( ring().style.top ).toBe( '98px' );
	expect( ring().style.left ).toBe( '39px' );
	expect( ring().style.width ).toBe( '1183px' );
	expect( ring().style.height ).toBe( '880px' );
} );

// It leaves the shell's stacking context because the shell is one; that is
// the whole reason it goes through the portal.
test( 'it draws at body level', () => {
	pageBox();
	render( <AskPageRing active={ true } /> );

	expect( ring().closest( '.newspack-nodes-skin-root' ).parentElement ).toBe(
		document.body
	);
} );

// @longform The shell eases `left` over 0.1s on a menu fold, so the fold's own
// signal arrives mid-animation and a rect read there is where the box STARTED.
// Left at that, the ring sits ~124px off the page for the rest of the session.
test( 'it re-measures where the menu fold lands, not where it began', () => {
	const el = pageBox( { left: 160 } );
	render( <AskPageRing active={ true } /> );
	expect( ring().style.left ).toBe( '163px' );

	el.getBoundingClientRect = () => ( {
		top: 96,
		left: 36,
		width: 1200,
		height: 900,
		right: 1236,
		bottom: 996,
	} );
	act( () => {
		document.dispatchEvent(
			new window.Event( 'transitionend', { bubbles: true } )
		);
	} );

	expect( ring().style.left ).toBe( '39px' );
} );

test( 'it leaves when the picker disarms', () => {
	pageBox();
	const view = render( <AskPageRing active={ true } /> );
	expect( ring() ).not.toBeNull();

	view.rerender( <AskPageRing active={ false } /> );

	expect( ring() ).toBeNull();
} );

test( 'a page carrying no ask target rings nothing', () => {
	render( <AskPageRing active={ true } /> );

	expect( ring() ).toBeNull();
} );

test( 'it re-measures when the window resizes', () => {
	const el = pageBox();
	render( <AskPageRing active={ true } /> );
	expect( ring().style.left ).toBe( '39px' );

	el.getBoundingClientRect = () => ( {
		top: 96,
		left: 160,
		width: 900,
		height: 900,
		right: 1060,
		bottom: 996,
	} );
	act( () => {
		window.dispatchEvent( new window.Event( 'resize' ) );
	} );

	expect( ring().style.left ).toBe( '163px' );
} );
