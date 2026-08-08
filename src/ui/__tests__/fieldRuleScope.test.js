/**
 * A submit button is an `<input>`, so the text-field rule matches it unless
 * buttons are excluded. Its `color` loses to the button role on specificity,
 * but `-webkit-text-fill-color` has no competitor and paints over `color` —
 * which rendered "Save Settings" in field ink on the primary fill (1.25:1).
 */

import path from 'path';
import * as sass from 'sass';
// postcss-scss declares PostCSS as a required peer; this parses compiled CSS.
// eslint-disable-next-line import/no-extraneous-dependencies
import postcss from 'postcss';

const ROOT = path.resolve( __dirname, '../../..' );
const UI_SCSS = path.join( ROOT, 'src/ui/newspack-nodes-ui.scss' );
const stylesheet = postcss.parse( sass.compile( UI_SCSS ).css, {
	from: UI_SCSS,
} );

// Split a selector list on its TOP-LEVEL commas only. A naive split shreds
// `:not(.a, .b)` into two invalid fragments, which jsdom then refuses — a
// silent false pass that hid the focus rule on the first run.
function splitSelectorList( selector ) {
	const parts = [];
	let depth = 0;
	let current = '';
	for ( const ch of selector ) {
		if ( ch === '(' ) {
			depth += 1;
		} else if ( ch === ')' ) {
			depth -= 1;
		}
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

// Every simple selector that declares `prop`.
function selectorsDeclaring( prop ) {
	const out = [];
	stylesheet.walkDecls( prop, ( decl ) => {
		const rule = decl.parent;
		if ( rule && rule.selector ) {
			out.push( ...splitSelectorList( rule.selector ) );
		}
	} );
	return out;
}

function matchesButton( selector, button ) {
	try {
		return button.matches(
			selector.replace( /:(hover|focus|active)\b/g, '' )
		);
	} catch ( _err ) {
		return false;
	}
}

describe( 'field styling scope', () => {
	let button;

	beforeEach( () => {
		document.body.innerHTML =
			'<div class="wrap newspack-nodes-theme newspack-nodes-ui">' +
			'<p class="submit"><input type="submit" id="submit" ' +
			'class="button button-primary" value="Save Settings"></p>' +
			'</div>';
		button = document.getElementById( 'submit' );
	} );

	it( 'never paints a submit button with the field ink', () => {
		const painting = selectorsDeclaring( '-webkit-text-fill-color' ).filter(
			( sel ) => matchesButton( sel, button )
		);
		expect( painting ).toEqual( [] );
	} );

	// The field rule also carries the square corners, the field border and the
	// field padding, and it outranks `.button` — which is why the submit input
	// rendered square beside a rounded <button>.
	it( 'gives a submit button none of the text-field declarations', () => {
		const fieldish = [];
		stylesheet.walkRules( ( rule ) => {
			const css = rule.toString();
			if ( ! /--np-field-|--field-radius/.test( css ) ) {
				return;
			}
			splitSelectorList( rule.selector ).forEach( ( sel ) => {
				if ( matchesButton( sel, button ) ) {
					fieldish.push( sel );
				}
			} );
		} );
		expect( fieldish ).toEqual( [] );
	} );

	// The `@longform` note in _focus.scss: buttons ring on KEYBOARD focus only,
	// or the ring sits on whatever you last clicked. Its `button` selector does
	// not cover <input type="submit">, which took the text-field branch.
	it( 'does not give a submit button a plain :focus ring', () => {
		const ringed = [];
		stylesheet.walkRules( ( rule ) => {
			if ( ! /:focus(?!-visible)/.test( rule.selector ) ) {
				return;
			}
			splitSelectorList( rule.selector ).forEach( ( sel ) => {
				if (
					! sel.includes( ':focus-visible' ) &&
					matchesButton( sel, button )
				) {
					ringed.push( sel );
				}
			} );
		} );
		expect( ringed ).toEqual( [] );
	} );

	it( 'still styles a real text field', () => {
		document.body.innerHTML =
			'<div class="newspack-nodes-theme newspack-nodes-ui">' +
			'<input type="text" id="field" value="x"></div>';
		const field = document.getElementById( 'field' );
		const painting = selectorsDeclaring( '-webkit-text-fill-color' ).filter(
			( sel ) => matchesButton( sel, field )
		);
		expect( painting.length ).toBeGreaterThan( 0 );
	} );
} );
