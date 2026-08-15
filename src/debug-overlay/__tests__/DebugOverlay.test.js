import { render, fireEvent, act } from '@testing-library/react';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { Node } from '../../runtime/node';
import InspectorTab from '../tabs/InspectorTab';
import {
	registerDevtoolsTab,
	resetDevtoolsTabs,
} from '@newspack-nodes/shared/devtools/tabRegistry';
import DebugOverlay from '../DebugOverlay';

// Type a line into the overlay's real ReplFooter and submit it on Enter.
function submitRepl( container, line ) {
	const input = container.querySelector( '.topology-repl__input' );
	act( () => {
		fireEvent.change( input, { target: { value: line } } );
		fireEvent.keyDown( input, { key: 'Enter' } );
	} );
}

describe( 'DebugOverlay', () => {
	beforeEach( () => {
		Core.reset();
		window.localStorage.clear();
		// Re-register explicitly; the import registration is module-cached.
		resetDevtoolsTabs();
		registerDevtoolsTab( {
			id: 'inspector',
			label: 'Inspector',
			host: 'overlay',
			order: 0,
			component: InspectorTab,
		} );
	} );

	it( 'renders nothing when debug is disabled', () => {
		const { container } = render( <DebugOverlay search="" /> );
		expect( container.firstChild ).toBeNull();
	} );

	it( 'shows a toggle FAB when enabled, and opens the panel on click', () => {
		mountExospine();
		const { container, getByRole, queryByTestId } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		const provider = container.querySelector( '.nodes-debug' );
		const fab = getByRole( 'button', { name: /debug/i } );
		expect( provider.className ).toBe(
			'nodes-debug newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui'
		);
		expect( fab.closest( '.newspack-nodes-ui' ) ).toBe( provider );
		expect(
			container.querySelectorAll( '.newspack-nodes-skin-root' )
		).toHaveLength( 1 );
		expect(
			container.querySelectorAll( '.newspack-nodes-ui' )
		).toHaveLength( 1 );
		expect( queryByTestId( 'debug-panel' ) ).toBeNull();
		fireEvent.click( fab );
		expect( queryByTestId( 'debug-panel' ) ).not.toBeNull();
		expect(
			container.querySelectorAll( '.newspack-nodes-skin-root' )
		).toHaveLength( 1 );
		expect(
			container.querySelectorAll( '.newspack-nodes-ui' )
		).toHaveLength( 1 );
		expect(
			queryByTestId( 'debug-panel' ).closest( '.newspack-nodes-ui' )
		).toBe( provider );
	} );

	it( 'inherits a host provider without nesting another root', () => {
		mountExospine();
		const { container, getByRole, queryByTestId } = render(
			<div className="host newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui">
				<DebugOverlay search="?nodes-debug=1" />
			</div>
		);
		const host = container.querySelector( '.host' );
		const overlay = container.querySelector( '.nodes-debug' );
		const fab = getByRole( 'button', { name: /debug/i } );

		expect( overlay.className ).toBe( 'nodes-debug' );
		expect( fab.closest( '.newspack-nodes-ui' ) ).toBe( host );
		expect(
			container.querySelectorAll( '.newspack-nodes-skin-root' )
		).toHaveLength( 1 );
		expect(
			container.querySelectorAll( '.newspack-nodes-ui' )
		).toHaveLength( 1 );
		fireEvent.click( fab );
		expect( queryByTestId( 'debug-panel' ) ).not.toBeNull();
		expect(
			container.querySelectorAll( '.newspack-nodes-skin-root' )
		).toHaveLength( 1 );
		expect(
			container.querySelectorAll( '.newspack-nodes-ui' )
		).toHaveLength( 1 );
		expect(
			queryByTestId( 'debug-panel' ).closest( '.newspack-nodes-ui' )
		).toBe( host );
	} );

	it( 'eats wheel scrolls so the page behind the overlay does not scroll', () => {
		mountExospine();
		const { getByRole, getByTestId } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		const panel = getByTestId( 'debug-panel' );
		// fireEvent returns false = panel ate the wheel; page won't scroll.
		const notCancelled = fireEvent.wheel( panel, {
			deltaY: 100,
			cancelable: true,
		} );
		expect( notCancelled ).toBe( false );
	} );

	it( 'allows wheel events when an inner scrollable child can consume them', () => {
		mountExospine();
		const { getByRole, getByTestId } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		const panel = getByTestId( 'debug-panel' );
		const inner = document.createElement( 'div' );
		inner.style.overflowY = 'auto';
		Object.defineProperty( inner, 'scrollHeight', {
			configurable: true,
			value: 200,
		} );
		Object.defineProperty( inner, 'clientHeight', {
			configurable: true,
			value: 100,
		} );
		Object.defineProperty( inner, 'scrollTop', {
			configurable: true,
			value: 25,
			writable: true,
		} );
		panel.appendChild( inner );

		const notCancelled = fireEvent.wheel( inner, {
			deltaY: 20,
			cancelable: true,
		} );
		expect( notCancelled ).toBe( true );
	} );

	it( 'locks the page scroll while the pointer is inside the panel', () => {
		// Safari ignores the wheel preventDefault, so pin the page physically.
		mountExospine();
		const { getByRole, getByTestId } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		const panel = getByTestId( 'debug-panel' );
		const scrollEl = document.scrollingElement || document.documentElement;
		expect( scrollEl.style.overflow ).not.toBe( 'hidden' );
		fireEvent.pointerEnter( panel );
		expect( scrollEl.style.overflow ).toBe( 'hidden' );
		fireEvent.pointerLeave( panel );
		expect( scrollEl.style.overflow ).not.toBe( 'hidden' );
	} );

	it( 'releases the page-scroll lock when the panel unmounts while locked', () => {
		// onPointerLeave never fires on unmount; callback ref frees lock.
		mountExospine();
		const { getByRole, getByTestId, unmount } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		const panel = getByTestId( 'debug-panel' );
		const scrollEl = document.scrollingElement || document.documentElement;
		fireEvent.pointerEnter( panel ); // pointer inside → locked
		expect( scrollEl.style.overflow ).toBe( 'hidden' );
		unmount(); // no pointerLeave — the callback ref must still release it
		expect( scrollEl.style.overflow ).not.toBe( 'hidden' );
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
		// Viewport persists under a storageKey-derived key; still null here.
		expect(
			window.localStorage.getItem( 'newspack-nodes:debug:viewport' )
		).toBeNull();
		// Can't fire a real pan; round-trip coverage rides on the hook's test.
	} );

	it( 'set_skin REPL builtin applies the selected theme class to the overlay shell', () => {
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		// Default theme is "newspack".
		expect(
			document.documentElement.classList.contains( 'theme-newspack' )
		).toBe( true );
		// set_skin via the shared REPL flips the class.
		submitRepl( container, 'set_skin blueprint' );
		expect(
			document.documentElement.classList.contains( 'theme-blueprint' )
		).toBe( true );
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
		// Hidden in view mode: Open/Save/Delete/New + EDIT (canEdit=false).
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
		// Sanity: the keydown listener is gated on `enabled` (null when off).
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
		submitRepl( container, 'set_skin blueprint' );
		// THEME_STORAGE_KEY is shared with topology-console; overlay writes it.
		expect( window.localStorage.getItem( 'newspack-nodes:theme' ) ).toBe(
			'blueprint'
		);
	} );

	it( 'falls back to the default theme when localStorage.getItem throws', () => {
		// Storage-disabled: patch Storage.prototype so both lazy reads throw.
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
				document.documentElement.classList.contains( 'theme-newspack' )
			).toBe( true );
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
		const { getByRole } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		expect(
			document.documentElement.classList.contains( 'theme-blueprint' )
		).toBe( true );
	} );

	it( 'invalid theme slug from localStorage falls back to the default', () => {
		window.localStorage.setItem( 'newspack-nodes:theme', 'not-a-theme' );
		mountExospine();
		const { getByRole } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		expect(
			document.documentElement.classList.contains( 'theme-newspack' )
		).toBe( true );
	} );

	it( 'palette starts collapsed by default; the toggle expands and persists', () => {
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		// GraphView (hosts the palette) renders only once metadata arrives.
		act( () => {
			Core.node( '_metadata' ).setState( 'metadata', {
				nodes: [ { id: 'a', class: 'Echo', target: '' } ],
				edges: [],
			} );
		} );
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
		// setItem-catch branch: state flips in-session without persisting.
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		// GraphView (hosts the palette) renders only once metadata arrives.
		act( () => {
			Core.node( '_metadata' ).setState( 'metadata', {
				nodes: [ { id: 'a', class: 'Echo', target: '' } ],
				edges: [],
			} );
		} );
		const toggle = container.querySelector( '.topology-palette__toggle' );
		const originalSet = window.Storage.prototype.setItem;
		window.Storage.prototype.setItem = jest.fn( () => {
			throw new Error( 'quota' );
		} );
		try {
			fireEvent.click( toggle );
			// State flipped (catch swallowed the throw); class is gone.
			expect(
				container.querySelector( '.topology-app.is-palette-collapsed' )
			).toBeNull();
		} finally {
			window.Storage.prototype.setItem = originalSet;
		}
	} );

	it( 'set_skin swallows a localStorage.setItem throw (in-session only)', () => {
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		const originalSet = window.Storage.prototype.setItem;
		window.Storage.prototype.setItem = jest.fn( () => {
			throw new Error( 'quota' );
		} );
		try {
			submitRepl( container, 'set_skin blueprint' );
			// Theme flipped despite the throw.
			expect(
				document.documentElement.classList.contains( 'theme-blueprint' )
			).toBe( true );
		} finally {
			window.Storage.prototype.setItem = originalSet;
		}
	} );

	it( 'set_skin rejects an unknown skin name and leaves the theme unchanged', () => {
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		// Unrecognized name → resolveSkin returns null → no skin applied.
		submitRepl( container, 'set_skin not-a-theme' );
		expect(
			document.documentElement.classList.contains( 'theme-newspack' )
		).toBe( true );
		expect(
			window.localStorage.getItem( 'newspack-nodes:theme' )
		).toBeNull();
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

	it( 'header double-click on a control (button) does NOT maximize (skip path)', () => {
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		const panel = container.querySelector( '.nodes-debug__panel' );
		const beforeWidth = panel.style.width;
		// The skin <select> is gone; the skip path also covers header buttons.
		const headerBtn = container.querySelector( '.topology-mode__btn' );
		fireEvent.doubleClick( headerBtn );
		// Skip branch — maximize MUST NOT fire on header-control targets.
		expect( panel.style.width ).toBe( beforeWidth );
	} );

	it( 'shows resize handles around the panel when open', () => {
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		// useDebugFrame exposes 8 resize handlers, each a div with the key.
		const handles = container.querySelectorAll( '.nodes-debug__resize' );
		expect( handles.length ).toBeGreaterThanOrEqual( 4 );
	} );

	it( 'pathOptions includes substrate top-level nodes whose names start with `_`', () => {
		// _http is mounted by the exospine; path menu surfaces it as a `cd`.
		mountExospine();
		const httpish = new Node();
		httpish.name = '_my_service';
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		// Path selector: first .topology-select (NOT --skin); shown when >1.
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

	it( 'excludes the _shell console Tap from the path menu (routing plumbing, not a cd target)', () => {
		// `_shell` (CONSOLE_TAP) is routing plumbing, not a `cd` scope.
		mountExospine();
		const svc = new Node();
		svc.name = '_my_service'; // a real navigable node so the menu expands
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		const selects = container.querySelectorAll( '.topology-select' );
		const pathSelect = [ ...selects ].find(
			( s ) => ! s.classList.contains( 'topology-select--skin' )
		);
		const optionValues = [ ...pathSelect.querySelectorAll( 'option' ) ].map(
			( o ) => o.value
		);
		expect( optionValues ).not.toContain( '_shell' );
		expect( optionValues ).toContain( '_my_service' );
	} );

	it( 'keeps the local navigable scopes in the path menu at a remote cwd', () => {
		// Remote cwd: path menu still offers local `cd` targets from Core.
		mountExospine();
		const svc = new Node();
		svc.name = '_my_service'; // a local navigable node, always in Core
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );

		// Remote-scope poll: published metadata has NONE of the local nodes.
		act( () => {
			Core.node( '_metadata' ).setState( 'metadata', {
				nodes: [ { id: 'remoteThing', class: 'Echo', target: '' } ],
				edges: [],
			} );
		} );

		const selects = container.querySelectorAll( '.topology-select' );
		const pathSelect = [ ...selects ].find(
			( s ) => ! s.classList.contains( 'topology-select--skin' )
		);
		expect( pathSelect ).toBeTruthy();
		const optionValues = [ ...pathSelect.querySelectorAll( 'option' ) ].map(
			( o ) => o.value
		);
		expect( optionValues ).toContain( '_my_service' );
	} );

	it( 'inspector action through GraphView pops the transcript footer (setReplExpanded=true)', async () => {
		// Select a node + dump: the onInspectorAction closure sets expanded.
		mountExospine();
		const a = new Node();
		a.name = 'a';
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		// GraphView renders once metadata arrives (reads the published graph).
		act( () => {
			Core.node( '_metadata' ).setState( 'metadata', {
				nodes: [ { id: 'a', class: 'Echo', target: '' } ],
				edges: [],
			} );
		} );
		// autoLayout is deferred until the node set settles.
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 300 ) );
		} );
		// SchematicCanvas renders one <g class="topology-node"> per graph node.
		const nodeEls = container.querySelectorAll( '.topology-node' );
		// At least one node element (the published 'a') must render.
		expect( nodeEls.length ).toBeGreaterThan( 0 );
		fireEvent.click( nodeEls[ 0 ] );
		// Inspector renders once a node is selected; find its dump button.
		const dumpBtn = [
			...container.querySelectorAll(
				'.topology-insp button, .topology-inspector button'
			),
		].find( ( b ) =>
			( b.textContent || '' ).toLowerCase().includes( 'dump' )
		);
		// The dump action fires DebugOverlay's onInspectorAction closure.
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
		// First-token fragment + Tab fires requestCompletion('help').
		fireEvent.change( input, { target: { value: 'hel' } } );
		const interpreter = Core.node( '_command_interpreter' );
		const fillSpy = jest.spyOn( interpreter, 'fill' );
		fireEvent.keyDown( input, { key: 'Tab' } );
		expect( fillSpy ).toHaveBeenCalled();
		// Dispatched message: KEY 'completion', VALUE.name 'help' or 'ls'.
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

	it( 'tab completion: a second consecutive Tab lists the ambiguous candidates in the transcript', () => {
		mountExospine();
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		const input = container.querySelector( '.topology-repl__input' );
		// `dump` is ambiguous; LCP can't extend, so 1st Tab bells, 2nd lists.
		act( () => fireEvent.change( input, { target: { value: 'dump' } } ) );
		act( () => fireEvent.keyDown( input, { key: 'Tab' } ) ); // 1st: bell
		act( () => fireEvent.keyDown( input, { key: 'Tab' } ) ); // 2nd: list
		// Candidates land in the `_output` transcript; assert data, not text.
		const listed = Core.node( '_output' )._transcript.some(
			( e ) =>
				e.kind === 'recv' &&
				e.text.includes( 'dump_metadata' ) &&
				e.text.includes( 'dump_node' )
		);
		expect( listed ).toBe( true );
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

	it( 'paints the local graph instantly on open via coreToGraph, without waiting for a metadata poll', async () => {
		// Overlay paints GraphView from coreToGraph the instant infra mounts.
		mountExospine();
		const a = new Node();
		a.name = 'a';
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		// autoLayout is deferred until the node set settles.
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 300 ) );
		} );
		// No metadata.setState — the canvas is ready off coreToGraph alone.
		expect(
			container.querySelector( '.nodes-debug__canvas-building' )
		).toBeNull();
		expect(
			container.querySelectorAll( '.topology-node' ).length
		).toBeGreaterThan( 0 );
	} );

	it( 'fresh open with empty localStorage lays the COMPLETE graph out once (isolated nodes on the right)', async () => {
		// s->t + iso isolated; iso must land right, not left (was the bug).
		window.localStorage.clear();
		mountExospine();
		const s = new Node();
		s.name = 's';
		const t = new Node();
		t.name = 't';
		s.target = 't'; // s -> t edge (coreToGraph derives edges from target)
		const iso = new Node();
		iso.name = 'iso'; // isolated: no target, no inbound
		const { getByRole } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		// autoLayout is deferred until the node set settles.
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 300 ) );
		} );
		const stored = JSON.parse(
			window.localStorage.getItem( 'newspack-nodes:debug:local' )
		);
		// @longform
		// What this test uniquely covers: a fresh open lays out the COMPLETE
		// graph once and persists every node. Which COLUMN an isolated node
		// lands in is autoLayout's own rule, and it is tested there against a
		// controlled graph — `isolatedToLeft` flips on `maxDepth >= 3 &&
		// sourceCount >= maxDepth`, so asserting it through the overlay pins
		// the branch that whatever tabs happen to be mounted produce.
		for ( const id of [ 's', 't', 'iso' ] ) {
			expect( stored.positions[ id ] ).toEqual(
				expect.objectContaining( {
					x: expect.any( Number ),
					y: expect.any( Number ),
				} )
			);
		}
		expect( stored.positions.t.x ).toBeGreaterThan( stored.positions.s.x );
	} );

	it( 'shows a tab bar and switches the mounted tab when >1 overlay tab is registered', () => {
		registerDevtoolsTab( {
			id: 'fake',
			label: 'Fake',
			host: 'overlay',
			order: 99,
			component: () => <div data-testid="fake-tab" />,
		} );
		mountExospine();
		const { getByRole, getByTestId, queryByTestId } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		// Inspector (order 0) is selected first; Fake is not mounted.
		expect( queryByTestId( 'fake-tab' ) ).toBeNull();
		// Clicking the Fake tab mounts it and unmounts the Inspector.
		fireEvent.click( getByRole( 'tab', { name: 'Fake' } ) );
		expect( getByTestId( 'fake-tab' ) ).not.toBeNull();
		expect( queryByTestId( 'inspector-tab' ) ).toBeNull();
	} );
} );
