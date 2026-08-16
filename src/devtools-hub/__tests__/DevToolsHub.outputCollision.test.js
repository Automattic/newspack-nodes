/**
 * Regression for the white-screen on switching to the Console tab while the
 * debug overlay is open: `Uncaught Error: node name collision: _output already
 * registered`.
 *
 * The overlay registers `_output` (DumperNode) during render (useDebugRepl's
 * build-before-render); the Console-style tab registers `_output` in a mount
 * useEffect. The hub gates the overlay off the Console tab via `activeTabId`,
 * but that id was set from a useEffect — one commit LATE. So on switch the
 * Console mounts (and tries to register `_output`) while the overlay is still
 * rendered (still holds `_output`) → collision → white screen.
 *
 * The fix drives onActiveTabChange synchronously from the tab onClick so the
 * overlay unmounts in the SAME commit the Console mounts; React runs passive
 * cleanups (overlay's _output removal) before passive effects (Console's
 * _output registration), so there is no collision.
 *
 * The earlier tests stubbed tabs with trivial `() => <div/>` components, which
 * never registered `_output` — that is why this slipped. This test mounts the
 * real overlay (its real useDebugRepl registers `_output`) and a faithful
 * console-ish tab that registers a real runtime `_output` node on mount.
 */
import { useEffect } from '@wordpress/element';
import { render, fireEvent } from '@testing-library/react';
import DevToolsHub from '../DevToolsHub';
import { Core } from '../../runtime/core';
import { DumperNode } from '../../runtime/dumper-node';
import names from '../../runtime/reserved-node-names.json';
import InspectorTab from '../../debug-overlay/tabs/InspectorTab';
import { useClassCatalog } from '../../topology-console/hooks/useCatalogs';
import {
	registerDevtoolsTab,
	resetDevtoolsTabs,
} from '@newspack-nodes/shared/devtools/tabRegistry';

// The hub Console's own class catalog, under the names the palette uses.
function CatalogTab() {
	useClassCatalog( { enabled: true } );
	return <div data-testid="catalog" />;
}

// Faithful console-ish tab: registers `_output` on mount, removes on unmount.
function ConsoleishTab() {
	useEffect( () => {
		const dumper = new DumperNode();
		dumper.name = names.OUTPUT;
		return () => dumper.removeNode();
	}, [] );
	return <div data-testid="consoleish" />;
}

describe( 'DevToolsHub _output collision on switch-to-Console', () => {
	beforeEach( () => {
		resetDevtoolsTabs();
		Core.reset();
		window.localStorage.clear();
		window.history.replaceState( {}, '', '/' );
		// Sticky flag → isDebugEnabled true → the overlay mounts.
		window.localStorage.setItem( 'newspack-nodes:debug', '1' );
		// Re-register the Inspector tab (reset wiped it) → real `_output`.
		registerDevtoolsTab( {
			id: 'inspector',
			label: 'Inspector',
			host: 'overlay',
			order: 0,
			fullBleed: true,
			component: InspectorTab,
		} );
	} );

	const registerTabs = () => {
		// Non-console first tab (overlay is allowed here).
		registerDevtoolsTab( {
			id: 'topology-manager',
			label: 'Topologies',
			host: 'hub',
			order: 0,
			component: () => <div data-testid="manager" />,
		} );
		// Console tab: overlay gated OFF; registers `_output` on mount.
		registerDevtoolsTab( {
			id: 'topology-console',
			label: 'Console',
			host: 'hub',
			order: 10,
			component: ConsoleishTab,
		} );
	};

	// @longform The same collision from the other side: the hub's Console tab
	// holds the class catalog, and opening the OVERLAY's Console tab on top of
	// it mounts a second copy of the same graph. Its catalog is disabled there
	// — the page's own Console owns the graph and REPL — and a disabled slice
	// that still builds its nodes claims names the enabled one is using.
	it( 'does not throw when the overlay Console opens over the hub Console', () => {
		registerDevtoolsTab( {
			id: 'topology-manager',
			label: 'Topologies',
			host: 'hub',
			order: 0,
			component: () => <div data-testid="manager" />,
		} );
		registerDevtoolsTab( {
			id: 'topology-console',
			label: 'Console',
			host: 'hub',
			order: 10,
			component: CatalogTab,
		} );
		registerDevtoolsTab( {
			id: 'console',
			label: 'Console',
			host: 'overlay',
			order: 1,
			fullBleed: true,
			component: InspectorTab,
		} );
		const { getByRole, getAllByRole } = render( <DevToolsHub /> );

		fireEvent.click( getAllByRole( 'tab', { name: 'Console' } )[ 0 ] );
		fireEvent.click( getByRole( 'button', { name: /node debugger/i } ) );

		const overlayConsole = getAllByRole( 'tab', { name: 'Console' } )[ 1 ];
		expect( () => fireEvent.click( overlayConsole ) ).not.toThrow();
	} );

	it( 'does not throw a node-name collision when switching to Console with the overlay open', () => {
		registerTabs();
		const { getByRole } = render( <DevToolsHub /> );

		// Open overlay on the non-console tab → useDebugRepl regs `_output`.
		fireEvent.click( getByRole( 'button', { name: /node debugger/i } ) );
		expect( Core.node( names.OUTPUT ) ).not.toBeNull();

		// Switch to Console; before the fix this threw a `_output` collision.
		expect( () =>
			fireEvent.click( getByRole( 'tab', { name: 'Console' } ) )
		).not.toThrow();
	} );
} );
