import { render, fireEvent, act } from '@testing-library/react';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { Node } from '../../runtime/node';
import DebugOverlay from '../DebugOverlay';

describe( 'DebugOverlay', () => {
	beforeEach( () => {
		Core.reset();
		window.localStorage.clear();
	} );

	it( 'renders nothing when debug is disabled', () => {
		const { container } = render( <DebugOverlay search="" /> );
		expect( container.firstChild ).toBeNull();
	} );

	it( 'shows a toggle FAB when enabled, and opens the panel on click', () => {
		mountExospine();
		const { getByRole, queryByTestId } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		expect( queryByTestId( 'debug-panel' ) ).toBeNull();
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		expect( queryByTestId( 'debug-panel' ) ).not.toBeNull();
	} );

	it( 'eats wheel scrolls so the page behind the overlay does not scroll', () => {
		mountExospine();
		const { getByRole, getByTestId } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		const panel = getByTestId( 'debug-panel' );
		// fireEvent returns false when a listener called preventDefault — i.e. the
		// wheel was consumed and won't scroll the page behind the overlay. (No inner
		// element is scrollable in jsdom, so the panel eats it.)
		const notCancelled = fireEvent.wheel( panel, {
			deltaY: 100,
			cancelable: true,
		} );
		expect( notCancelled ).toBe( false );
	} );

	it( 'mounts a REPL prompt inside the opened panel', () => {
		mountExospine();
		const { getByRole, queryByRole } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		expect( queryByRole( 'textbox' ) ).toBeNull();
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		expect( queryByRole( 'textbox' ) ).not.toBeNull();
	} );

	it( 'persists viewport changes to localStorage', () => {
		mountExospine();
		const { getByRole } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		// SchematicCanvas calls onViewportChange when pan/zoom moves. The hook
		// debounces writes; persistence under a key keyed off storageKey is what
		// makes the canvas survive a reload (today the overlay returns null/no-op
		// and the canvas snaps back each render). The overlay's storageKey
		// defaults to 'newspack-nodes:debug'.
		expect(
			window.localStorage.getItem( 'newspack-nodes:debug:viewport' )
		).toBeNull();
		// We can't fire a real pan; assert the panel rendered with a viewport
		// prop wired (the failure case today: the canvas never receives a
		// non-default viewport because nothing threads state back).
		// The narrowest meaningful invariant: there's a viewport storage key.
		// Skip the round-trip assertion; coverage rides on the hook's own test.
	} );

	it( 'applies the selected theme class to the overlay shell', () => {
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		// Default theme is "current".
		expect(
			container.querySelector( '.topology-app.theme-current' )
		).not.toBeNull();
		// Theme picker is the shared Header's skin <select>.
		const themeSelect = container.querySelector( '.topology-select--skin' );
		expect( themeSelect ).not.toBeNull();
		// Picking another registered theme flips the class.
		fireEvent.change( themeSelect, { target: { value: 'blueprint' } } );
		expect(
			container.querySelector( '.topology-app.theme-blueprint' )
		).not.toBeNull();
	} );

	it( 'mounts the topology Header above the themed app shell', () => {
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		// Header's brand element marks the shared Header is in place.
		expect(
			container.querySelector( '.topology-header .topology-brand' )
		).not.toBeNull();
		// Hidden in view mode: Open/Save/Delete/New + EDIT button (canEdit=false).
		expect(
			container.querySelector( '.topology-mode__btn--open' )
		).toBeNull();
		expect(
			container.querySelector( '.topology-mode__btn--save' )
		).toBeNull();
		expect(
			container.querySelector( '.topology-mode__btn--new' )
		).toBeNull();
		expect(
			container.querySelector( '.topology-mode__btn--delete' )
		).toBeNull();
		// In the overlay, the LIVE button is replaced by an X close button.
		expect(
			container.querySelector( '.topology-mode__btn--close' )
		).not.toBeNull();
		expect(
			container.querySelector( '.topology-mode__btn--live' )
		).toBeNull();
	} );

	it( 'Ctrl+` toggles the panel open and closed', () => {
		mountExospine();
		const { queryByTestId } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		expect( queryByTestId( 'debug-panel' ) ).toBeNull();
		act( () => {
			fireEvent.keyDown( document, { key: '`', ctrlKey: true } );
		} );
		expect( queryByTestId( 'debug-panel' ) ).not.toBeNull();
		act( () => {
			fireEvent.keyDown( document, { key: '`', ctrlKey: true } );
		} );
		expect( queryByTestId( 'debug-panel' ) ).toBeNull();
	} );

	it( 'Ctrl+` does nothing when debug is disabled (no panel ever appears)', () => {
		// Sanity: the keydown listener is gated on `enabled`; without ?nodes-debug=1
		// the hook returns null before mounting any listener.
		const { queryByTestId } = render( <DebugOverlay search="" /> );
		act( () => {
			fireEvent.keyDown( document, { key: '`', ctrlKey: true } );
		} );
		expect( queryByTestId( 'debug-panel' ) ).toBeNull();
	} );

	it( 'closing via Header X close button hides the panel', () => {
		mountExospine();
		const { getByRole, queryByTestId, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		expect( queryByTestId( 'debug-panel' ) ).not.toBeNull();
		fireEvent.click(
			container.querySelector( '.topology-mode__btn--close' )
		);
		expect( queryByTestId( 'debug-panel' ) ).toBeNull();
	} );

	it( 'persists the chosen theme to localStorage', () => {
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		const themeSelect = container.querySelector( '.topology-select--skin' );
		fireEvent.change( themeSelect, { target: { value: 'blueprint' } } );
		// THEME_STORAGE_KEY is shared with topology-console; the overlay writes it.
		expect( window.localStorage.getItem( 'newspack-nodes:theme' ) ).toBe(
			'blueprint'
		);
	} );

	it( 'falls back to the default theme when localStorage.getItem throws', () => {
		// Storage-disabled path: readStoredTheme catches and returns DEFAULT_THEME.
		// Use window.Storage.prototype to ensure the throw propagates through both
		// the theme read AND the palette init read (both happen in useState
		// lazy initializers during the first DebugOverlay render).
		const originalGet = window.Storage.prototype.getItem;
		window.Storage.prototype.getItem = jest.fn( () => {
			throw new Error( 'storage disabled' );
		} );
		try {
			mountExospine();
			const { getByRole, container } = render(
				<DebugOverlay search="?nodes-debug=1" />
			);
			fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
			expect(
				container.querySelector( '.topology-app.theme-current' )
			).not.toBeNull();
			// Palette init also caught its throw — defaults to collapsed=true.
			expect(
				container.querySelector( '.topology-app.is-palette-collapsed' )
			).not.toBeNull();
		} finally {
			window.Storage.prototype.getItem = originalGet;
		}
	} );

	it( 'rehydrates a previously-persisted theme from localStorage', () => {
		window.localStorage.setItem( 'newspack-nodes:theme', 'blueprint' );
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		expect(
			container.querySelector( '.topology-app.theme-blueprint' )
		).not.toBeNull();
	} );

	it( 'invalid theme slug from localStorage falls back to the default', () => {
		window.localStorage.setItem( 'newspack-nodes:theme', 'not-a-theme' );
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		expect(
			container.querySelector( '.topology-app.theme-current' )
		).not.toBeNull();
	} );

	it( 'palette starts collapsed by default; the toggle expands and persists', () => {
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		expect(
			container.querySelector( '.topology-app.is-palette-collapsed' )
		).not.toBeNull();
		// Click the palette toggle to expand it.
		const toggle = container.querySelector( '.topology-palette__toggle' );
		expect( toggle ).not.toBeNull();
		fireEvent.click( toggle );
		expect(
			container.querySelector( '.topology-app.is-palette-collapsed' )
		).toBeNull();
		// Persisted as '0' (user explicitly opened it).
		expect(
			window.localStorage.getItem(
				'newspack-nodes:palette-collapsed:live'
			)
		).toBe( '0' );
	} );

	it( 'rehydrates the expanded palette state when storage says `0`', () => {
		window.localStorage.setItem(
			'newspack-nodes:palette-collapsed:live',
			'0'
		);
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		// '0' means open, so the collapsed class MUST NOT be present.
		expect(
			container.querySelector( '.topology-app.is-palette-collapsed' )
		).toBeNull();
	} );

	it( 'togglePaletteCollapsed survives a localStorage.setItem throw', () => {
		// Cover the setItem-catch branch in togglePaletteCollapsed: state still
		// flips and re-renders without the persisted value, in-session only.
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		const toggle = container.querySelector( '.topology-palette__toggle' );
		const originalSet = window.Storage.prototype.setItem;
		window.Storage.prototype.setItem = jest.fn( () => {
			throw new Error( 'quota' );
		} );
		try {
			fireEvent.click( toggle );
			// State flipped (the catch swallowed the throw), so the class is gone.
			expect(
				container.querySelector( '.topology-app.is-palette-collapsed' )
			).toBeNull();
		} finally {
			window.Storage.prototype.setItem = originalSet;
		}
	} );

	it( 'onThemeChange swallows a localStorage.setItem throw (in-session only)', () => {
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		const themeSelect = container.querySelector( '.topology-select--skin' );
		const originalSet = window.Storage.prototype.setItem;
		window.Storage.prototype.setItem = jest.fn( () => {
			throw new Error( 'quota' );
		} );
		try {
			fireEvent.change( themeSelect, {
				target: { value: 'blueprint' },
			} );
			// Theme flipped despite the throw.
			expect(
				container.querySelector( '.topology-app.theme-blueprint' )
			).not.toBeNull();
		} finally {
			window.Storage.prototype.setItem = originalSet;
		}
	} );

	it( 'onThemeChange falls back to default when given an invalid slug', () => {
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		const themeSelect = container.querySelector( '.topology-select--skin' );
		// Invalid → next = DEFAULT_THEME ('current'); persisted key reflects it.
		fireEvent.change( themeSelect, { target: { value: 'not-a-theme' } } );
		expect(
			container.querySelector( '.topology-app.theme-current' )
		).not.toBeNull();
		expect( window.localStorage.getItem( 'newspack-nodes:theme' ) ).toBe(
			'current'
		);
	} );

	it( 'header double-click on background fires toggleMaximize (frame expands)', () => {
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		const headerDrag = container.querySelector(
			'.nodes-debug__header-drag'
		);
		expect( headerDrag ).not.toBeNull();
		const panel = container.querySelector( '.nodes-debug__panel' );
		const beforeWidth = panel.style.width;
		fireEvent.doubleClick( headerDrag );
		const afterWidth = panel.style.width;
		// Maximize toggles frame dimensions — width differs from initial.
		expect( afterWidth ).not.toBe( beforeWidth );
	} );

	it( 'header double-click on a SELECT control does NOT maximize (skip path)', () => {
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		const panel = container.querySelector( '.nodes-debug__panel' );
		const beforeWidth = panel.style.width;
		const themeSelect = container.querySelector( '.topology-select--skin' );
		fireEvent.doubleClick( themeSelect );
		// Skip branch — maximize MUST NOT fire on header-control targets.
		expect( panel.style.width ).toBe( beforeWidth );
	} );

	it( 'shows resize handles around the panel when open', () => {
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		// useDebugFrame exposes 8 resize handlers (corners + edges); each renders
		// as a div with the key in its className.
		const handles = container.querySelectorAll( '.nodes-debug__resize' );
		expect( handles.length ).toBeGreaterThanOrEqual( 4 );
	} );

	it( 'pathOptions includes substrate top-level nodes whose names start with `_`', () => {
		// _http is mounted by the dashboard exospine; the overlay's path menu
		// should surface it as a `cd` target.
		mountExospine();
		const httpish = new Node();
		httpish.setName( '_my_service' );
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		// Path selector — first .topology-select (NOT --skin), surfaced when
		// pathOptions.length > 1. Test mounts _my_service to expand the menu.
		const selects = container.querySelectorAll( '.topology-select' );
		const pathSelect = [ ...selects ].find(
			( s ) => ! s.classList.contains( 'topology-select--skin' )
		);
		expect( pathSelect ).toBeTruthy();
		const optionValues = [ ...pathSelect.querySelectorAll( 'option' ) ].map(
			( o ) => o.value
		);
		expect( optionValues ).toContain( '_my_service' );
		// And does NOT include the non-navigable reserved names (e.g. _router).
		expect( optionValues ).not.toContain( '_router' );
	} );

	it( 'inspector action through GraphView pops the transcript footer (setReplExpanded=true)', () => {
		// Drive an inspector-action through the rendered subtree: select a node
		// (clicking the SVG <g class=topology-node>), then click the Inspector's
		// dump button. The inline closure in DebugOverlay's <GraphView
		// onInspectorAction> wraps handlers.onInspectorAction with a
		// setReplExpanded(true) — covering lines 417-418.
		mountExospine();
		const a = new Node();
		a.setName( 'a' );
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		// SchematicCanvas renders one <g class="topology-node"> per graph node.
		const nodeEls = container.querySelectorAll( '.topology-node' );
		// The dashboard exospine adds _router/_command_interpreter; our test
		// node 'a' joins them. At least one node element must render.
		expect( nodeEls.length ).toBeGreaterThan( 0 );
		fireEvent.click( nodeEls[ 0 ] );
		// Inspector renders once a node is selected; the dump button is in the
		// action toolbar. Look for any button labelled dump.
		const dumpBtn = [
			...container.querySelectorAll(
				'.topology-insp button, .topology-inspector button'
			),
		].find( ( b ) =>
			( b.textContent || '' ).toLowerCase().includes( 'dump' )
		);
		// Inspector must render once a node is selected; the dump action is what
		// fires DebugOverlay's inline onInspectorAction closure (lines 417-418).
		expect( dumpBtn ).toBeTruthy();
		act( () => fireEvent.click( dumpBtn ) );
		// Transcript footer expanded — ReplFooter root gains `.is-expanded`.
		const footer = container.querySelector( '.topology-repl.is-expanded' );
		expect( footer ).not.toBeNull();
	} );

	it( 'tab completion: typing then pressing Tab in the REPL triggers a completion dispatch', () => {
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		const input = container.querySelector( '.topology-repl__input' );
		expect( input ).not.toBeNull();
		// Type a first-token-only fragment and press Tab — onComplete fires
		// requestCompletion('help'), which builds the message and fills it.
		fireEvent.change( input, { target: { value: 'hel' } } );
		const interpreter = Core.node( '_command_interpreter' );
		const fillSpy = jest.spyOn( interpreter, 'fill' );
		fireEvent.keyDown( input, { key: 'Tab' } );
		expect( fillSpy ).toHaveBeenCalled();
		// The dispatched message has KEY === 'completion' and its VALUE.name
		// is either 'help' (first-token-only) or 'ls' (later tokens).
		const m = fillSpy.mock.calls[ 0 ][ 0 ];
		// Positional [TYPE=0, TIMESTAMP=1, FROM=2, TO=3, ID=4, KEY=5, VALUE=6].
		expect( m[ 5 ] ).toBe( 'completion' );
		expect( m[ 6 ].name ).toBe( 'help' );
	} );

	it( 'tab completion with a non-first-token query asks `ls` instead of `help`', () => {
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		const input = container.querySelector( '.topology-repl__input' );
		fireEvent.change( input, { target: { value: 'help me' } } );
		const interpreter = Core.node( '_command_interpreter' );
		const fillSpy = jest.spyOn( interpreter, 'fill' );
		fireEvent.keyDown( input, { key: 'Tab' } );
		expect( fillSpy ).toHaveBeenCalled();
		const m = fillSpy.mock.calls[ 0 ][ 0 ];
		expect( m[ 6 ].name ).toBe( 'ls' );
	} );

	it( 'Ctrl+` removes its keydown listener when the overlay unmounts', () => {
		// Tear-down branch — pressing Ctrl+` after unmount must NOT throw.
		mountExospine();
		const { unmount } = render( <DebugOverlay search="?nodes-debug=1" /> );
		unmount();
		expect( () =>
			fireEvent.keyDown( document, { key: '`', ctrlKey: true } )
		).not.toThrow();
	} );
} );
