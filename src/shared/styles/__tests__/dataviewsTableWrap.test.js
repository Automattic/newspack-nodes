/**
 * A DataViewsList table fits its container: every cell wraps its text, which
 * the stock DataViews rules hold to one line, breaking a word only where it
 * cannot fit, and only the title may break one mid-way, so an unbroken URL
 * never widens the table. Stock gives every other column 1%, so each keeps
 * its content width, and the title column, which declares none, takes the
 * rest. jsdom lays nothing out, so these are the declarations that decide
 * the layout; a headless render of the same table measures it.
 */

import fs from 'fs';
import path from 'path';
import * as sass from 'sass';
import postcss from 'postcss';
import { render, screen } from '@testing-library/react';
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
// The stock rules a table's cells meet; jsdom cannot read every other selector.
const stock = postcss.parse( fs.readFileSync( STOCK, 'utf8' ), {
	from: STOCK,
} );
stock.each( ( node ) => {
	if (
		'rule' !== node.type ||
		! /dataviews-(?:view-table|title-field)/.test( node.selector )
	) {
		node.remove();
	}
} );
const SHEETS = [ stock, postcss.parse( sass.compile( UI ).css, { from: UI } ) ];

const LONG =
	'Kestrel Weekly reorganizes its regional desks across nine counties and two ' +
	'languages, with a night editor for every bureau and a new standards lead';

const FIELDS = [
	{
		id: 'headline',
		label: 'Headline 3318',
		enableHiding: false,
		enableSorting: false,
		render: ( { item } ) => <a href="#kestrel">{ item.title }</a>,
	},
	{
		id: 'beat',
		label: 'Beat 7702',
		enableHiding: false,
		enableSorting: false,
		render: ( { item } ) => item.beat,
	},
];

const table = ( columns ) => (
	<div className="newspack-nodes-ui">
		<DataViewsList
			items={ [
				{
					id: 'kestrel-9',
					title: LONG,
					beat: 'Regional desks and bureaus 4471',
				},
			] }
			view={ { type: 'table', page: 1, perPage: 5, fields: [ 'beat' ] } }
			onChangeView={ () => {} }
			layout="table"
			empty={ null }
			paginationInfo={ { totalItems: 1, totalPages: 1 } }
			render={ ( { item } ) => item.title }
			fields={ FIELDS }
			columns={ columns }
		/>
	</div>
);

const wins = ( element, longhand ) => winning( element, longhand, SHEETS );

describe( 'a DataViewsList table', () => {
	it( 'wraps a long title, its link and every other cell', async () => {
		render( table( [ 'headline', 'beat' ] ) );
		const link = await screen.findByRole( 'link', { name: LONG } );
		const title = link.closest( '.dataviews-title-field' );
		const beat = screen
			.getByText( 'Regional desks and bureaus 4471' )
			.closest( '.dataviews-view-table__cell-content-wrapper' );
		for ( const element of [ title, link, beat ] ) {
			expect( wins( element, 'white-space' ) ).toBe( 'normal' );
		}
	} );

	it( 'breaks a word mid-way only in the title, where it cannot fit', async () => {
		render( table( [ 'headline', 'beat' ] ) );
		const link = await screen.findByRole( 'link', { name: LONG } );
		const title = link.closest( '.dataviews-title-field' );
		const beat = screen
			.getByText( 'Regional desks and bureaus 4471' )
			.closest( '.dataviews-view-table__cell-content-wrapper' );
		expect( wins( title, 'overflow-wrap' ) ).toBe( 'anywhere' );
		expect( wins( link, 'overflow-wrap' ) ).toBe( 'anywhere' );
		expect( wins( beat, 'overflow-wrap' ) ).toBe( 'break-word' );
	} );

	it( 'wraps the row a table without columns draws as its title', async () => {
		render( table( undefined ) );
		const row = ( await screen.findByText( LONG ) ).closest(
			'.dataviews-view-table__cell-content-wrapper'
		);
		expect( wins( row, 'white-space' ) ).toBe( 'normal' );
	} );

	it( 'sizes its other columns to their content, leaving the title the rest', async () => {
		render( table( [ 'headline', 'beat' ] ) );
		await screen.findByRole( 'link', { name: LONG } );
		const cols = [
			...document.querySelectorAll( '.dataviews-view-table col' ),
		];
		const title = document.querySelector(
			'.dataviews-view-table__col-first-data'
		);
		expect( wins( title, 'width' ) ).toBeUndefined();
		const others = cols.filter( ( col ) => col !== title );
		expect( others.length ).toBeGreaterThan( 0 );
		for ( const col of others ) {
			expect( wins( col, 'width' ) ).toBe( '1%' );
		}
	} );

	it( 'sets no width on the table wider than its container', async () => {
		render( table( [ 'headline', 'beat' ] ) );
		await screen.findByRole( 'link', { name: LONG } );
		const element = document.querySelector( '.dataviews-view-table' );
		expect( wins( element, 'width' ) ).toBe( '100%' );
		expect( wins( element, 'min-width' ) ).toBeUndefined();
		for ( const one of element.querySelectorAll( 'table, col, th, td' ) ) {
			expect( one.style.width ).toBe( '' );
			expect( one.style.minWidth ).toBe( '' );
		}
	} );
} );
