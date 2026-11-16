/**
 * A DataViewsList list row a reader reads, in a list that picks nothing,
 * takes no wash on hover or focus-within; a picker's row keeps the skin's
 * hover fill, so it reads as a control. Both keep the button DataViews lays
 * over each row, which names the row and moves between rows by arrow key.
 * Every state keeps the skin's ink on the row's text: a picked row keeps the
 * skin's hover fill and ink even while focus is inside it, where stock paints
 * `#1e1e1e` at a weight our rule must beat on its own.
 *
 * The stock sheet is read AFTER ours, as a page may load it, so a tie loses.
 * jsdom cannot read `:focus-within`, so a class of equal weight stands in,
 * and so for `:focus` and `:focus-visible`. A `::before` is read as a child
 * element, a class in the pseudo-element's place in every rule alike.
 *
 * A row button focused from the keyboard wears one ring, the shared focus
 * contract's outline in the skin's ink; stock's inset `::before` ring in the
 * admin accent is gone.
 */

import fs from 'fs';
import path from 'path';
import * as sass from 'sass';
import postcss from 'postcss';
import { fireEvent, render, screen } from '@testing-library/react';
import DataViewsList from '../../components/DataViewsList';

const { winning } = require( '../../../build-kit/css-reader.cjs' );

const ROOT = path.resolve( __dirname, '../../../..' );
const STOCK = path.join(
	ROOT,
	'node_modules/@wordpress/dataviews/build-style/style.css'
);
const UI = path.join( ROOT, 'src/ui/newspack-nodes-ui.scss' );
if ( ! fs.existsSync( STOCK ) ) {
	throw new Error(
		`no stock DataViews stylesheet at ${ STOCK }; run npm ci in newspack-nodes`
	);
}

const FOCUS_WITHIN = '.is-focus-within-4417';
const FOCUS_VISIBLE = '.is-focus-visible-4417';
const FOCUSED = '.is-focused-4417';
const BEFORE = 'css-before-4417';
const read = ( css, from ) =>
	postcss.parse(
		css
			.replaceAll( ':focus-within', FOCUS_WITHIN )
			.replaceAll( ':focus-visible', FOCUS_VISIBLE )
			.replace( /:focus(?![-\w])/g, FOCUSED )
			.replace( /::?before\b/g, ` > .${ BEFORE }` ),
		{ from }
	);
const stock = read( fs.readFileSync( STOCK, 'utf8' ), STOCK );
stock.each( ( node ) => {
	if (
		'rule' !== node.type ||
		! /dataviews-(?:view-list|title-field)/.test( node.selector )
	) {
		node.remove();
	}
} );
const SHEETS = [ read( sass.compile( UI ).css, UI ), stock ];

const INK = 'var(--ink, var(--np-text))';
const HERON = { slug: 'heron-53', title: 'Heron Gazette moves to weekly' };
const OTTER = { slug: 'otter-81', title: 'Otter Ledger adds a night desk' };

const Story = ( { item } ) => (
	<div>
		<a href={ `#${ item.slug }` }>{ item.title }</a>
		<p>{ `Summary of ${ item.slug }` }</p>
	</div>
);

const list = ( over = {} ) => (
	<div className="newspack-nodes-ui">
		<DataViewsList
			items={ [ HERON, OTTER ] }
			view={ { type: 'list', page: 1, perPage: 5 } }
			onChangeView={ () => {} }
			empty={ null }
			paginationInfo={ { totalItems: 2, totalPages: 1 } }
			getItemId={ ( item ) => item.slug }
			render={ Story }
			{ ...over }
		/>
	</div>
);

const rowOf = ( title ) =>
	screen.getByRole( 'link', { name: title } ).closest( 'div[role="row"]' );

/**
 * The paint a row's states win, read where each reaches the text.
 *
 * @param {Element}  row     The row.
 * @param {?Element} hovered What the pointer rests on.
 * @return {Object} The row's and its wrapper's fill, and the title's ink.
 */
const paint = ( row, hovered = null ) => {
	const options = hovered ? { hovered } : {};
	const wrapper = row.querySelector( '.dataviews-view-list__item-wrapper' );
	const title = row.querySelector( '.dataviews-title-field' );
	return {
		row: winning( row, 'background-color', SHEETS, options ),
		wrapper: winning( wrapper, 'background-color', SHEETS, options ),
		wrapperInk: winning( wrapper, 'color', SHEETS, options ),
		title: winning( title, 'color', SHEETS, options ),
		link: winning( title.querySelector( 'a' ), 'color', SHEETS, options ),
	};
};

const noWash = ( value ) =>
	expect( [ undefined, 'transparent' ] ).toContain( value );

describe( 'a DataViewsList list row', () => {
	beforeAll( () => {
		// jsdom has no scrollIntoView, which DataViews calls on a picked row.
		window.HTMLElement.prototype.scrollIntoView = () => {};
	} );
	afterAll( () => {
		delete window.HTMLElement.prototype.scrollIntoView;
	} );

	const PICKER = { selection: [ OTTER.slug ], onChangeSelection: () => {} };
	const FILL = 'var(--hover, var(--np-surface-muted))';

	it( 'keeps the row button drawn, picked or not', async () => {
		for ( const over of [ {}, PICKER ] ) {
			const { unmount } = render( list( over ) );
			await screen.findByRole( 'link', { name: HERON.title } );
			const button = rowOf( HERON.title ).querySelector(
				'.dataviews-view-list__item'
			);
			expect( winning( button, 'display', SHEETS ) ).not.toBe( 'none' );
			unmount();
		}
	} );

	it( 'washes no row of a list that picks nothing on hover, and keeps the skin’s ink', async () => {
		render( list() );
		await screen.findByRole( 'link', { name: HERON.title } );
		const row = rowOf( HERON.title );
		const hovered = paint( row, row );
		noWash( hovered.row );
		expect( hovered.title ).toBe( INK );
		expect( hovered.link ).toBe( INK );

		fireEvent.mouseEnter( row );
		expect( row.classList.contains( 'is-hovered' ) ).toBe( true );
		const marked = paint( row );
		noWash( marked.row );
		expect( marked.title ).toBe( INK );
	} );

	it( 'washes no row of a list that picks nothing while focus is inside it', async () => {
		render( list() );
		await screen.findByRole( 'link', { name: HERON.title } );
		const row = rowOf( HERON.title );
		row.classList.add( FOCUS_WITHIN.slice( 1 ) );
		const focused = paint( row );
		noWash( focused.row );
		expect( focused.title ).toBe( INK );
		expect( focused.link ).toBe( INK );
	} );

	it( 'fills a picker’s row on hover and focus in the skin, keeping its ink', async () => {
		render( list( PICKER ) );
		await screen.findByRole( 'link', { name: HERON.title } );
		const row = rowOf( HERON.title );
		const hovered = paint( row, row );
		expect( hovered.row ).toBe( FILL );
		expect( hovered.title ).toBe( INK );
		expect( hovered.link ).toBe( INK );

		fireEvent.mouseEnter( row );
		expect( paint( row ).row ).toBe( FILL );
		fireEvent.mouseLeave( row );

		row.classList.add( FOCUS_WITHIN.slice( 1 ) );
		const focused = paint( row );
		expect( focused.row ).toBe( FILL );
		expect( focused.title ).toBe( INK );
	} );

	it( 'rings a keyboard-focused row button once, in the contract’s ink', async () => {
		render( list() );
		await screen.findByRole( 'link', { name: HERON.title } );
		const button = rowOf( HERON.title ).querySelector(
			'.dataviews-view-list__item'
		);
		button.classList.add( FOCUSED.slice( 1 ), FOCUS_VISIBLE.slice( 1 ) );
		const before = document.createElement( 'i' );
		before.className = BEFORE;
		button.append( before );
		const shadow = winning( before, 'box-shadow', SHEETS );
		expect( [ undefined, 'none' ] ).toContain( shadow );
		expect( winning( button, 'outline-style', SHEETS ) ).toBe( 'solid' );
		expect( winning( button, 'outline-width', SHEETS ) ).toBe( '2px' );
		expect( winning( button, 'outline-color', SHEETS ) ).toBe(
			'var(--ink, var(--np-text, currentcolor))'
		);
		// The list's scroller shares the button's sides, so an outset ring clips.
		expect( winning( button, 'outline-offset', SHEETS ) ).toBe( '-2px' );
		// The halo hugs the ring from inside, where the scroller can't clip it.
		expect( winning( button, 'box-shadow', SHEETS ) ).toBe(
			'inset 0 0 0 3px var(--focus-halo, var(--paper, var(--np-surface)))'
		);
	} );

	it( 'keeps a picked row in the skin’s fill and ink, focus inside it or not', async () => {
		render(
			list( { selection: [ HERON.slug ], onChangeSelection: () => {} } )
		);
		await screen.findByRole( 'link', { name: HERON.title } );
		const row = rowOf( HERON.title );
		expect( row.classList.contains( 'is-selected' ) ).toBe( true );
		for ( const within of [ false, true ] ) {
			row.classList.toggle( FOCUS_WITHIN.slice( 1 ), within );
			const picked = paint( row );
			expect( picked.wrapper ).toBe(
				'var(--hover, var(--np-surface-muted))'
			);
			expect( picked.wrapperInk ).toBe( INK );
			expect( picked.title ).toBe( INK );
			expect( picked.link ).toBe( INK );
		}
	} );
} );
