/**
 * useColumnPicker — the Cols toolbar control.
 *
 * Request Log and Gyroscope each grew their own copy of this: a visible-set
 * state, a canonical-order toggle, localStorage persistence, and a checkbox
 * row. Partition Viewer would have been the third.
 */

import { renderHook, act } from '@testing-library/react';
import { useColumnPicker } from '../useColumnPicker';

const COLUMNS = {
	type: { label: 'Type' },
	ts: { label: 'Time' },
	value: { label: 'Value' },
};

beforeEach( () => window.localStorage.clear() );

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
