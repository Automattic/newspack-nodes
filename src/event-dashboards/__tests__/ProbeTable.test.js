/**
 * ProbeTable — a probe tab's per-identity table from a column declaration,
 * and `errorsColumn`, the window's error count as a column.
 */

import { render } from '@testing-library/react';
import { ProbeTable, errorsColumn } from '../ProbeTable';

describe( 'ProbeTable', () => {
	const columns = [
		{
			label: 'Name',
			cell: ( row ) => row.key,
			td: () => ( { className: 'nodes-probe-tab__name' } ),
		},
		{
			label: 'Age',
			cell: ( row, ctx ) => `${ ctx.now - row.ts }s`,
			td: ( row ) => ( { title: `at ${ row.ts }` } ),
		},
	];
	const rows = [
		{ key: 'lab-7:kea.p3', ts: 4400 },
		{ key: 'lab-7:owl.p3', ts: 4471 },
	];
	const mountTable = ( over = {} ) =>
		render(
			<ProbeTable
				columns={ columns }
				rows={ rows }
				rowKey={ ( row ) => row.key }
				keyAttr="data-kea-key"
				context={ { now: 4500 } }
				emptyText="Nothing swept yet."
				{ ...over }
			/>
		);

	it( 'heads the canonical table with each column label', () => {
		const { container } = mountTable();
		const table = container.querySelector( 'table' );
		expect( table.className ).toBe(
			'nodes-probe-tab__table newspack-nodes-table'
		);
		expect(
			[ ...table.querySelectorAll( 'th' ) ].map( ( h ) => h.textContent )
		).toEqual( [ 'Name', 'Age' ] );
	} );

	it( 'renders a row per entry, keyed on the attribute it names', () => {
		const { container } = mountTable();
		const row = container.querySelector( '[data-kea-key="lab-7:owl.p3"]' );
		const cells = [ ...row.children ];
		expect( cells.map( ( c ) => c.textContent ) ).toEqual( [
			'lab-7:owl.p3',
			'29s',
		] );
		expect( cells[ 0 ].className ).toBe( 'nodes-probe-tab__name' );
		expect( cells[ 1 ].title ).toBe( 'at 4471' );
	} );

	it( 'shows its empty text in place of a table with no rows', () => {
		const { container } = mountTable( { rows: [] } );
		expect( container.querySelector( 'table' ) ).toBeNull();
		const empty = container.querySelector( '.nodes-probe-tab__empty' );
		expect( empty.className ).toBe(
			'newspack-nodes-empty-state nodes-probe-tab__empty'
		);
		expect( empty.textContent ).toBe( 'Nothing swept yet.' );
	} );
} );

describe( 'errorsColumn', () => {
	it( 'marks a nonzero count, and only a nonzero one', () => {
		const col = errorsColumn( 'Failures' );
		expect( col.label ).toBe( 'Failures' );
		expect( col.cell( { windowed: { errors: 4321 } } ) ).toBe( '4,321' );
		expect( col.td( { windowed: { errors: 7 } } ).className ).toBe(
			'nodes-probe-tab__count is-nonzero'
		);
		expect( col.td( { windowed: { errors: 0 } } ).className ).toBe(
			'nodes-probe-tab__count'
		);
	} );
} );
