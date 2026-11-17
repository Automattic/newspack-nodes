/**
 * The log row's fixed columns hold what each one shows on one line.
 */

import path from 'path';
import * as sass from 'sass';
import postcss from 'postcss';

const sheet = postcss.parse(
	sass.compile( path.join( __dirname, '../LogRowList.scss' ) ).css
);

/**
 * A rule's declared width, in `ch`.
 *
 * @param {string} selector The rule's selector.
 * @return {number} The width.
 */
const widthCh = ( selector ) => {
	let width = '';
	sheet.walkRules( selector, ( rule ) =>
		rule.walkDecls( 'width', ( decl ) => {
			width = decl.value;
		} )
	);
	expect( width ).toMatch( /^\d+ch$/ );
	return parseInt( width, 10 );
};

test( 'the key column holds an event logger request id, 32 characters', () => {
	expect( widthCh( '.newspack-nodes-log-row__key' ) ).toBeGreaterThanOrEqual(
		'b7ow0m58csn652ttdtnk000f2tprm8j0'.length + 1
	);
} );

describe( 'the column header', () => {
	const { computed } = require( '../../../build-kit/css-reader.cjs' );
	const UI = path.join( __dirname, '../../../ui/newspack-nodes-ui.scss' );
	const sheets = [ postcss.parse( sass.compile( UI ).css ), sheet ];

	test( 'sets its labels in the font the rows are set in, so a ch is one width in both', () => {
		document.body.innerHTML = `
			<div class="newspack-nodes-ui newspack-nodes-theme newspack-nodes-skin-root">
				<div class="newspack-nodes-log-header" id="header">
					<span class="newspack-nodes-log-header__th newspack-nodes-table__cell newspack-nodes-log-row__key" id="head">Key</span>
				</div>
				<div class="newspack-nodes-log-row" id="row">
					<span class="newspack-nodes-table__cell newspack-nodes-log-row__key" id="cell">b7ow0m58</span>
				</div>
			</div>`;
		const font = ( id ) =>
			[ 'font-family', 'font-size' ].map( ( longhand ) =>
				computed( document.getElementById( id ), longhand, sheets )
			);
		expect( font( 'header' ) ).toEqual( font( 'row' ) );
		expect( font( 'row' )[ 1 ] ).toBe( '12px' );
		// Neither cell sets a font of its own, so each takes its line's.
		expect( font( 'head' ) ).toEqual( [ undefined, undefined ] );
		expect( font( 'cell' ) ).toEqual( [ undefined, undefined ] );
	} );
} );
