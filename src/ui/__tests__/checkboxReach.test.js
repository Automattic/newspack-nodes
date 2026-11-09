/**
 * The shared checkbox box paints plain checkboxes and CheckboxControl, and
 * leaves ToggleControl's own hidden input to wp-components: painting it pulls
 * the input into the flow as a visible box and pushes the thumb off its track.
 */

import path from 'path';
import * as sass from 'sass';
import postcss from 'postcss';
import { render } from '@testing-library/react';
import { CheckboxControl, ToggleControl } from '@wordpress/components';

const ROOT = path.resolve( __dirname, '../../..' );
const UI_SCSS = path.join( ROOT, 'src/ui/newspack-nodes-ui.scss' );
const stylesheet = postcss.parse( sass.compile( UI_SCSS ).css, {
	from: UI_SCSS,
} );

// The properties that decide whether an input sits in the flow as a box.
const GEOMETRY = [ 'appearance', 'width', 'height', 'position' ];

/**
 * Every top-level selector in a list; a comma inside `:not()` does not split it.
 *
 * @param {string} list The rule's selector list.
 * @return {string[]} Its selectors.
 */
function selectorsOf( list ) {
	const parts = [];
	let depth = 0;
	let current = '';
	for ( const ch of list ) {
		depth += ( '(' === ch ) - ( ')' === ch );
		if ( ',' === ch && 0 === depth ) {
			parts.push( current.trim() );
			current = '';
		} else {
			current += ch;
		}
	}
	parts.push( current.trim() );
	return parts;
}

/**
 * The geometry declarations the shared sheet's unpseudo'd rules give an element.
 *
 * @param {Element} element The rendered element.
 * @return {Object} Property => value, the last matching rule winning.
 */
function geometryOf( element ) {
	const found = {};
	stylesheet.walkRules( ( rule ) => {
		if ( 'keyframes' === rule.parent?.name ) {
			return;
		}
		const reaches = selectorsOf( rule.selector )
			.filter(
				( selector ) =>
					! /:(?::|checked|indeterminate|focus|hover|has)/.test(
						selector
					)
			)
			.some( ( selector ) => element.matches( selector ) );
		if ( ! reaches ) {
			return;
		}
		rule.walkDecls( ( declaration ) => {
			if ( GEOMETRY.includes( declaration.prop ) ) {
				found[ declaration.prop ] = declaration.value;
			}
		} );
	} );
	return found;
}

const renderInUi = ( element ) =>
	render( <div className="newspack-nodes-ui">{ element }</div> ).container;

test( "leaves ToggleControl's own input to wp-components", () => {
	const container = renderInUi(
		<ToggleControl
			label="Probe toggle 47"
			checked={ false }
			onChange={ () => {} }
			__nextHasNoMarginBottom
		/>
	);
	const input = container.querySelector( '.components-form-toggle__input' );

	expect( input ).not.toBeNull();
	expect( geometryOf( input ) ).toEqual( {} );
} );

test( 'paints a plain checkbox as the shared 16px box', () => {
	const container = renderInUi(
		<input type="checkbox" aria-label="Probe 83" />
	);

	expect( geometryOf( container.querySelector( 'input' ) ) ).toEqual( {
		appearance: 'none',
		width: '16px',
		height: '16px',
		position: 'relative',
	} );
} );

test( "paints CheckboxControl's input as the shared 16px box", () => {
	const container = renderInUi(
		<CheckboxControl
			label="Probe checkbox 59"
			checked={ false }
			onChange={ () => {} }
			__nextHasNoMarginBottom
		/>
	);
	const input = container.querySelector(
		'.components-checkbox-control__input'
	);

	expect( input ).not.toBeNull();
	expect( geometryOf( input ) ).toEqual( {
		appearance: 'none',
		width: '16px',
		height: '16px',
		position: 'relative',
	} );
} );
