/**
 * `ProbeTable` renders the probe tabs' per-identity tables from a column
 * declaration, so Jobs and Tables write out no table shell.
 */

import { formatGroupedCount } from '@newspack-nodes/shared/utils/formatters';

/**
 * One column of a `ProbeTable`: its header, its cell, and optionally the
 * attributes its `<td>` takes.
 *
 * @typedef {Object} ProbeColumn
 * @property {string}                         label Header text, and the cell's React key.
 * @property {( row: *, ctx: * ) => *}        cell  The cell's content for one row.
 * @property {( row: * ) => Object<string,*>} [td]  Attributes for the cell's `<td>`.
 */

/**
 * A probe tab's per-identity table, or its empty state while it has no rows.
 *
 * @param {Object}               props           Component props.
 * @param {Array<ProbeColumn>}   props.columns   The columns, in order.
 * @param {Array<Object>}        props.rows      The rows, already sorted.
 * @param {( row: * ) => string} props.getItemId A row's identity, as `DataViewsList` names it.
 * @param {string}               props.keyAttr   The data attribute carrying that identity, e.g. `data-job-key`.
 * @param {*}                    [props.context] Handed to every cell beside its row.
 * @param {string}               props.emptyText What reads in place of a table with no rows.
 * @return {import('react').ReactElement} The table or the empty state.
 */
export function ProbeTable( {
	columns,
	rows,
	getItemId,
	keyAttr,
	context,
	emptyText,
} ) {
	if ( 0 === rows.length ) {
		return (
			<p className="newspack-nodes-empty-state nodes-probe-tab__empty">
				{ emptyText }
			</p>
		);
	}
	return (
		<table className="nodes-probe-tab__table newspack-nodes-table">
			<thead>
				<tr>
					{ columns.map( ( c ) => (
						<th key={ c.label }>{ c.label }</th>
					) ) }
				</tr>
			</thead>
			<tbody>
				{ rows.map( ( row ) => {
					const key = getItemId( row );
					return (
						<tr key={ key } { ...{ [ keyAttr ]: key } }>
							{ columns.map( ( c ) => (
								<td key={ c.label } { ...c.td?.( row ) }>
									{ c.cell( row, context ) }
								</td>
							) ) }
						</tr>
					);
				} ) }
			</tbody>
		</table>
	);
}

/**
 * The window's error count as a column, marked when it is not zero.
 *
 * @param {string} label The column header.
 * @return {ProbeColumn} The column, reading `row.windowed.errors`.
 */
export function errorsColumn( label ) {
	return {
		label,
		cell: ( row ) => formatGroupedCount( row.windowed.errors ),
		td: ( row ) => ( {
			className:
				row.windowed.errors > 0
					? 'nodes-probe-tab__count is-nonzero'
					: 'nodes-probe-tab__count',
		} ),
	};
}
