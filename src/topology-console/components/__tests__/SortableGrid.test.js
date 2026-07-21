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
	expect( getByTestId( 'grid' ).querySelector( 'tfoot' ) ).toBeNull();
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
