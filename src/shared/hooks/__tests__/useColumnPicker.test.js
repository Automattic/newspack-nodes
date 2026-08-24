/**
 * useColumnPicker — the Cols toolbar control.
 *
 * Request Log and Gyroscope each grew their own copy of this: a visible-set
 * state, a canonical-order toggle, localStorage persistence, and a checkbox
 * row. Partition Viewer would have been the third.
 */

import { renderHook, act } from '@testing-library/react';
import { gridTemplate, useColumnPicker } from '../useColumnPicker';

const COLUMNS = {
	type: { label: 'Type' },
	ts: { label: 'Time' },
	value: { label: 'Value' },
};

beforeEach( () => window.localStorage.clear() );

it( 'joins the declared widths in display order', () => {
	// One owner: a table's header and its rows must not be laid out by two
	// functions that can drift apart.
	const cols = {
		mast: { width: '137px' },
		jib: { width: '211px' },
		boom: {},
	};
	expect( gridTemplate( cols, [ 'jib', 'boom', 'mast' ] ) ).toBe(
		'211px auto 137px'
	);
} );

it( 'falls back to auto for a column that declares no width', () => {
	expect(
		gridTemplate( { quixote: { label: 'Quixote' } }, [ 'quixote' ] )
	).toBe( 'auto' );
} );

it( 'starts from the declared default set', () => {
	const { result } = renderHook( () =>
		useColumnPicker( {
			columns: COLUMNS,
			storageKey: 'k',
			defaultVisible: [ 'ts', 'value' ],
		} )
	);
	expect( result.current.visibleColumns ).toEqual( [ 'ts', 'value' ] );
} );

it( 're-inserts a toggled column in CANONICAL order, not at the end', () => {
	const { result } = renderHook( () =>
		useColumnPicker( {
			columns: COLUMNS,
			storageKey: 'k',
			defaultVisible: [ 'value' ],
		} )
	);
	act( () => result.current.toggleColumn( 'type' ) );
	// `type` is declared first, so it leads — a naive push would append it.
	expect( result.current.visibleColumns ).toEqual( [ 'type', 'value' ] );
} );

it( 'drops a column that is toggled off', () => {
	const { result } = renderHook( () =>
		useColumnPicker( {
			columns: COLUMNS,
			storageKey: 'k',
			defaultVisible: [ 'ts', 'value' ],
		} )
	);
	act( () => result.current.toggleColumn( 'ts' ) );
	expect( result.current.visibleColumns ).toEqual( [ 'value' ] );
} );

it( 'persists the selection and restores it', () => {
	const { result, unmount } = renderHook( () =>
		useColumnPicker( {
			columns: COLUMNS,
			storageKey: 'cols:test',
			defaultVisible: [ 'value' ],
		} )
	);
	act( () => result.current.toggleColumn( 'type' ) );
	unmount();

	const second = renderHook( () =>
		useColumnPicker( {
			columns: COLUMNS,
			storageKey: 'cols:test',
			defaultVisible: [ 'value' ],
		} )
	);
	expect( second.result.current.visibleColumns ).toEqual( [
		'type',
		'value',
	] );
} );

it( 'restores a stored key through a rename, in canonical order', () => {
	// A renamed column is not a removed one: filtering by the current keys
	// alone drops it from every selection saved before the rename, and the
	// write-back makes that permanent.
	window.localStorage.setItem(
		'cols:renamed',
		JSON.stringify( [ 'ts', 'val' ] )
	);
	const { result } = renderHook( () =>
		useColumnPicker( {
			columns: COLUMNS,
			storageKey: 'cols:renamed',
			defaultVisible: [ 'type' ],
			aliases: { val: 'value' },
		} )
	);
	expect( result.current.visibleColumns ).toEqual( [ 'ts', 'value' ] );
} );

it( 'ignores a stored set naming columns that no longer exist', () => {
	window.localStorage.setItem(
		'cols:stale',
		JSON.stringify( [ 'value', 'removed_column' ] )
	);
	const { result } = renderHook( () =>
		useColumnPicker( {
			columns: COLUMNS,
			storageKey: 'cols:stale',
			defaultVisible: [ 'ts' ],
		} )
	);
	expect( result.current.visibleColumns ).toEqual( [ 'value' ] );
} );
