/**
 * SortableGrid — the click-to-sort table behind the Inspector's Runtime and
 * Profiler modals, plus the sort-toggle hook that drives it. A view supplies
 * column specs, keyed rows and sort state; the grid owns the ordering, the
 * headers and the cell formatting. It is a module of its own rather than an
 * export of either view, so neither modal depends on the other's internals.
 */

import { useMemo, useState } from '@wordpress/element';
import './inspector-views.scss';

/**
 * One grid column: the row key it reads, the header text it prints, and
 * whether its values compare as numbers rather than as text.
 *
 * @typedef {{key:string,label:string,numeric?:boolean}} Column
 */

/**
 * One grid row: cell values keyed by column key, as the `-s` form of a REPL
 * verb hands them back — strings, numbers, booleans, and null where the scope
 * has no value to report. A `name` doubles as the React key and the row's
 * `data-name` attribute.
 *
 * @typedef {Record<string,any>} Row
 */

/**
 * Which column a grid is sorted by, and in which direction ('asc' or 'desc').
 *
 * @typedef {{key:string,dir:string}} SortState
 */

/**
 * Render one cell of a row as display text. Booleans read yes/no; null or a
 * key the row never carried reads as an en dash, so a field the scope cannot
 * report shows as absent rather than blank — PHP nulls `next_ms` for an
 * inactive or router-hitchhiking timer, and the browser runtime nulls both
 * `id` and `next_ms` on every timer row it builds.
 *
 * @param {string|number|boolean|null|undefined} value Raw cell value, `row[ col.key ]`.
 * @return {string} The text to render in the cell.
 */
export function formatCell( value ) {
	if ( 'boolean' === typeof value ) {
		return value ? 'yes' : 'no';
	}
	if ( null === value || undefined === value ) {
		return '–';
	}
	return String( value );
}

/**
 * Order the rows by one column, on a copy. A `numeric` column compares as
 * numbers, and a cell that will not parse — an absent key, a non-numeric
 * string — sorts as -Infinity so it lands at the ascending end rather than
 * scattering through the ranking; a null cell parses as 0 and sorts with the
 * zeros. Every other column compares with `localeCompare`.
 *
 * @param {Row[]}     rows Rows to order; the caller's array is left as it is.
 * @param {Column[]}  cols Column specs; an unknown sort key returns the rows
 *                         in the order they arrived.
 * @param {SortState} sort Column key and direction to order by.
 * @return {Row[]} The ordered rows.
 */
function sortRows( rows, cols, sort ) {
	const col = cols.find( ( c ) => c.key === sort.key );
	if ( ! col ) {
		return rows;
	}
	const factor = 'desc' === sort.dir ? -1 : 1;
	const num = ( v ) => {
		const n = Number( v );
		return Number.isNaN( n ) ? -Infinity : n;
	};
	return [ ...rows ].sort( ( a, b ) => {
		if ( col.numeric ) {
			return ( num( a[ col.key ] ) - num( b[ col.key ] ) ) * factor;
		}
		return (
			String( a[ col.key ] ?? '' ).localeCompare(
				String( b[ col.key ] ?? '' )
			) * factor
		);
	} );
}

/**
 * Sort state and the header-click toggle for one grid, as a `[ sort, onSort ]`
 * pair. Clicking the sorted column flips its direction; clicking any other
 * column starts that one ascending. One pair drives one grid, so RuntimeView
 * calls this twice — its timers and its handles sort independently.
 *
 * @param {string} key   Initial sort column key.
 * @param {string} [dir] Initial direction, 'asc' or 'desc'; 'asc' by default.
 * @return {[SortState,(nextKey:string)=>void]} The sort state and its toggler.
 */
export function useSortState( key, dir = 'asc' ) {
	const [ sort, setSort ] = useState( { key, dir } );
	const onSort = ( nextKey ) =>
		setSort( ( s ) => ( {
			key: nextKey,
			dir: s.key === nextKey && 'asc' === s.dir ? 'desc' : 'asc',
		} ) );
	return [ sort, onSort ];
}

/**
 * A click-to-sort grid. Headers call `onSort`, and the ordering itself happens
 * here on a memoized copy, so a view hands rows over in whatever order they
 * arrived. A non-empty `rowClass( row )` both classes the row and prefixes its
 * first cell with ⚠, which is how RuntimeView flags a spinning timer without
 * the grid learning what a spinner is. `footer` renders in a `<tfoot>` outside
 * the sorted body, so an aggregate row — ProfilerView's `--total--` — stays at
 * the bottom under every sort.
 *
 * @param {Object}             props
 * @param {string}             props.testid     Grid test id; each header gets
 *                                              `${testid}-th-${key}`.
 * @param {Column[]}           props.cols       Column specs, in render order.
 * @param {Row[]}              props.rows       Rows for the sortable body.
 * @param {SortState}          props.sort       Column and direction to sort by.
 * @param {(key:string)=>void} props.onSort     Called with a column key on
 *                                              header click.
 * @param {(row:Row)=>string}  [props.rowClass] Extra class for one row, '' for
 *                                              none.
 * @param {Row}                [props.footer]   One row rendered in a `<tfoot>`,
 *                                              aligned to the columns.
 * @return {import('react').ReactElement} The grid table.
 */
export function Grid( { testid, cols, rows, sort, onSort, rowClass, footer } ) {
	const sorted = useMemo(
		() => sortRows( rows, cols, sort ),
		[ rows, cols, sort ]
	);
	// Sort-direction arrow for a column header ('' unless it's the sorted one).
	const arrow = ( c ) => {
		if ( sort.key !== c.key ) {
			return '';
		}
		return 'asc' === sort.dir ? ' ▲' : ' ▼';
	};
	return (
		<table
			className="newspack-nodes-table nodes-runtime__grid"
			data-testid={ testid }
		>
			<thead>
				<tr>
					{ cols.map( ( c ) => (
						<th
							key={ c.key }
							data-testid={ `${ testid }-th-${ c.key }` }
							className={ `nodes-runtime__th${
								sort.key === c.key ? ' is-sorted' : ''
							}` }
							onClick={ () => onSort( c.key ) }
						>
							{ c.label }
							{ arrow( c ) }
						</th>
					) ) }
				</tr>
			</thead>
			<tbody>
				{ sorted.map( ( r, i ) => {
					const extra = rowClass ? rowClass( r ) : '';
					return (
						<tr
							key={ r.name ?? i }
							data-name={ r.name }
							className={ `nodes-runtime__row${ extra }` }
						>
							{ cols.map( ( c, ci ) => (
								<td key={ c.key } className="nodes-runtime__td">
									{ 0 === ci && extra ? '⚠ ' : '' }
									{ formatCell( r[ c.key ] ) }
								</td>
							) ) }
						</tr>
					);
				} ) }
			</tbody>
			{ footer && (
				<tfoot>
					<tr className="nodes-runtime__foot">
						{ cols.map( ( c ) => (
							<td key={ c.key } className="nodes-runtime__td">
								{ formatCell( footer[ c.key ] ) }
							</td>
						) ) }
					</tr>
				</tfoot>
			) }
		</table>
	);
}
