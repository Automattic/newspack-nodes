import path from 'path';
import * as sass from 'sass';
// postcss-scss declares PostCSS as a required peer; this test probes selectors
// from source-compiled canonical UI CSS against the real modal DOM.
// eslint-disable-next-line import/no-extraneous-dependencies
import postcss from 'postcss';
import { render } from '@testing-library/react';
import { ModalShell } from '../../topology-console/components/Modal';

const ROOT = path.resolve( __dirname, '../../..' );
const UI_SCSS = path.join( ROOT, 'src/ui/newspack-nodes-ui.scss' );
const stylesheet = postcss.parse( sass.compile( UI_SCSS ).css, {
	from: UI_SCSS,
} );

const normalize = ( value ) =>
	value
		.replace( /\s+/g, ' ' )
		.replace( /\s*,\s*/g, ',' )
		.trim();

const matchingDeclarations = ( element ) => {
	const matches = [];
	stylesheet.walkRules( ( rule ) => {
		for ( const selector of rule.selector.split( ',' ) ) {
			try {
				if ( element.matches( selector.trim() ) ) {
					rule.walkDecls( ( declaration ) => {
						matches.push( [
							declaration.prop,
							normalize( declaration.value ),
						] );
					} );
					break;
				}
			} catch ( _error ) {
				// Ignore pseudo-selectors jsdom cannot put into an active state.
			}
		}
	} );
	return new Map( matches );
};

const expectModalPaint = ( frame, header, title, close ) => {
	expect( matchingDeclarations( frame ).get( 'background' ) ).toBe(
		'var(--paper-2,var(--np-surface-subtle))'
	);
	expect( matchingDeclarations( header ).get( 'background' ) ).toBe(
		'var(--paper-2,var(--np-surface-subtle))'
	);
	expect( matchingDeclarations( title ).get( 'color' ) ).toBe(
		'var(--ink,var(--np-text))'
	);
	expect( matchingDeclarations( close ).get( 'color' ) ).toBe(
		'var(--ink,var(--np-text))'
	);
};

test( 'canonical modal selectors reach the real nested ModalShell portal', () => {
	expect.assertions( 4 );
	render(
		<ModalShell title="Selector reach probe 73" onDismiss={ () => {} }>
			<div>probe body 91</div>
		</ModalShell>
	);

	expectModalPaint(
		document.body.querySelector( '.newspack-nodes-modal' ),
		document.body.querySelector( '.topology-modal__header' ),
		document.body.querySelector( '.topology-modal__title' ),
		document.body.querySelector( '.topology-modal__close' )
	);
} );

test( 'canonical modal selectors reach a same-element WordPress frame', () => {
	expect.assertions( 4 );
	const frame = document.createElement( 'div' );
	frame.className =
		'components-modal__frame newspack-nodes-modal newspack-nodes-ui';
	frame.innerHTML = `
		<div class="components-modal__header">
			<h1 class="components-modal__header-heading">probe heading 37</h1>
			<button type="button">probe close 41</button>
		</div>
	`;
	document.body.appendChild( frame );

	try {
		expectModalPaint(
			frame,
			frame.querySelector( '.components-modal__header' ),
			frame.querySelector( '.components-modal__header-heading' ),
			frame.querySelector( 'button' )
		);
	} finally {
		frame.remove();
	}
} );
