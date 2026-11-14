/**
 * useDeepLinkedSelection tests — the `?param=` deep-link contract: seed once on
 * the first non-empty catalog, never override a later pick, reflect user picks
 * back into the URL.
 */

import { renderHook, act } from '@testing-library/react';
import useDeepLinkedSelection from '../useDeepLinkedSelection';

function mount( { param = 'source', keys, selected, select } ) {
	return renderHook( ( props ) => useDeepLinkedSelection( props ), {
		initialProps: { param, keys, selected, select },
	} );
}

beforeEach( () => {
	window.history.replaceState( {}, '', '/' );
} );

it( 'seeds the URL key once the catalog is available', () => {
	window.history.replaceState( {}, '', '/?source=gate' );
	const select = jest.fn();
	mount( { keys: [ 'php', 'gate' ], selected: 'php', select } );
	expect( select ).toHaveBeenCalledWith( 'gate' );
} );

it( 'spends the seed chance on the FIRST non-empty catalog', () => {
	window.history.replaceState( {}, '', '/?source=gate' );
	const select = jest.fn();
	const { rerender } = mount( {
		keys: [ 'php' ],
		selected: 'php',
		select,
	} );
	// 'gate' arrives only in a later catalog — it must not override.
	rerender( {
		param: 'source',
		keys: [ 'php', 'gate' ],
		selected: 'php',
		select,
	} );
	expect( select ).not.toHaveBeenCalled();
} );

it( 'waits through an EMPTY catalog before spending the seed', () => {
	window.history.replaceState( {}, '', '/?source=gate' );
	const select = jest.fn();
	const { rerender } = mount( { keys: [], selected: '', select } );
	expect( select ).not.toHaveBeenCalled();
	rerender( {
		param: 'source',
		keys: [ 'php', 'gate' ],
		selected: 'php',
		select,
	} );
	expect( select ).toHaveBeenCalledWith( 'gate' );
} );

it( 'does not seed a key missing from the catalog, or the already-selected key', () => {
	window.history.replaceState( {}, '', '/?source=ghost' );
	const select = jest.fn();
	mount( { keys: [ 'php' ], selected: 'php', select } );
	expect( select ).not.toHaveBeenCalled();

	window.history.replaceState( {}, '', '/?source=php' );
	const select2 = jest.fn();
	mount( { keys: [ 'php' ], selected: 'php', select: select2 } );
	expect( select2 ).not.toHaveBeenCalled();
} );

it( 'pick selects AND reflects the key into the URL param', () => {
	const select = jest.fn();
	const { result } = mount( {
		keys: [ 'php', 'gate' ],
		selected: 'php',
		select,
	} );
	act( () => result.current( 'gate' ) );
	expect( select ).toHaveBeenCalledWith( 'gate' );
	expect( window.location.search ).toContain( 'source=gate' );
} );

it( 'pushes a Back entry for each pick', () => {
	const push = jest.spyOn( window.history, 'pushState' );
	const select = jest.fn();
	const { result, unmount } = mount( {
		keys: [ 'php', 'gate' ],
		selected: 'php',
		select,
	} );
	act( () => result.current( 'gate' ) );
	expect( push ).toHaveBeenCalledTimes( 1 );
	expect( window.location.search ).toBe( '?source=gate' );
	unmount();
	push.mockRestore();
} );

it( 'selects the key the entry Back lands on names', () => {
	const select = jest.fn();
	const { result, unmount } = mount( {
		keys: [ 'php', 'gate', 'kea-7926' ],
		selected: 'php',
		select,
	} );
	act( () => result.current( 'kea-7926' ) );
	select.mockClear();

	act( () => {
		window.history.replaceState( null, '', '/?source=gate' );
		window.dispatchEvent( new window.PopStateEvent( 'popstate' ) );
	} );

	expect( select ).toHaveBeenCalledTimes( 1 );
	expect( select ).toHaveBeenCalledWith( 'gate' );
	unmount();
} );

it( 'leaves the selection where Back lands on a key the catalog lacks', () => {
	const select = jest.fn();
	const { result, unmount } = mount( {
		keys: [ 'php', 'gate' ],
		selected: 'php',
		select,
	} );
	act( () => result.current( 'gate' ) );
	select.mockClear();

	act( () => {
		window.history.replaceState( null, '', '/?source=ghost-7926' );
		window.dispatchEvent( new window.PopStateEvent( 'popstate' ) );
	} );

	expect( select ).not.toHaveBeenCalled();
	unmount();
} );
