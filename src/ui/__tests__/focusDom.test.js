/* @jest-environment node */

import path from 'path';
import * as sass from 'sass';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve( __dirname, '../../..' );
const UI_SCSS = path.join( ROOT, 'src/ui/newspack-nodes-ui.scss' );
const FOCUS_COLOR = '#123456';
const compiledUi = sass
	.compile( UI_SCSS )
	.css.replaceAll( 'var(--ink, var(--np-text, currentcolor))', FOCUS_COLOR );

const focusPaths = {
	pointer: ( window, element ) => {
		element.dispatchEvent(
			new window.MouseEvent( 'mousedown', {
				bubbles: true,
				button: 0,
			} )
		);
		element.focus();
	},
	keyboard: ( window, element ) => {
		element.dispatchEvent(
			new window.KeyboardEvent( 'keydown', {
				bubbles: true,
				key: 'Tab',
				code: 'Tab',
			} )
		);
		element.focus();
	},
};

const ringGeometry = ( window, element ) => {
	const style = window.getComputedStyle( element );
	return {
		outline: style.outline,
		outlineOffset: style.outlineOffset,
		boxShadow: style.boxShadow,
		border: style.border,
		borderColor: style.borderColor,
	};
};

const makeDom = () => {
	const dom = new JSDOM(
		`<!doctype html><html><head><style>${ compiledUi }</style></head><body><div class="newspack-nodes-ui"></div></body></html>`,
		{ pretendToBeVisual: true }
	);
	const root = dom.window.document.querySelector( '.newspack-nodes-ui' );
	root.style.setProperty( '--ink', '#123456' );
	root.style.setProperty( '--np-text', '#abcdef' );
	root.style.setProperty( '--paper', '#fefefe' );
	root.style.setProperty( '--paper-shadow', '#654321' );
	return { dom, root };
};

describe( 'focused canonical UI DOM', () => {
	it.each( [
		[
			'text',
			( document ) =>
				Object.assign( document.createElement( 'input' ), {
					type: 'text',
				} ),
		],
		[ 'select', ( document ) => document.createElement( 'select' ) ],
		[
			'number',
			( document ) =>
				Object.assign( document.createElement( 'input' ), {
					type: 'number',
				} ),
		],
		[
			'button',
			( document ) =>
				Object.assign( document.createElement( 'button' ), {
					className: 'button',
				} ),
		],
	] )(
		'gives a focused native %s one stable ring through pointer and keyboard paths',
		( label, createElement ) => {
			for ( const focusElement of Object.values( focusPaths ) ) {
				const { dom, root } = makeDom();
				const { document } = dom.window;
				const reference = createElement( document );
				const element = createElement( document );
				root.appendChild( reference );
				root.appendChild( element );

				focusElement( dom.window, element );

				expect( document.activeElement ).toBe( element );
				const unfocused = ringGeometry( dom.window, reference );
				const after = ringGeometry( dom.window, element );
				expect( after.outline ).toBe( `2px solid ${ FOCUS_COLOR }` );
				expect( after.outlineOffset ).toBe( '1px' );
				expect( after.boxShadow ).toBe( 'none' );
				expect( after.border ).toBe( unfocused.border );
				expect( after.borderColor ).toBe( unfocused.borderColor );
				dom.window.close();
			}
		}
	);

	it.each( Object.entries( focusPaths ) )(
		'puts the %s InputControl ring on its wrapper only',
		( label, focusElement ) => {
			const { dom, root } = makeDom();
			const { document } = dom.window;
			const wrapper = document.createElement( 'div' );
			wrapper.className = 'components-input-control__container';
			const input = document.createElement( 'input' );
			input.className = 'components-input-control__input';
			const referenceWrapper = wrapper.cloneNode();
			const referenceInput = input.cloneNode();
			referenceWrapper.appendChild( referenceInput );
			root.appendChild( referenceWrapper );
			wrapper.appendChild( input );
			root.appendChild( wrapper );

			focusElement( dom.window, input );

			expect( document.activeElement ).toBe( input );
			const wrapperUnfocused = ringGeometry(
				dom.window,
				referenceWrapper
			);
			const inputUnfocused = ringGeometry( dom.window, referenceInput );
			const wrapperAfter = ringGeometry( dom.window, wrapper );
			const inputAfter = ringGeometry( dom.window, input );
			expect( wrapperAfter.outline ).toBe( `2px solid ${ FOCUS_COLOR }` );
			expect( wrapperAfter.outlineOffset ).toBe( '1px' );
			expect( wrapperAfter.boxShadow ).toBe( 'none' );
			expect( wrapperAfter.border ).toBe( wrapperUnfocused.border );
			expect( wrapperAfter.borderColor ).toBe(
				wrapperUnfocused.borderColor
			);
			expect( inputAfter.outline ).toBe( 'none' );
			expect( inputAfter.boxShadow ).toBe( 'none' );
			expect( inputAfter.border ).toBe( inputUnfocused.border );
			expect( inputAfter.borderColor ).toBe( inputUnfocused.borderColor );
			dom.window.close();
		}
	);
} );
