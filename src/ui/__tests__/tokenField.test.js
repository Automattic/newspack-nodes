/**
 * A token field is one framed field: its tokens and the entry box they are
 * typed into share a frame, so the frame wears the field's chrome, and the
 * focus ring while the box has focus; the entry inside it wears neither.
 */

import path from 'path';
import * as sass from 'sass';
import postcss from 'postcss';

const ROOT = path.resolve( __dirname, '../../..' );
const UI_SCSS = path.join( ROOT, 'src/ui/newspack-nodes-ui.scss' );
const stylesheet = postcss.parse( sass.compile( UI_SCSS ).css, {
	from: UI_SCSS,
} );

/**
 * Every top-level selector in a list; a comma inside `:not()` does not split the list.
 *
 * @param {string} list The rule's selector list.
 * @return {string[]} Its selectors, pseudo-elements dropped.
 */
function selectorsOf( list ) {
	const parts = [];
	let depth = 0;
	let current = '';
	for ( const ch of list ) {
		depth += ( '(' === ch ) - ( ')' === ch );
		if ( ',' === ch && 0 === depth ) {
			parts.push( current );
			current = '';
			continue;
		}
		current += ch;
	}
	parts.push( current );
	return parts
		.map( ( s ) => s.trim().replace( /\s+/g, ' ' ) )
		.filter( ( s ) => s && ! s.includes( '::' ) );
}

/**
 * The selectors declaring `prop`, top-level ones only.
 *
 * @param {string} prop The declared property.
 * @return {string[]} Every selector declaring it.
 */
function declaring( prop ) {
	const found = [];
	stylesheet.walkDecls( prop, ( decl ) => {
		found.push( ...selectorsOf( decl.parent.selector ?? '' ) );
	} );
	return found;
}

/**
 * The stateless selectors declaring `prop` that match `element`. A selector
 * naming a state or `:has()` is judged by its text, never here.
 *
 * @param {Element} element The element.
 * @param {string}  prop    The declared property.
 * @return {string[]} The matching selectors.
 */
function matching( element, prop ) {
	return declaring( prop )
		.filter(
			( s ) =>
				! /:(hover|focus|active|focus-visible|focus-within|has)\b/.test(
					s
				)
		)
		.filter( ( s ) => element.matches( s ) );
}

describe( 'the token field', () => {
	const root = document.createElement( 'div' );
	root.className = 'newspack-nodes-ui';
	root.append(
		document.createElement( 'input' ),
		document.createElement( 'div' )
	);
	const plain = root.firstChild;
	const frame = root.lastChild;
	frame.className = 'newspack-nodes-token-field';
	const entry = document.createElement( 'input' );
	entry.className = 'newspack-nodes-token-field__entry';
	frame.append( entry );
	[ plain, entry ].forEach( ( input ) => ( input.type = 'text' ) );
	document.body.append( root );

	it( 'paints a plain text box, so the rule below is really judged', () => {
		expect( matching( plain, 'border' ) ).not.toEqual( [] );
	} );

	it( 'gives the frame the field chrome', () => {
		expect( matching( frame, 'border' ) ).not.toEqual( [] );
		expect( matching( frame, 'background-color' ) ).not.toEqual( [] );
	} );

	it( 'leaves the entry out of the text-field rule', () => {
		const painted = matching( entry, 'background-color' ).concat(
			matching( entry, 'border' )
		);

		expect(
			painted.every( ( s ) => s.includes( 'token-field__entry' ) )
		).toBe( true );
	} );

	it( 'rings the frame only while the entry has focus', () => {
		const rings = declaring( 'outline' ).filter( ( s ) =>
			/\.newspack-nodes-token-field(:|$)/.test( s )
		);

		expect( rings ).toEqual( [
			'.newspack-nodes-ui.newspack-nodes-ui .newspack-nodes-token-field:has(.newspack-nodes-token-field__entry:focus)',
		] );
	} );
} );
