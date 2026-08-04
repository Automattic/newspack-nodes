/**
 * SortableGrid — the click-to-sort table shared by the Inspector's Runtime and
 * Stats modal views. Moved out of RuntimeView (rather than imported from it) so
 * ProfilerView doesn't depend on a sibling view's internals: both render keyed rows
 * as a sortable grid, so the grid + its sort-toggle hook are their own module.
 */

import { useMemo, useState } from '@wordpress/element';
import './inspector-views.scss';

/**
 * Render one cell of a row as display text. Booleans read yes/no; a value the
 * row never carried (a JS-only field such as `next_ms` or `id`) reads as an en
 * dash rather than an empty cell, so a missing field is visibly missing.
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

// Sort a copy of rows by one column; numeric columns compare as numbers.
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
 * Sort state + a header-click toggle: same column twice flips asc↔desc, a new
 * column starts ascending. Returned as a `[ sort, onSort ]` pair.
 *
 * @param {string} key   Initial sort column key.
 * @param {string} [dir] Initial direction ('asc' | 'desc'); defaults to 'asc'.
 * @return {[{key:string,dir:string}, Function]} The sort state and its toggler.
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
 * A click-to-sort grid. `rowClass( row )` returns an extra class (spinner flag);
 * when it fires, the row's first cell gets a ⚠ marker.
 *
 * @param {Object}   props
 * @param {string}   props.testid     Grid test id (headers get `${testid}-th-${key}`).
 * @param {Array}    props.cols       Column specs ({ key, label, numeric? }).
 * @param {Array}    props.rows       Keyed rows to render.
 * @param {Object}   props.sort       { key, dir } sort state.
 * @param {Function} props.onSort     Called with a column key on header click.
 * @param {Function} [props.rowClass] Row → extra class name ('' for none).
 * @param {Object}   [props.footer]   One keyed row rendered in a <tfoot>, aligned to
 *                                    the columns and excluded from the sortable body.
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
