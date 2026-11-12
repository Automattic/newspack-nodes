/**
 * The section-heading role rules the heading it names: a hairline in the
 * skin's shadow ink beneath it, a short step below its text, on whatever
 * element carries it, a heading or a header row holding one.
 */

import path from 'path';
import * as sass from 'sass';
import postcss from 'postcss';

const { winning } = require( '../../../build-kit/css-reader.cjs' );

const ROOT = path.resolve( __dirname, '../../../..' );
const UI = path.join( ROOT, 'src/ui/newspack-nodes-ui.scss' );
const SHEETS = [ postcss.parse( sass.compile( UI ).css, { from: UI } ) ];

const RULE_INK = 'var(--paper-shadow, var(--np-border-strong))';

describe( 'the section-heading role', () => {
	beforeEach( () => {
		document.body.innerHTML = `
			<div class="newspack-nodes-ui newspack-nodes-theme newspack-nodes-skin-root">
				<h3 class="newspack-nodes-section-heading">Gullwing desk</h3>
				<div class="newspack-nodes-section-heading">
					<h2>Tidewater ledger</h2>
				</div>
			</div>`;
	} );

	it.each( [ 'h3', 'div' ] )(
		'rules a %s carrying it beneath, a short step below its text',
		( tag ) => {
			const heading = document.querySelector(
				`${ tag }.newspack-nodes-section-heading`
			);
			expect( winning( heading, 'border-bottom-style', SHEETS ) ).toBe(
				'solid'
			);
			expect( winning( heading, 'border-bottom-width', SHEETS ) ).toBe(
				'1px'
			);
			expect( winning( heading, 'border-bottom-color', SHEETS ) ).toBe(
				RULE_INK
			);
			expect( winning( heading, 'padding-block-end', SHEETS ) ).toBe(
				'8px'
			);
		}
	);
} );
