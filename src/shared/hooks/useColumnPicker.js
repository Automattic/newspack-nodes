/**
 * A table's visible column set, and the CSS grid track list that lays it out.
 *
 * `useColumnPicker` owns the selection and persists it; the checkbox row that
 * edits it is `components/ColumnPicker`. `gridTemplate` is exported on its own
 * for the tables whose column set is fixed and need only the track list.
 *
 * @package
 */

import { useCallback, useMemo } from '@wordpress/element';
import { usePersistedState } from './usePersistedState';

/**
 * Decode a persisted selection, keeping only columns that still exist. A stored
 * key the caller no longer declares is dropped: storage hands back whatever was
 * written to it, and the declared set is the only vocabulary this reads, so a
 * key outside it would render a header cell with no data under it.
 *
 * @param {?string}  raw      The stored string, or null.
 * @param {string[]} known    Declared column keys, in canonical order.
 * @param {string[]} fallback Selection to use when nothing usable is stored.
 * @return {string[]} The restored selection.
 */
function restore( raw, known, fallback ) {
	if ( null === raw ) {
		return fallback;
	}
	try {
		const parsed = JSON.parse( raw );
		if ( ! Array.isArray( parsed ) ) {
			return fallback;
		}
		const kept = known.filter( ( key ) => parsed.includes( key ) );
		return kept.length ? kept : fallback;
	} catch ( e ) {
		return fallback;
	}
}

/**
 * The CSS grid track list for a set of columns, in display order. A column
 * declaring no `width` takes an `auto` track.
 *
 * One owner, because a table's header and its rows are laid out from the
 * same widths and must not drift.
 *
 * @param {Object}        columns Column declarations keyed by field; only `width` is read.
 * @param {Array<string>} order   Fields, in the order they are drawn.
 * @return {string} A `grid-template-columns` value.
 */
export const gridTemplate = ( columns, order ) =>
	order.map( ( col ) => columns[ col ]?.width || 'auto' ).join( ' ' );

/**
 * Own a column selection: which are visible, how they toggle, and the grid
 * template that lays them out.
 *
 * A toggled-on column re-enters in the order `columns` DECLARES, never at the
 * end — the header and the cells are both built from this list, so appending
 * would silently reorder the table.
 *
 * @param {Object}   opts                Options.
 * @param {Object}   opts.columns        Canonical map: key → `{ label, width, tooltip, className }`.
 * @param {string}   opts.storageKey     localStorage key for the selection.
 * @param {string[]} opts.defaultVisible Keys visible before the user chooses.
 * @return {{visibleColumns: string[], toggleColumn: (col: string) => void, isVisible: (col: string) => boolean, gridTemplate: string}}
 *   The selection and its derived layout.
 */
export function useColumnPicker( { columns, storageKey, defaultVisible } ) {
	const known = useMemo( () => Object.keys( columns ), [ columns ] );
	const [ visibleColumns, setVisibleColumns ] = usePersistedState(
		storageKey,
		( raw ) => restore( raw, known, defaultVisible ),
		JSON.stringify
	);

	const toggleColumn = useCallback(
		( col ) =>
			setVisibleColumns( ( prev ) =>
				prev.includes( col )
					? prev.filter( ( c ) => c !== col )
					: known.filter( ( c ) => prev.includes( c ) || c === col )
			),
		[ known, setVisibleColumns ]
	);

	const isVisible = useCallback(
		( col ) => visibleColumns.includes( col ),
		[ visibleColumns ]
	);

	const template = useMemo(
		() => gridTemplate( columns, visibleColumns ),
		[ columns, visibleColumns ]
	);

	return { visibleColumns, toggleColumn, isVisible, gridTemplate: template };
}
