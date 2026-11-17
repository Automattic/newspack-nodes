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
