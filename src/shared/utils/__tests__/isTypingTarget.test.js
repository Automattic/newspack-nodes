/* eslint-env jest */
/**
 * A key landing in a field is the reader's typing, never a shortcut: an
 * input, a textarea, a select or editable content, the element itself or
 * any ancestor, and nothing else.
 */

import { isTypingTarget } from '../isTypingTarget';

function mount( html ) {
	document.body.innerHTML = html;
	return ( selector ) => document.body.querySelector( selector );
}

afterEach( () => {
	document.body.innerHTML = '';
} );

describe( 'isTypingTarget', () => {
	it( 'is true for each field and for anything inside editable content', () => {
		const find = mount(
			'<input id="i"><textarea id="t"></textarea><select id="s"><option id="o">x</option></select>' +
				'<div contenteditable="true"><p><b id="b">bold</b></p></div>'
		);
		for ( const id of [ '#i', '#t', '#s', '#o', '#b' ] ) {
			expect( isTypingTarget( find( id ) ) ).toBe( true );
		}
	} );

	it( 'is false for a button, a link, a row and content made not editable', () => {
		const find = mount(
			'<button id="btn"><svg id="icon"></svg></button><a id="a" href="#x">x</a>' +
				'<li id="li" tabindex="-1">row</li><div contenteditable="false"><span id="ro">no</span></div>'
		);
		for ( const id of [ '#btn', '#icon', '#a', '#li', '#ro' ] ) {
			expect( isTypingTarget( find( id ) ) ).toBe( false );
		}
	} );

	it( 'is false for no element, and for a target that is not an element', () => {
		expect( isTypingTarget( null ) ).toBe( false );
		expect( isTypingTarget( document ) ).toBe( false );
		expect( isTypingTarget( window ) ).toBe( false );
	} );
} );
