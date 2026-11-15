/* @jest-environment node */

import path from 'path';
import * as sass from 'sass';
import postcss from 'postcss';

const UI_SCSS = path.resolve( __dirname, '../newspack-nodes-ui.scss' );
const stylesheet = postcss.parse( sass.compile( UI_SCSS ).css );

// DataViews' filter popover pads its widget 16px a side and gaps its inputs 8px.
const WIDGET_PADDING = 16;
const INPUT_GAP = 8;
// The calendar draws seven 32px day buttons a row.
const CALENDAR_WIDTH = 7 * 32;
// "11 / 07 / 2026" beside Chrome's picker icon needs 130px of input.
const DATE_INPUT_WIDTH = 130;

const declared = ( target, prop ) => {
	let value = null;
	stylesheet.walkRules( ( rule ) => {
		const reaches = rule.selector
			.split( /,(?![^(]*\))/ )
			.some(
				( selector ) =>
					selector.includes(
						'.dataviews-filters__summary-popover'
					) &&
					selector.includes( ':has(.dataviews-controls__date)' ) &&
					selector.trim().endsWith( target )
			);
		if ( reaches ) {
			rule.walkDecls( prop, ( decl ) => {
				value = decl.value;
			} );
		}
	} );
	return value;
};

describe( 'the date filter popover', () => {
	it( 'is wide enough for the calendar and two whole dates', () => {
		const width = parseFloat(
			declared( '.components-popover__content', 'max-width' )
		);
		expect( width ).not.toBeNaN();
		const content = width - 2 * WIDGET_PADDING;
		expect( content ).toBeGreaterThanOrEqual( CALENDAR_WIDTH );
		expect( ( content - INPUT_GAP ) / 2 ).toBeGreaterThanOrEqual(
			DATE_INPUT_WIDTH
		);
	} );

	it( 'splits the row evenly between the two dates', () => {
		expect(
			declared( '.dataviews-controls__date-range-inputs > *', 'flex' )
		).toBe( '1' );
	} );

	it( 'centers the month in the calendar', () => {
		expect(
			declared( '.components-calendar__months', 'margin-inline' )
		).toBe( 'auto' );
	} );
} );
