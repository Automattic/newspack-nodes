/**
 * DataViewsList is the one DataViews list a dashboard draws: each item by the
 * row component the caller names, in the layout the view names; the caller's
 * empty words in place of DataViews' own; and a pager reading
 * "Page %1$d of %2$d" only when there is a second page.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from '@wordpress/element';
import DataViewsList from '../DataViewsList';

const HERON = { slug: 'heron-7', title: 'Heron Gazette moves to weekly' };
const OTTER = { slug: 'otter-2', title: 'Otter Ledger adds a night desk' };

const view = ( over = {} ) => ( {
	type: 'list',
	page: 3,
	perPage: 7,
	...over,
} );

/**
 * A row naming its item, so a test reads which row component drew it.
 *
 * @param {Object} props
 * @param {Object} props.item The item.
 * @param {string} props.tone A row prop the caller passed through.
 * @return {import('react').ReactElement} The row.
 */
const Plain = ( { item, tone } ) => (
	<span>{ `${ tone }: ${ item.title }` }</span>
);

const list = ( over = {} ) => (
	<DataViewsList
		items={ [ HERON ] }
		view={ view( { page: 1 } ) }
		onChangeView={ () => {} }
		empty="Nothing on the wire."
		paginationInfo={ { totalItems: 1, totalPages: 1 } }
		getItemId={ ( item ) => item.slug }
		render={ Plain }
		rowProps={ { tone: 'Dry' } }
		{ ...over }
	/>
);

describe( 'DataViewsList', () => {
	it( 'draws each item through the row the caller names, with its row props', async () => {
		render( list( { items: [ HERON, OTTER ] } ) );
		expect(
			await screen.findByText( 'Dry: Heron Gazette moves to weekly' )
		).toBeTruthy();
		expect(
			screen.getByText( 'Dry: Otter Ledger adds a night desk' )
		).toBeTruthy();
	} );

	it( 'an empty list shows its own words and no pager', async () => {
		render(
			list( {
				items: [],
				paginationInfo: { totalItems: 0, totalPages: 0 },
			} )
		);
		expect(
			await screen.findByText( 'Nothing on the wire.' )
		).toBeTruthy();
		expect( screen.queryByText( 'No results' ) ).toBeNull();
		expect( screen.queryByText( /Page/ ) ).toBeNull();
	} );

	it( 'shows no pager at one page', async () => {
		render( list() );
		await screen.findByText( /Heron Gazette/ );
		expect( screen.queryByText( /Page/ ) ).toBeNull();
	} );

	it( 'pages through the view, reading its page of the total', async () => {
		const onChangeView = jest.fn();
		render(
			list( {
				items: [ HERON, OTTER ],
				view: view(),
				onChangeView,
				paginationInfo: { totalItems: 33, totalPages: 5 },
			} )
		);
		expect( await screen.findByText( 'Page 3 of 5' ) ).toBeTruthy();
		fireEvent.click( screen.getByRole( 'button', { name: 'Next' } ) );
		expect( onChangeView ).toHaveBeenLastCalledWith(
			expect.objectContaining( { page: 4, perPage: 7 } )
		);
		fireEvent.click( screen.getByRole( 'button', { name: 'Previous' } ) );
		expect( onChangeView ).toHaveBeenLastCalledWith(
			expect.objectContaining( { page: 2 } )
		);
	} );

	it( 'offers Previous only past the first page and Next only before the last', async () => {
		render( list( { paginationInfo: { totalItems: 9, totalPages: 2 } } ) );
		expect( await screen.findByText( 'Page 1 of 2' ) ).toBeTruthy();
		expect(
			screen.queryByRole( 'button', { name: 'Previous' } )
		).toBeNull();
		expect( screen.getByRole( 'button', { name: 'Next' } ) ).toBeTruthy();
	} );

	it( 'heads its row column by the label the caller names, else "Item"', async () => {
		const table = ( label ) =>
			list( {
				view: view( { type: 'table', page: 1 } ),
				layout: 'table',
				label,
			} );
		const heads = () =>
			screen
				.getAllByRole( 'columnheader' )
				.map( ( one ) => one.textContent );
		const { rerender } = render( table( 'Desk' ) );
		await screen.findByText( /Heron Gazette/ );
		expect( heads() ).toContain( 'Desk' );
		expect( heads() ).not.toContain( 'Item' );

		rerender( table( undefined ) );
		expect( heads() ).toContain( 'Item' );
	} );

	it( 'passes its actions through to each row', async () => {
		const callback = jest.fn();
		render(
			list( {
				actions: [
					{
						id: 'pin',
						label: 'Pin to the desk',
						isPrimary: true,
						callback,
					},
				],
			} )
		);
		fireEvent.click(
			await screen.findByRole( 'button', { name: 'Pin to the desk' } )
		);
		expect( callback ).toHaveBeenCalledWith( [ HERON ], expect.anything() );
	} );

	it( 'keeps each row mounted across a render of the list', async () => {
		const Counting = ( { item } ) => {
			const [ taps, setTaps ] = useState( 0 );
			return (
				<button onClick={ () => setTaps( taps + 1 ) }>
					{ `${ item.title }: ${ taps } taps` }
				</button>
			);
		};
		const { rerender } = render( list( { render: Counting } ) );
		fireEvent.click(
			await screen.findByText( /Heron Gazette moves to weekly: 0 taps/ )
		);
		rerender( list( { render: Counting, rowProps: { tone: 'Wet' } } ) );
		expect(
			screen.getByText( /Heron Gazette moves to weekly: 1 taps/ )
		).toBeTruthy();
	} );

	it( 'leads a view stranded past the last page back to it', async () => {
		const onChangeView = jest.fn();
		render(
			list( {
				items: [],
				view: view( { page: 4 } ),
				onChangeView,
				paginationInfo: { totalItems: 3, totalPages: 1 },
			} )
		);
		fireEvent.click(
			await screen.findByRole( 'button', { name: 'Previous' } )
		);
		expect( onChangeView ).toHaveBeenLastCalledWith(
			expect.objectContaining( { page: 1 } )
		);
		expect( screen.queryByRole( 'button', { name: 'Next' } ) ).toBeNull();
	} );

	it( 'counts at least one page for a view stranded over an empty result', async () => {
		render(
			list( {
				items: [],
				view: view( { page: 3 } ),
				paginationInfo: { totalItems: 0, totalPages: 0 },
			} )
		);
		expect( await screen.findByText( 'Page 3 of 1' ) ).toBeTruthy();
	} );

	it( 'refuses to check rows without the selection that holds them', () => {
		const quiet = jest
			.spyOn( console, 'error' )
			.mockImplementation( () => {} );
		try {
			expect( () =>
				render(
					list( { selectLabel: ( item ) => `Pick ${ item.slug }` } )
				)
			).toThrow( /selectLabel.*selection.*onChangeSelection/ );
		} finally {
			quiet.mockRestore();
		}
	} );

	it( 'checks rows into a run through a checkbox named for each row', async () => {
		// jsdom has no scrollIntoView, which DataViews calls on a checked row.
		window.HTMLElement.prototype.scrollIntoView = () => {};
		const onChangeSelection = jest.fn();
		const checked = ( selection ) =>
			list( {
				items: [ HERON, OTTER ],
				selection,
				onChangeSelection,
				selectLabel: ( item ) => `Pick ${ item.slug }`,
			} );
		const { rerender } = render( checked( [] ) );
		fireEvent.click(
			await screen.findByRole( 'checkbox', { name: 'Pick otter-2' } )
		);
		expect( onChangeSelection ).toHaveBeenLastCalledWith( [ 'otter-2' ] );

		rerender( checked( [ 'heron-7', 'otter-2' ] ) );
		fireEvent.click(
			screen.getByRole( 'checkbox', { name: 'Pick heron-7' } )
		);
		expect( onChangeSelection ).toHaveBeenLastCalledWith( [ 'otter-2' ] );
		delete window.HTMLElement.prototype.scrollIntoView;
	} );

	it( 'hides the row actions of a checked list, which act on the run alone', async () => {
		const { container, rerender } = render( list() );
		await screen.findByText( /Heron Gazette/ );
		expect(
			container.querySelector( '.newspack-nodes-dataviews__run-only' )
		).toBeNull();

		rerender(
			list( {
				selection: [],
				onChangeSelection: () => {},
				selectLabel: ( item ) => `Pick ${ item.slug }`,
			} )
		);
		expect(
			container.querySelector( '.newspack-nodes-dataviews__run-only' )
		).not.toBeNull();
	} );

	it( 'draws no checkbox for a list that checks no rows', async () => {
		render( list() );
		await screen.findByText( /Heron Gazette/ );
		expect( screen.queryByRole( 'checkbox', { name: /Pick/ } ) ).toBeNull();
	} );

	it( 'stands the header above the list, inside the DataViews it reads', async () => {
		render( list( { header: <span>Kea filters 3301</span> } ) );
		expect( await screen.findByText( 'Kea filters 3301' ) ).toBeTruthy();
	} );
} );
