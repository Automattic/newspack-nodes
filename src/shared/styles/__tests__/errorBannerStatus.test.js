/**
 * A status line inside the error banner reads in the banner's own ink, so
 * a refusal's words set beneath its sentence stay legible on the oxide fill
 * rather than taking a muted or toned ink meant for the page.
 */

import path from 'path';
import * as sass from 'sass';
import postcss from 'postcss';

const { winning } = require( '../../../build-kit/css-reader.cjs' );

const ROOT = path.resolve( __dirname, '../../../..' );
const UI = path.join( ROOT, 'src/ui/newspack-nodes-ui.scss' );
const SHEETS = [ postcss.parse( sass.compile( UI ).css, { from: UI } ) ];

describe( 'a status inside the error banner', () => {
	beforeEach( () => {
		document.body.innerHTML = `
			<div class="newspack-nodes-ui newspack-nodes-theme newspack-nodes-skin-root">
				<div class="newspack-nodes-error-banner">
					<p>Heron ledger could not be read 7713.</p>
					<p class="newspack-nodes-status is-muted">refused 7713</p>
					<p class="newspack-nodes-status is-warning">held 7713</p>
				</div>
			</div>`;
	} );

	it.each( [ 'is-muted', 'is-warning' ] )(
		'reads a %s line in the banner’s ink',
		( tone ) => {
			const line = document.querySelector(
				`.newspack-nodes-error-banner .newspack-nodes-status.${ tone }`
			);
			expect( winning( line, 'color', SHEETS ) ).toBe( 'inherit' );
		}
	);
} );
