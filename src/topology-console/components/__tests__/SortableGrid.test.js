/**
 * SortableGrid tests — the click-to-sort table shared by the Inspector's Runtime
 * and Stats modal views. Here we pin the optional `footer` prop: a single keyed
 * row rendered in a <tfoot>, aligned with the columns and excluded from the
 * sortable <tbody>. Absent by default (RuntimeView passes none).
 */

import { render } from '@testing-library/react';
import { Grid } from '../SortableGrid';

const COLS = [
	{ key: 'name', label: 'NAME' },
	{ key: 'count', label: 'COUNT', numeric: true },
];
const SORT = { key: 'name', dir: 'asc' };

test( 'renders no tfoot when no footer prop is passed', () => {
	const { getByTestId } = render(
		<Grid
			testid="grid"
			cols={ COLS }
			rows={ [ { name: 'alpha', count: 3 } ] }
			sort={ SORT }
			onSort={ () => {} }
		/>
	);
	const grid = getByTestId( 'grid' );
	expect( grid.classList.contains( 'newspack-nodes-table' ) ).toBe( true );
	expect( grid.querySelector( 'tfoot' ) ).toBeNull();
} );

test( 'renders the footer as a tfoot row aligned to the columns, never in the tbody', () => {
	const { getByTestId } = render(
		<Grid
			testid="grid"
			cols={ COLS }
			rows={ [ { name: 'alpha', count: 3 } ] }
			sort={ SORT }
			onSort={ () => {} }
			footer={ { name: '--total--', count: 99 } }
		/>
	);
	const grid = getByTestId( 'grid' );
	const foot = grid.querySelector( 'tfoot tr' );
	expect( foot ).toBeTruthy();
	const cells = [ ...foot.querySelectorAll( 'td' ) ].map(
		( td ) => td.textContent
	);
	expect( cells ).toEqual( [ '--total--', '99' ] );
	// The footer never leaks into the sortable body.
	expect(
		grid.querySelector( 'tbody tr[data-name="--total--"]' )
	).toBeNull();
} );

test( 'a column format renders its cells while the sort reads the raw values', () => {
	const cols = [
		{ key: 'name', label: 'NAME' },
		{
			key: 'bytes',
			label: 'BYTES',
			numeric: true,
			format: ( v ) => `${ v / 1024 } KiB`,
		},
	];
	const { getByTestId } = render(
		<Grid
			testid="grid"
			cols={ cols }
			rows={ [
				{ name: 'small', bytes: 2048 },
				{ name: 'large', bytes: 10240 },
			] }
			sort={ { key: 'bytes', dir: 'desc' } }
			onSort={ () => {} }
			footer={ { name: 'total', bytes: 12288 } }
		/>
	);
	const grid = getByTestId( 'grid' );
	const body = [ ...grid.querySelectorAll( 'tbody tr' ) ].map( ( tr ) =>
		[ ...tr.querySelectorAll( 'td' ) ].map( ( td ) => td.textContent )
	);
	expect( body ).toEqual( [
		[ 'large', '10 KiB' ],
		[ 'small', '2 KiB' ],
	] );
	expect( grid.querySelector( 'tfoot td:last-child' ).textContent ).toBe(
		'12 KiB'
	);
} );

test( 'a missing value reads as the en dash, never reaching the column format', () => {
	const format = jest.fn( ( v ) => `${ v } ms` );
	const { getByTestId } = render(
		<Grid
			testid="grid"
			cols={ [
				{ key: 'name', label: 'NAME' },
				{ key: 'ms', label: 'MS', numeric: true, format },
			] }
			rows={ [
				{ name: 'kea', ms: null },
				{ name: 'tui' },
				{ name: 'ruru', ms: 7 },
			] }
			sort={ { key: 'name', dir: 'asc' } }
			onSort={ () => {} }
		/>
	);
	const cells = [
		...getByTestId( 'grid' ).querySelectorAll( 'tbody td:last-child' ),
	].map( ( td ) => td.textContent );
	expect( cells ).toEqual( [ '–', '7 ms', '–' ] );
	expect( format ).toHaveBeenCalledTimes( 1 );
} );
