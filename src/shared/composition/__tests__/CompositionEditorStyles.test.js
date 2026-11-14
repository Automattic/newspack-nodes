/* @jest-environment node */
/**
 * The layout editor shows no block switcher preview: core renders it as a
 * second block list in an iframe that carries neither the page's skin nor
 * its reads, so a composition block could only preview as an empty box.
 */

import path from 'path';
import * as sass from 'sass';
import postcss from 'postcss';

const SHEET = path.resolve( __dirname, '../CompositionEditor.scss' );

describe( 'CompositionEditor.scss', () => {
	it( "hides the block switcher's preview popover inside the editor", () => {
		const found = {};
		postcss
			.parse( sass.compile( SHEET ).css, { from: SHEET } )
			.walkRules( ( rule ) => {
				rule.walkDecls( ( decl ) => {
					found[ rule.selector ] = {
						...found[ rule.selector ],
						[ decl.prop ]: decl.value,
					};
				} );
			} );
		expect(
			found[
				'.newspack-nodes-composition-editor .block-editor-block-switcher__popover-preview'
			]
		).toEqual( { display: 'none' } );
	} );
} );
