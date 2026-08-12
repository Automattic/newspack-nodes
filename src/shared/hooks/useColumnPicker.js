/**
 * useColumnPicker — the shared "Cols" toolbar control.
 *
 * @package
 */

import { useCallback, useMemo, useState, useEffect } from '@wordpress/element';
import { readStorage, writeStorage } from '../utils/storage';

/**
 * Read a persisted selection, keeping only columns that still exist. A stored
 * set naming a removed column would otherwise render a header cell with no
 * data under it.
 *
 * @param {string}   storageKey Persistence key.
 * @param {string[]} known      Declared column keys, in canonical order.
 * @param {string[]} fallback   Selection to use when nothing usable is stored.
 * @return {string[]} The restored selection.
 */
function restore( storageKey, known, fallback ) {
	const raw = readStorage( storageKey );
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
 * @return {{visibleColumns: string[], toggleColumn: Function, isVisible: Function, gridTemplate: string}}
 *   The selection and its derived layout.
 */
export function useColumnPicker( { columns, storageKey, defaultVisible } ) {
	const known = useMemo( () => Object.keys( columns ), [ columns ] );
	const [ visibleColumns, setVisibleColumns ] = useState( () =>
		restore( storageKey, known, defaultVisible )
	);

	useEffect( () => {
		writeStorage( storageKey, JSON.stringify( visibleColumns ) );
	}, [ storageKey, visibleColumns ] );

	const toggleColumn = useCallback(
		( col ) =>
			setVisibleColumns( ( prev ) =>
				prev.includes( col )
					? prev.filter( ( c ) => c !== col )
					: known.filter( ( c ) => prev.includes( c ) || c === col )
			),
		[ known ]
	);

	const isVisible = useCallback(
		( col ) => visibleColumns.includes( col ),
		[ visibleColumns ]
	);

	const gridTemplate = useMemo(
		() =>
			visibleColumns
				.map( ( col ) => columns[ col ]?.width || 'auto' )
				.join( ' ' ),
		[ columns, visibleColumns ]
	);

	return { visibleColumns, toggleColumn, isVisible, gridTemplate };
}
