/**
 * The block inserter paints its panels on the skin's raised surface, the one
 * its popover wears, past the stock white and grey the skin's ink cannot read
 * on.
 */

import fs from 'fs';
import path from 'path';
import * as sass from 'sass';
import postcss from 'postcss';

const { winning } = require( '../../../build-kit/css-reader.cjs' );

const ROOT = path.resolve( __dirname, '../../../..' );
const STOCK = path.join(
	ROOT,
	'node_modules/@wordpress/block-editor/build-style/style.css'
);
const UI = path.join( ROOT, 'src/ui/newspack-nodes-ui.scss' );
// The stock rules the inserter's panels meet; jsdom cannot read every other.
const stock = postcss.parse( fs.readFileSync( STOCK, 'utf8' ), {
	from: STOCK,
} );
stock.each( ( node ) => {
	if (
		'rule' !== node.type ||
		! /block-editor-(?:inserter__|tabbed-sidebar)/.test( node.selector )
	) {
		node.remove();
	}
} );
const SHEETS = [ stock, postcss.parse( sass.compile( UI ).css, { from: UI } ) ];

// What the popover around them wears, through the raised-surface mixin.
const RAISED = 'var(--paper-2, var(--np-surface-subtle))';

const PANELS = [
	'block-editor-tabbed-sidebar',
	'block-editor-inserter__search',
	'block-editor-inserter__category-panel',
	'block-editor-inserter__preview-content',
];

describe( 'the block inserter under the shared skin', () => {
	beforeEach( () => {
		document.body.innerHTML = `
			<div class="newspack-nodes-ui">
				<div class="components-popover__content">
					<div class="block-editor-inserter__menu">
						<div class="block-editor-tabbed-sidebar">
							<div class="block-editor-inserter__search"></div>
							<div class="block-editor-inserter__category-panel"></div>
							<div class="block-editor-inserter__preview-content"></div>
						</div>
					</div>
				</div>
			</div>`;
	} );

	it.each( PANELS )( 'paints .%s on the raised surface', ( panel ) => {
		expect(
			winning(
				document.querySelector( `.${ panel }` ),
				'background-color',
				SHEETS
			)
		).toBe( RAISED );
	} );
} );
