/**
 * A dialog's title takes first focus as the place a screen reader starts,
 * not as a control, so it wears no focus ring in either skin, while a
 * control in the same dialog keeps the ring keyboard focus gives it.
 *
 * jsdom cannot read `:focus` or `:focus-visible`, so a class of equal weight
 * stands in for each.
 */

import path from 'path';
import * as sass from 'sass';
import postcss from 'postcss';

const { winning } = require( '../../../build-kit/css-reader.cjs' );
const { sassImporter } = require( '../../../build-kit/alias-map.cjs' );

const SRC = path.resolve( __dirname, '../../..' );
const UI = path.join( SRC, 'ui/newspack-nodes-ui.scss' );
const THEME = path.join( SRC, 'theme/newspack-theme.scss' );

const FOCUS_VISIBLE = '.is-focus-visible-6203';
const FOCUSED = '.is-focused-6203';
const read = ( file ) =>
	postcss.parse(
		sass
			.compile( file, { importers: [ sassImporter( SRC ) ] } )
			.css.replaceAll( ':focus-visible', FOCUS_VISIBLE )
			.replace( /:focus(?![-\w])/g, FOCUSED ),
		{ from: file }
	);
const SHEETS = [ read( UI ), read( THEME ) ];

const STATES = `${ FOCUSED.slice( 1 ) } ${ FOCUS_VISIBLE.slice( 1 ) }`;

/**
 * A focused dialog under a skin root, its title and its close button.
 *
 * @param {string} root The skin root's classes.
 * @return {{title: Element, close: Element}} The two focused elements.
 */
const dialog = ( root ) => {
	document.body.innerHTML = `
		<div class="${ root }">
			<div class="newspack-nodes-modal" role="dialog">
				<div class="newspack-nodes-modal__header">
					<h2 class="newspack-nodes-modal__title ${ STATES }" tabindex="-1">Kestrel 6203</h2>
					<button type="button" class="newspack-nodes-modal__close ${ STATES }">x</button>
				</div>
			</div>
		</div>`;
	return {
		title: document.querySelector( 'h2' ),
		close: document.querySelector( 'button' ),
	};
};

describe.each( [
	[ 'UI', 'newspack-nodes-ui' ],
	[ 'theme', 'newspack-nodes-theme' ],
] )( 'a focused dialog in the %s skin', ( _skin, root ) => {
	it( 'draws no ring on its title', () => {
		const { title } = dialog( root );
		expect( winning( title, 'outline-style', SHEETS ) ).toBe( 'none' );
	} );

	it( 'keeps the ring on a control beside it', () => {
		const { close } = dialog( root );
		expect( winning( close, 'outline-style', SHEETS ) ).toBe( 'solid' );
	} );
} );
