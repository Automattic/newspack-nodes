/**
 * DataViewsList is the one DataViews list a dashboard draws: each item by the
 * row component the caller names, in the layout the view names; the caller's
 * empty words in place of DataViews' own; and a pager reading
 * "Page %1$d of %2$d" only when there is a second page.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { Popover } from '@wordpress/components';
import { DataViews } from '@wordpress/dataviews';
import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from '@wordpress/element';
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

	it( 'pages through stock buttons, not WordPress components', async () => {
		render(
			list( {
				view: view( { page: 2 } ),
				paginationInfo: { totalItems: 19, totalPages: 4 },
			} )
		);
		await screen.findByText( 'Page 2 of 4' );
		for ( const name of [ 'Previous', 'Next' ] ) {
			const button = screen.getByRole( 'button', { name } );
			expect( button.className ).toBe( 'button' );
			expect( button.getAttribute( 'type' ) ).toBe( 'button' );
		}
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

	describe( 'a table drawn by its columns', () => {
		const DESK = {
			id: 'desk',
			label: 'Desk 4410',
			enableHiding: false,
			enableSorting: false,
			render: ( { item } ) => (
				<a href="#desk">{ `Desk of ${ item.slug }` }</a>
			),
		};
		const BEAT = {
			id: 'beat',
			label: 'Beat 2207',
			enableHiding: false,
			enableSorting: false,
			render: ( { item } ) => `Beat of ${ item.slug }`,
		};
		const RANK = {
			id: 'rank',
			label: 'Rank 6093',
			enableHiding: false,
			render: ( { item } ) => `Rank of ${ item.slug }`,
		};
		const columned = ( over = {} ) =>
			list( {
				items: [ HERON, OTTER ],
				layout: [ 'list', 'table' ],
				view: view( { type: 'table', page: 1, fields: [] } ),
				fields: [ DESK, BEAT, RANK ],
				columns: [ 'desk', 'beat', 'rank' ],
				...over,
			} );
		const heads = () =>
			screen
				.getAllByRole( 'columnheader' )
				.map( ( one ) => one.textContent.trim() );

		it( 'heads one column per field it names, in order, the first the title', async () => {
			render( columned() );
			await screen.findByText( 'Desk of heron-7' );
			expect( heads() ).toEqual( [
				'Desk 4410',
				'Beat 2207',
				'Rank 6093',
			] );
			const cells = screen
				.getAllByRole( 'row' )[ 1 ]
				.querySelectorAll( 'td' );
			expect( [ ...cells ].map( ( one ) => one.textContent ) ).toEqual( [
				'Desk of heron-7',
				'Beat of heron-7',
				'Rank of heron-7',
			] );
		} );

		it( 'draws no row in the table, where the columns stand in its place', async () => {
			render( columned() );
			await screen.findByText( 'Desk of otter-2' );
			expect( screen.queryByText( /^Dry: / ) ).toBeNull();
			expect( heads() ).not.toContain( 'Item' );
		} );

		it( 'draws the row in the list layout, the columns aside', async () => {
			render( columned( { view: view( { type: 'list', page: 1 } ) } ) );
			expect(
				await screen.findByText( 'Dry: Heron Gazette moves to weekly' )
			).toBeTruthy();
			expect( screen.queryByText( 'Beat of heron-7' ) ).toBeNull();
		} );

		it( 'sorts through the header of a column that sorts', async () => {
			const onChangeView = jest.fn();
			render( columned( { onChangeView } ) );
			await screen.findByText( 'Rank of heron-7' );
			fireEvent.click(
				screen.getByRole( 'button', { name: 'Rank 6093' } )
			);
			fireEvent.click(
				await screen.findByRole( 'menuitemradio', {
					name: 'Sort descending',
				} )
			);
			expect( onChangeView ).toHaveBeenLastCalledWith(
				expect.objectContaining( {
					sort: { field: 'rank', direction: 'desc' },
				} )
			);
			expect( onChangeView.mock.calls.at( -1 )[ 0 ].titleField ).toBe(
				undefined
			);
		} );

		it( 'keeps the view the caller holds, whose fields the table never writes', async () => {
			const onChangeView = jest.fn();
			render(
				columned( {
					onChangeView,
					paginationInfo: { totalItems: 9, totalPages: 2 },
				} )
			);
			await screen.findByText( 'Rank of heron-7' );
			fireEvent.click( screen.getByRole( 'button', { name: 'Next' } ) );
			expect( onChangeView ).toHaveBeenLastCalledWith( {
				type: 'table',
				page: 2,
				perPage: 7,
				fields: [],
			} );
		} );

		it( 'hands each column its row props beside the item, as the row takes them', async () => {
			const TONED = {
				...BEAT,
				render: ( { item, tone } ) =>
					`${ tone } beat of ${ item.slug }`,
			};
			render( columned( { fields: [ DESK, TONED, RANK ] } ) );
			expect(
				await screen.findByText( 'Dry beat of otter-2' )
			).toBeTruthy();
		} );

		it( 'keeps a layout change the table makes, moving aside', async () => {
			const onChangeView = jest.fn();
			// jsdom has no ResizeObserver, which the density control reads.
			window.ResizeObserver = class {
				observe() {}
				unobserve() {}
				disconnect() {}
			};
			try {
				render(
					columned( {
						onChangeView,
						view: view( {
							type: 'table',
							page: 1,
							layout: { enableMoving: true },
						} ),
						header: <DataViews.ViewConfig />,
					} )
				);
				await screen.findByText( 'Desk of heron-7' );
				fireEvent.click(
					screen.getByRole( 'button', { name: 'View options' } )
				);
				fireEvent.click(
					await screen.findByRole( 'radio', { name: 'Compact' } )
				);
			} finally {
				delete window.ResizeObserver;
			}
			expect( onChangeView.mock.calls.at( -1 )[ 0 ].layout ).toEqual( {
				enableMoving: true,
				density: 'compact',
			} );
		} );

		it( 'hands its actions each row of the table', async () => {
			const callback = jest.fn();
			render(
				columned( {
					actions: [
						{
							id: 'pin',
							label: 'Pin 5521',
							isPrimary: true,
							callback,
						},
					],
				} )
			);
			await screen.findByText( 'Desk of otter-2' );
			fireEvent.click(
				screen.getAllByRole( 'button', { name: 'Pin 5521' } )[ 1 ]
			);
			expect( callback ).toHaveBeenCalledWith(
				[ OTTER ],
				expect.anything()
			);
		} );
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

	describe( 'a checked run', () => {
		const KEA = { slug: 'kea-4', title: 'Kea Courier hires two reporters' };
		const WREN = {
			slug: 'wren-9',
			title: 'Wren Weekly folds its print run',
		};
		const FOUR = [ HERON, OTTER, KEA, WREN ];
		const ELSEWHERE = 'other-page-id';
		const bulk = [
			{
				id: 'file',
				label: 'File the run',
				supportsBulk: true,
				callback: () => {},
			},
		];

		let scrolled;

		beforeEach( () => {
			// jsdom has no scrollIntoView; record any call DataViews makes.
			scrolled = jest.fn();
			window.HTMLElement.prototype.scrollIntoView = scrolled;
		} );

		afterEach( () => {
			delete window.HTMLElement.prototype.scrollIntoView;
		} );

		const run = ( selection, onChangeSelection, over = {} ) =>
			list( {
				items: FOUR,
				selection,
				onChangeSelection,
				selectLabel: ( item ) => `Pick ${ item.slug }`,
				actions: bulk,
				...over,
			} );

		/**
		 * A one-row page whose run holds a row checked on another page.
		 *
		 * @param {string[]}  selection         The run.
		 * @param {jest.Mock} onChangeSelection Takes the run changed.
		 * @return {import('react').ReactElement} The list.
		 */
		const lone = ( selection, onChangeSelection ) =>
			run( selection, onChangeSelection, {
				items: [ HERON ],
				paginationInfo: { totalItems: 2, totalPages: 2 },
			} );

		it( 'keeps three checked rows when the body of a fourth row is clicked', async () => {
			const onChangeSelection = jest.fn();
			const { container } = render(
				run( [ 'heron-7', 'otter-2', 'kea-4' ], onChangeSelection )
			);
			await screen.findByText( /Wren Weekly/ );
			const bodies = container.querySelectorAll(
				'.dataviews-view-list__item'
			);
			expect( bodies ).toHaveLength( 4 );
			fireEvent.click( bodies[ 3 ] );

			expect( onChangeSelection ).not.toHaveBeenCalled();
			for ( const slug of [ 'heron-7', 'otter-2', 'kea-4' ] ) {
				expect(
					screen.getByRole( 'checkbox', { name: `Pick ${ slug }` } )
						.checked
				).toBe( true );
			}
			expect(
				screen.getByRole( 'checkbox', { name: 'Pick wren-9' } ).checked
			).toBe( false );
		} );

		it( "leaves the run alone when a one-row page's row body is clicked", async () => {
			const onChangeSelection = jest.fn();
			const { container } = render(
				lone( [ ELSEWHERE ], onChangeSelection )
			);
			await screen.findByText( /Heron Gazette/ );
			fireEvent.click(
				container.querySelector( '.dataviews-view-list__item' )
			);
			expect( onChangeSelection ).not.toHaveBeenCalled();
		} );

		it( "adds this page's rows to the run through select-all, keeping the rest", async () => {
			const onChangeSelection = jest.fn();
			render( lone( [ ELSEWHERE ], onChangeSelection ) );
			fireEvent.click(
				await screen.findByRole( 'checkbox', { name: 'Select all' } )
			);
			expect( onChangeSelection ).toHaveBeenLastCalledWith( [
				ELSEWHERE,
				'heron-7',
			] );
		} );

		it( "takes only this page's rows out through deselect-all", async () => {
			const onChangeSelection = jest.fn();
			render( lone( [ ELSEWHERE, 'heron-7' ], onChangeSelection ) );
			fireEvent.click(
				await screen.findByRole( 'checkbox', { name: 'Deselect all' } )
			);
			expect( onChangeSelection ).toHaveBeenLastCalledWith( [
				ELSEWHERE,
			] );
		} );

		it( 'counts a run held on this page alone without naming the page', async () => {
			render( run( [ 'otter-2', 'kea-4' ], () => {} ) );
			expect(
				await screen.findByText( '2 Items selected' )
			).toBeTruthy();
		} );

		it( 'takes every row of this page out through deselect-all, one no bulk action takes included', async () => {
			const onChangeSelection = jest.fn();
			render(
				run(
					[ 'heron-7', 'otter-2', 'wren-9', 'kea-4', ELSEWHERE ],
					onChangeSelection,
					{
						actions: [
							{
								...bulk[ 0 ],
								isEligible: ( item ) => 'kea-4' !== item.slug,
							},
						],
					}
				)
			);
			fireEvent.click(
				await screen.findByRole( 'checkbox', { name: 'Deselect all' } )
			);
			expect( onChangeSelection ).toHaveBeenLastCalledWith( [
				ELSEWHERE,
			] );
		} );

		it( 'opens a bulk action that renders a modal over the checked rows it is eligible for', async () => {
			render(
				run( [ 'kea-4', 'heron-7', ELSEWHERE ], () => {}, {
					actions: [
						{
							id: 'confirm',
							label: 'Confirm the run',
							supportsBulk: true,
							isEligible: ( item ) => 'kea-4' === item.slug,
							RenderModal: ( { items, closeModal } ) => (
								<button type="button" onClick={ closeModal }>
									{ `Confirm ${ items
										.map( ( item ) => item.slug )
										.join( ' ' ) }` }
								</button>
							),
						},
					],
				} )
			);
			fireEvent.click(
				await screen.findByRole( 'button', { name: 'Confirm the run' } )
			);
			const inside = await screen.findByRole( 'button', {
				name: 'Confirm kea-4',
			} );
			// Portalled to the body, the frame wears the skin roots itself.
			const frame = inside.closest( '.components-modal__frame' );
			for ( const root of [
				'newspack-nodes-modal',
				'newspack-nodes-skin-root',
				'newspack-nodes-theme',
				'newspack-nodes-ui',
			] ) {
				expect( frame.classList ).toContain( root );
			}
			fireEvent.click( inside );
			expect(
				screen.queryByRole( 'button', { name: 'Confirm kea-4' } )
			).toBeNull();
		} );

		it( 'marks select-all indeterminate while only some of the page is in the run', async () => {
			render( run( [ 'otter-2', ELSEWHERE ], () => {} ) );
			const all = await screen.findByRole( 'checkbox', {
				name: 'Select all',
			} );
			expect( all.checked ).toBe( false );
			expect( all.indeterminate ).toBe( true );
		} );

		it( 'offers select-all over the rows a bulk action can act on alone', async () => {
			const onChangeSelection = jest.fn();
			render(
				run( [], onChangeSelection, {
					actions: [
						{
							...bulk[ 0 ],
							isEligible: ( item ) => 'kea-4' !== item.slug,
						},
					],
				} )
			);
			fireEvent.click(
				await screen.findByRole( 'checkbox', { name: 'Select all' } )
			);
			expect( onChangeSelection ).toHaveBeenLastCalledWith( [
				'heron-7',
				'otter-2',
				'wren-9',
			] );
		} );

		it( 'presses no row and scrolls to none while a run is checked', async () => {
			const { container } = render(
				run( [ 'heron-7', 'kea-4' ], () => {} )
			);
			await screen.findByText( /Wren Weekly/ );
			expect(
				container.querySelector( '[aria-pressed="true"]' )
			).toBeNull();
			expect( scrolled ).not.toHaveBeenCalled();
		} );

		it( 'counts the whole run, rows on other pages included', async () => {
			render( run( [ 'otter-2', ELSEWHERE, 'kea-4' ], () => {} ) );
			expect(
				await screen.findByText( '3 Items selected, 2 on this page' )
			).toBeTruthy();
		} );

		it( "hands a bulk action this page's checked rows", async () => {
			const callback = jest.fn();
			render(
				run( [ 'kea-4', ELSEWHERE, 'heron-7' ], () => {}, {
					actions: [ { ...bulk[ 0 ], callback } ],
				} )
			);
			const button = await screen.findByRole( 'button', {
				name: 'File the run',
			} );
			await act( async () => fireEvent.click( button ) );
			expect( callback ).toHaveBeenCalledWith( [ HERON, KEA ] );
		} );

		it( 'hands every bulk action the checked rows any bulk action takes, as the stock toolbar does', async () => {
			const callback = jest.fn();
			render(
				run( [ 'kea-4', 'heron-7' ], () => {}, {
					actions: [
						{ ...bulk[ 0 ], callback: () => {} },
						{
							id: 'pin',
							label: ( items ) => `Pin ${ items.length } rows`,
							supportsBulk: true,
							isEligible: ( item ) => 'kea-4' === item.slug,
							callback,
						},
					],
				} )
			);
			const button = await screen.findByRole( 'button', {
				name: 'Pin 1 rows',
			} );
			await act( async () => fireEvent.click( button ) );
			expect( callback ).toHaveBeenCalledWith( [ HERON, KEA ] );
		} );

		it( 'offers only the bulk actions some checked row is eligible for, named by their rows', async () => {
			render(
				run( [ 'otter-2' ], () => {}, {
					actions: [
						{
							id: 'archive',
							label: ( items ) =>
								`Archive ${ items.length } rows`,
							supportsBulk: true,
							callback: () => {},
						},
						{
							id: 'pin',
							label: 'Pin the kea',
							supportsBulk: true,
							isEligible: ( item ) => 'kea-4' === item.slug,
							callback: () => {},
						},
					],
				} )
			);
			expect(
				await screen.findByRole( 'button', { name: 'Archive 1 rows' } )
			).toBeTruthy();
			expect(
				screen.queryByRole( 'button', { name: 'Pin the kea' } )
			).toBeNull();
		} );

		it( 'shows a bulk action busy until its callback settles', async () => {
			let settle;
			const callback = () =>
				new Promise( ( resolve ) => {
					settle = resolve;
				} );
			render(
				run( [ 'wren-9' ], () => {}, {
					actions: [ { ...bulk[ 0 ], callback } ],
				} )
			);
			const button = await screen.findByRole( 'button', {
				name: 'File the run',
			} );
			fireEvent.click( button );
			expect( button.classList.contains( 'is-busy' ) ).toBe( true );
			await act( async () => settle() );
			expect( button.classList.contains( 'is-busy' ) ).toBe( false );
		} );

		it( 'clears the whole run through the clear button', async () => {
			const onChangeSelection = jest.fn();
			render( lone( [ ELSEWHERE, 'heron-7' ], onChangeSelection ) );
			fireEvent.click(
				await screen.findByRole( 'button', {
					name: 'Clear selection',
				} )
			);
			expect( onChangeSelection ).toHaveBeenLastCalledWith( [] );
		} );
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

	describe( 'focus across a new result set', () => {
		const KIWI = { slug: 'kiwi-41', title: 'Kiwi Courier opens a bureau' };
		const TUI = { slug: 'tui-58', title: 'Tui Herald names an editor' };
		const searching = ( items, over = {} ) =>
			list( {
				items,
				header: <input aria-label="Search words 8817" />,
				...over,
			} );
		const searchBox = () =>
			screen.getByRole( 'textbox', { name: 'Search words 8817' } );
		const row = ( slug ) =>
			document.querySelector( `[id$="-${ slug }-item-wrapper"]` );

		it( 'gives a header control its focus and caret back when the results change', async () => {
			const { rerender } = render( searching( [ HERON, OTTER ] ) );
			await screen.findByText( /Heron Gazette/ );
			const input = searchBox();
			input.value = 'kiwi courier';
			act( () => {
				input.focus();
				input.setSelectionRange( 2, 6 );
			} );
			rerender( searching( [ KIWI, TUI ] ) );
			await screen.findByText( /Kiwi Courier/ );
			await act( () => Promise.resolve() );
			expect( document.activeElement ).toBe( input );
			expect( [ input.selectionStart, input.selectionEnd ] ).toEqual( [
				2, 6,
			] );
		} );

		it( 'leaves a header control its focus after a control removed a row', async () => {
			const Accepting = ( { item } ) => (
				<>
					<span>{ item.title }</span>
					<button type="button">{ `Accept ${ item.slug }` }</button>
				</>
			);
			const accepting = ( items ) =>
				searching( items, { render: Accepting } );
			const { rerender } = render( accepting( [ HERON, OTTER, KIWI ] ) );
			await screen.findByText( /Otter Ledger/ );
			act( () =>
				screen.getByRole( 'button', { name: 'Accept otter-2' } ).focus()
			);
			rerender( accepting( [ HERON, KIWI ] ) );
			await act( () => Promise.resolve() );
			const input = searchBox();
			act( () => input.focus() );
			rerender( accepting( [ KIWI, TUI ] ) );
			await screen.findByText( /Tui Herald/ );
			await act( () => Promise.resolve() );
			expect( document.activeElement ).toBe( input );
		} );

		it( 'keeps a header control its focus over a list whose caller holds the selection', async () => {
			// jsdom has no scrollIntoView, which DataViews calls on a checked row.
			window.HTMLElement.prototype.scrollIntoView = () => {};
			const selecting = ( items ) =>
				searching( items, {
					selection: [ 'otter-2' ],
					onChangeSelection: () => {},
				} );
			const { rerender } = render( selecting( [ HERON, OTTER ] ) );
			await screen.findByText( /Otter Ledger/ );
			const input = searchBox();
			act( () => input.focus() );
			rerender( selecting( [ KIWI, TUI ] ) );
			await screen.findByText( /Kiwi Courier/ );
			await act( () => Promise.resolve() );
			expect( document.activeElement ).toBe( input );
			delete window.HTMLElement.prototype.scrollIntoView;
		} );

		it( 'keeps a header control its focus in the table layout', async () => {
			const table = ( items ) =>
				searching( items, {
					layout: 'table',
					view: view( { type: 'table', page: 1 } ),
				} );
			const { rerender } = render( table( [ HERON, OTTER ] ) );
			await screen.findByText( /Heron Gazette/ );
			const input = searchBox();
			act( () => input.focus() );
			rerender( table( [ KIWI, TUI ] ) );
			await screen.findByText( /Kiwi Courier/ );
			await act( () => Promise.resolve() );
			expect( document.activeElement ).toBe( input );
		} );

		it( 'leaves focus a caller moves into a row as the results commit', async () => {
			const Focusable = ( { item } ) => (
				<span tabIndex={ -1 } data-row={ item.slug }>
					{ item.title }
				</span>
			);
			const Undoing = () => {
				const [ items, setItems ] = useState( [ HERON, OTTER ] );
				const restore = useRef( null );
				useLayoutEffect( () => {
					if ( restore.current ) {
						document
							.querySelector(
								`[data-row="${ restore.current }"]`
							)
							.focus();
						restore.current = null;
					}
				} );
				return searching( items, {
					render: Focusable,
					header: (
						<button
							type="button"
							onClick={ () => {
								restore.current = 'kiwi-41';
								setItems( [ KIWI, HERON, OTTER ] );
							} }
						>
							Undo 6610
						</button>
					),
				} );
			};
			render( <Undoing /> );
			const undo = await screen.findByRole( 'button', {
				name: 'Undo 6610',
			} );
			act( () => undo.focus() );
			fireEvent.click( undo );
			await screen.findByText( /Kiwi Courier/ );
			await act( () => Promise.resolve() );
			expect( document.activeElement ).toBe(
				document.querySelector( '[data-row="kiwi-41"]' )
			);
		} );

		it( 'leaves focus a new row moves to its own field as it mounts', async () => {
			const Field = ( { item } ) => {
				const field = useRef( null );
				useEffect( () => {
					if ( 'kiwi-41' === item.slug ) {
						field.current.focus();
					}
				}, [ item.slug ] );
				return (
					<input ref={ field } aria-label={ `Note ${ item.slug }` } />
				);
			};
			const noting = ( items ) => searching( items, { render: Field } );
			const { rerender } = render( noting( [ HERON, OTTER ] ) );
			await screen.findByRole( 'textbox', { name: 'Note otter-2' } );
			act( () => searchBox().focus() );
			rerender( noting( [ HERON, KIWI ] ) );
			await act( () => Promise.resolve() );
			expect( document.activeElement ).toBe(
				screen.getByRole( 'textbox', { name: 'Note kiwi-41' } )
			);
		} );

		it( 'scrolls back to where the reader was when it hands focus back', async () => {
			const pane = ( items ) => (
				<div data-testid="pane-3390" style={ { overflowY: 'auto' } }>
					{ searching( items ) }
				</div>
			);
			const { rerender } = render( pane( [ HERON, OTTER ] ) );
			await screen.findByText( /Heron Gazette/ );
			const scroller = screen.getByTestId( 'pane-3390' );
			scroller.scrollTop = 40;
			act( () => searchBox().focus() );
			// The browser scrolls the row DataViews focuses into view.
			const focus = window.HTMLElement.prototype.focus;
			window.HTMLElement.prototype.focus = function ( options ) {
				if ( this.classList.contains( 'dataviews-view-list__item' ) ) {
					scroller.scrollTop = 900;
				}
				return focus.call( this, options );
			};
			try {
				rerender( pane( [ KIWI, TUI ] ) );
				await screen.findByText( /Kiwi Courier/ );
				await act( () => Promise.resolve() );
			} finally {
				window.HTMLElement.prototype.focus = focus;
			}
			expect( document.activeElement ).toBe( searchBox() );
			expect( scroller.scrollTop ).toBe( 40 );
		} );

		it( 'keeps every row mounted with its state through a refetch', async () => {
			const Counting = ( { item } ) => {
				const [ taps, setTaps ] = useState( 0 );
				return (
					<button type="button" onClick={ () => setTaps( taps + 1 ) }>
						{ `${ item.slug } tapped ${ taps }` }
					</button>
				);
			};
			const counting = ( items ) =>
				searching( items, { render: Counting } );
			const { rerender } = render( counting( [ HERON, OTTER ] ) );
			fireEvent.click( await screen.findByText( 'otter-2 tapped 0' ) );
			act( () => searchBox().focus() );
			rerender( counting( [ OTTER, KIWI ] ) );
			await screen.findByText( /kiwi-41 tapped 0/ );
			expect( screen.getByText( 'otter-2 tapped 1' ) ).toBeTruthy();
		} );

		it( 'keeps focus in a surface a row portals out, when other results change', async () => {
			const Pinned = ( { item } ) => (
				<>
					<span>{ item.title }</span>
					{ 'heron-7' === item.slug && (
						<Popover>
							<button type="button">Pin 5521</button>
						</Popover>
					) }
				</>
			);
			const pinned = ( items ) => searching( items, { render: Pinned } );
			const { rerender } = render( pinned( [ HERON, OTTER ] ) );
			await act( () => Promise.resolve() );
			const pin = screen.getByRole( 'button', { name: 'Pin 5521' } );
			expect( pin.closest( '.newspack-nodes-dataviews' ) ).toBeNull();
			act( () => pin.focus() );
			rerender( pinned( [ HERON, KIWI ] ) );
			await act( () => Promise.resolve() );
			expect( document.activeElement ).toBe( pin );
		} );

		it( 'hands focus on to a row when nothing held it and the active row leaves', async () => {
			const { rerender } = render( searching( [ HERON, OTTER, KIWI ] ) );
			await screen.findByText( /Otter Ledger/ );
			document.body.focus();
			rerender( searching( [ OTTER, KIWI ] ) );
			await act( () => Promise.resolve() );
			expect( document.activeElement ).toBe( row( 'otter-2' ) );
		} );

		it( 'moves focus to a row when the focused row leaves the results', async () => {
			const { rerender } = render( searching( [ HERON, OTTER, KIWI ] ) );
			await screen.findByText( /Otter Ledger/ );
			act( () => row( 'otter-2' ).focus() );
			rerender( searching( [ HERON, KIWI ] ) );
			await act( () => Promise.resolve() );
			expect( document.activeElement ).toBe( row( 'kiwi-41' ) );
		} );
	} );
} );
