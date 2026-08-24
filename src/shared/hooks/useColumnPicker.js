/**
 * useColumnPicker — the shared "Cols" toolbar control.
 *
 * @package
 */

import { useCallback, useMemo } from '@wordpress/element';
import { usePersistedState } from './usePersistedState';

/**
 * Decode a persisted selection, keeping only columns that still exist. A stored
 * set naming a removed column would otherwise render a header cell with no
 * data under it. A RENAMED column is not a removed one, so `aliases` maps each
 * retired key onto its current one first: dropping it would lose that column
 * from every selection saved before the rename, and the write-back would make
 * the loss permanent.
 *
 * @param {?string}               raw      The stored string, or null.
 * @param {string[]}              known    Declared column keys, in canonical order.
 * @param {string[]}              fallback Selection to use when nothing usable is stored.
 * @param {Object<string,string>} aliases  Retired key → current key.
 * @return {string[]} The restored selection.
 */
function restore( raw, known, fallback, aliases ) {
	if ( null === raw ) {
		return fallback;
	}
	try {
		const parsed = JSON.parse( raw );
		if ( ! Array.isArray( parsed ) ) {
			return fallback;
		}
		const wanted = parsed.map( ( key ) => aliases[ key ] ?? key );
		const kept = known.filter( ( key ) => wanted.includes( key ) );
		return kept.length ? kept : fallback;
	} catch ( e ) {
		return fallback;
	}
}

// No rename to carry — the common case, and one stable identity for it.
const NO_ALIASES = {};

/**
 * The CSS grid track list for a set of columns, in display order.
 *
 * One owner, because a table's header and its rows are laid out from the
 * same widths and must not drift.
 *
 * @param {Object}        columns Column declarations keyed by field.
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
 * @param {Object}   [opts.aliases]      Retired key → current key, for a column renamed after selections were already stored.
 * @return {{visibleColumns: string[], toggleColumn: Function, isVisible: Function, gridTemplate: string}}
 *   The selection and its derived layout.
 */
export function useColumnPicker( {
	columns,
	storageKey,
	defaultVisible,
	aliases = NO_ALIASES,
} ) {
	const known = useMemo( () => Object.keys( columns ), [ columns ] );
	const [ visibleColumns, setVisibleColumns ] = usePersistedState(
		storageKey,
		( raw ) => restore( raw, known, defaultVisible, aliases ),
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
