/**
 * A composed page's section header and loading bars are laid out by the
 * shared sheet alone: the header a wrapping flex row with its actions at the
 * end of the line and its heading and description margins set, each skeleton
 * bar one line tall and as wide as the part it stands for.
 */

import path from 'path';
import * as sass from 'sass';
import postcss from 'postcss';

const { winning } = require( '../../../build-kit/css-reader.cjs' );

const ROOT = path.resolve( __dirname, '../../../..' );
const UI = path.join( ROOT, 'src/ui/newspack-nodes-ui.scss' );
const SHEETS = [ postcss.parse( sass.compile( UI ).css, { from: UI } ) ];

const wins = ( element, longhand ) => winning( element, longhand, SHEETS );

// The reader does not model `gap`, so read it off the rule that declares it.
const gapOf = ( selector ) => {
	let gap;
	SHEETS[ 0 ].walkRules( ( rule ) => {
		if ( rule.selector.endsWith( selector ) ) {
			rule.walkDecls( 'gap', ( decl ) => {
				gap = decl.value;
			} );
		}
	} );
	return gap;
};

describe( 'the composed section header', () => {
	let head;
	let actions;
	let title;
	let description;

	beforeEach( () => {
		document.body.innerHTML = `
			<div class="newspack-nodes-ui newspack-nodes-theme newspack-nodes-skin-root">
				<div class="newspack-nodes-composed-section-head newspack-nodes-section-heading">
					<div>
						<h2>Gullwing desk</h2>
						<p class="newspack-nodes-status is-muted">Tides</p>
					</div>
					<div class="newspack-nodes-composed-section-actions"></div>
				</div>
			</div>`;
		head = document.querySelector(
			'.newspack-nodes-composed-section-head'
		);
		actions = document.querySelector(
			'.newspack-nodes-composed-section-actions'
		);
		title = head.querySelector( 'h2' );
		description = head.querySelector( 'p' );
	} );

	it( 'is a wrapping flex row that parts its title from its actions', () => {
		expect( wins( head, 'display' ) ).toBe( 'flex' );
		expect( wins( head, 'flex-wrap' ) ).toBe( 'wrap' );
		expect( wins( head, 'align-items' ) ).toBe( 'center' );
		expect( wins( head, 'justify-content' ) ).toBe( 'space-between' );
		expect( gapOf( '.newspack-nodes-composed-section-head' ) ).toBe(
			'8px'
		);
		expect( wins( head, 'margin-bottom' ) ).toBe( '8px' );
	} );

	it( 'sets the heading flush and the description a short step under it', () => {
		expect( wins( title, 'margin-top' ) ).toBe( '0' );
		expect( wins( title, 'margin-bottom' ) ).toBe( '0' );
		expect( wins( description, 'margin-top' ) ).toBe( '4px' );
		expect( wins( description, 'margin-bottom' ) ).toBe( '0' );
	} );

	it( 'lays its actions in a wrapping flex row', () => {
		expect( wins( actions, 'display' ) ).toBe( 'flex' );
		expect( wins( actions, 'flex-wrap' ) ).toBe( 'wrap' );
		expect( wins( actions, 'align-items' ) ).toBe( 'center' );
		expect( gapOf( '.newspack-nodes-composed-section-actions' ) ).toBe(
			'8px'
		);
	} );
} );

describe( 'the skeleton bars', () => {
	it.each( [
		[ 'title', '60%' ],
		[ 'meta', '35%' ],
		[ 'summary', '90%' ],
		[ 'line', '80%' ],
	] )( 'sizes a %s bar to one line tall and %s wide', ( part, width ) => {
		document.body.innerHTML = `
			<div class="newspack-nodes-ui newspack-nodes-theme newspack-nodes-skin-root">
				<span class="newspack-nodes-skeleton newspack-nodes-skeleton--${ part }"></span>
			</div>`;
		const bar = document.querySelector( '.newspack-nodes-skeleton' );
		expect( wins( bar, 'display' ) ).toBe( 'inline-block' );
		expect( wins( bar, 'height' ) ).toBe( '1em' );
		expect( wins( bar, 'width' ) ).toBe( width );
	} );
} );

describe( 'the skeleton rows', () => {
	let list;
	let paragraph;

	beforeEach( () => {
		document.body.innerHTML = `
			<div class="newspack-nodes-ui newspack-nodes-theme newspack-nodes-skin-root">
				<ul class="newspack-nodes-composed-skeleton-rows">
					<li><p></p></li>
				</ul>
			</div>`;
		list = document.querySelector(
			'.newspack-nodes-composed-skeleton-rows'
		);
		paragraph = list.querySelector( 'p' );
	} );

	it( 'resets the list and stacks its rows in a column', () => {
		expect( wins( list, 'margin-top' ) ).toBe( '0' );
		expect( wins( list, 'margin-bottom' ) ).toBe( '0' );
		expect( wins( list, 'padding-left' ) ).toBe( '0' );
		expect( wins( list, 'list-style-type' ) ).toBe( 'none' );
		expect( wins( list, 'display' ) ).toBe( 'flex' );
		expect( wins( list, 'flex-direction' ) ).toBe( 'column' );
		expect( gapOf( '.newspack-nodes-composed-skeleton-rows' ) ).toBe(
			'16px'
		);
	} );

	it( 'sets a row paragraph a short step from its neighbours', () => {
		expect( wins( paragraph, 'margin-top' ) ).toBe( '4px' );
		expect( wins( paragraph, 'margin-bottom' ) ).toBe( '4px' );
	} );
} );
