/**
 * In DataViews' activity layout the item content is a flex column aligned to
 * its start, so a row's title cell shrinks to its own summary and each row's
 * actions sit wherever that summary ends. The shared sheet stretches the
 * title cell across the content and lets the caller's row fill it, so every
 * row's actions meet one right edge.
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
 * Every declaration the sheet's rules hand an element, the later winning.
 *
 * @param {Element} element The element.
 * @return {Map<string,string>} Property => value.
 */
const matchingDeclarations = ( element ) => {
	const found = new Map();
	stylesheet.walkRules( ( rule ) => {
		if ( rule.selector.includes( '::' ) ) {
			return;
		}
		const reaches = rule.selectors.some( ( selector ) => {
			try {
				return element.matches( selector.trim() );
			} catch ( _error ) {
				return false;
			}
		} );
		if ( reaches ) {
			rule.walkDecls( ( declaration ) =>
				found.set( declaration.prop, declaration.value )
			);
		}
	} );
	return found;
};

test( 'stretches an activity row’s title cell, and lets its row fill it', () => {
	document.body.innerHTML = `
		<div class="newspack-nodes-ui">
			<div class="dataviews-view-activity">
				<div class="dataviews-view-activity__item-content">
					<div class="dataviews-view-activity__item-title">
						<div class="briefing-row-7871">Tide turns 7871</div>
					</div>
				</div>
			</div>
		</div>`;
	const title = document.querySelector(
		'.dataviews-view-activity__item-title'
	);

	expect( matchingDeclarations( title ).get( 'align-self' ) ).toBe(
		'stretch'
	);
	const row = matchingDeclarations( title.firstElementChild );
	expect( row.get( 'flex' ) ).toBe( '1 1 auto' );
	expect( row.get( 'min-width' ) ).toBe( '0' );
} );
