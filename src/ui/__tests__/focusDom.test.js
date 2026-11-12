/* @jest-environment node */

import path from 'path';
import * as sass from 'sass';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve( __dirname, '../../..' );
const UI_SCSS = path.join( ROOT, 'src/ui/newspack-nodes-ui.scss' );
const FOCUS_COLOR = '#123456';
// The halo that separates the ring from whatever the control is filled with.
const HALO_COLOR = '#0f9d58';
const compiledUi = sass
	.compile( UI_SCSS )
	.css.replaceAll( 'var(--ink, var(--np-text, currentcolor))', FOCUS_COLOR )
	.replaceAll( 'var(--paper, var(--np-surface))', HALO_COLOR );

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
			'rich-text field',
			( document ) => {
				const field = document.createElement( 'div' );
				field.setAttribute( 'contenteditable', 'true' );
				return field;
			},
		],
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
				expect( after.boxShadow ).toBe( `0 0 0 1px ${ HALO_COLOR }` );
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
			expect( wrapperAfter.boxShadow ).toBe(
				`0 0 0 1px ${ HALO_COLOR }`
			);
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

describe( 'focused token-only DOM', () => {
	const THEME_SCSS = path.join( ROOT, 'src/theme/newspack-theme.scss' );
	const compiledTheme = sass
		.compile( THEME_SCSS )
		.css.replaceAll( 'var(--ink, var(--np-text))', FOCUS_COLOR );

	it.each( Object.entries( focusPaths ) )(
		'rings a %s-focused rich-text field on a token-only host',
		( label, focusElement ) => {
			const dom = new JSDOM(
				`<!doctype html><html><head><style>${ compiledTheme }</style></head><body><div class="newspack-nodes-theme"><div contenteditable="true"></div><div contenteditable="false" tabindex="-1"></div></div></body></html>`,
				{ pretendToBeVisual: true }
			);
			const { document } = dom.window;
			const [ field, locked ] =
				document.querySelectorAll( '[contenteditable]' );

			focusElement( dom.window, field );
			expect( document.activeElement ).toBe( field );
			expect( dom.window.getComputedStyle( field ).outline ).toBe(
				`2px solid ${ FOCUS_COLOR }`
			);
			expect( dom.window.getComputedStyle( locked ).outline ).not.toBe(
				`2px solid ${ FOCUS_COLOR }`
			);
			dom.window.close();
		}
	);
} );

describe( 'the block canvas keeps its own focus', () => {
	const THEME_SCSS = path.join( ROOT, 'src/theme/newspack-theme.scss' );
	const CANVAS =
		'<div class="block-editor-writing-flow" contenteditable="true" tabindex="0">' +
		'<div class="block-editor-block-list__layout">' +
		'<div class="block-editor-block-list__block" tabindex="0">' +
		'<p class="block-editor-rich-text__editable rich-text" contenteditable="true">Kestrel 4410</p>' +
		'<button class="button canvas-button">Go</button><a class="canvas-link" href="#k">k</a>' +
		'<details><summary class="canvas-summary">More</summary></details>' +
		'<input class="canvas-input" type="text"><select class="canvas-select"></select>' +
		'</div></div></div>' +
		'<div class="probe-field-7720" contenteditable="true"></div>' +
		'<button class="button probe-button-7721">Go</button>';
	// Each selector of a rule painting a ring, its focus pseudo-classes gone.
	const ringSelectors = ( css ) => {
		const found = [];
		const rule = /([^{}]+)\{([^{}]*)\}/g;
		let match;
		while ( ( match = rule.exec( css ) ) ) {
			if (
				/:focus/.test( match[ 1 ] ) &&
				/outline:\s*2px solid/.test( match[ 2 ] )
			) {
				found.push( match[ 1 ].trim() );
			}
		}
		return found;
	};

	it.each( [
		[ 'the UI root', UI_SCSS, 'newspack-nodes-ui' ],
		[ 'a token-only host', THEME_SCSS, 'newspack-nodes-theme' ],
	] )(
		'rings nothing inside the block canvas under %s, and still rings a plain field',
		( label, scss, root ) => {
			const dom = new JSDOM(
				`<!doctype html><html><body><div class="${ root }">${ CANVAS }</div></body></html>`
			);
			const { document } = dom.window;
			const rules = ringSelectors( sass.compile( scss ).css );
			const ringed = ( element ) =>
				rules.some( ( selector ) =>
					element.matches(
						selector.replace( /:focus(?:-visible|-within)?/g, '' )
					)
				);
			for ( const selector of [
				'.rich-text',
				'.block-editor-block-list__block',
				'.block-editor-writing-flow',
				'.canvas-button',
				'.canvas-link',
				'.canvas-summary',
				'.canvas-input',
				'.canvas-select',
			] ) {
				expect( [
					selector,
					ringed( document.querySelector( selector ) ),
				] ).toEqual( [ selector, false ] );
			}
			for ( const selector of [
				'.probe-field-7720',
				'.probe-button-7721',
			] ) {
				expect( ringed( document.querySelector( selector ) ) ).toBe(
					true
				);
			}
			dom.window.close();
		}
	);
} );

describe( 'every shared focus ring stays out of the block canvas', () => {
	it.each( [
		[ 'the UI sheet', UI_SCSS ],
		[
			'the theme sheet',
			path.join( ROOT, 'src/theme/newspack-theme.scss' ),
		],
	] )(
		'carries the canvas exclusion on each ring selector in %s',
		( label, scss ) => {
			const missing = [];
			const rule = /([^{}]+)\{([^{}]*)\}/g;
			const css = sass.compile( scss ).css;
			let match;
			while ( ( match = rule.exec( css ) ) ) {
				if (
					! /:focus/.test( match[ 1 ] ) ||
					! /outline:\s*2px solid/.test( match[ 2 ] )
				) {
					continue;
				}
				for ( const selector of match[ 1 ].split( /,(?![^(]*\))/ ) ) {
					if ( ! selector.includes( '.block-editor-writing-flow' ) ) {
						missing.push( selector.trim().replace( /\s+/g, ' ' ) );
					}
				}
			}
			expect( missing ).toEqual( [] );
		}
	);
} );
