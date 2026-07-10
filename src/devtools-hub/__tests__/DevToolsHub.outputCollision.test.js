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
import {
	registerDevtoolsTab,
	resetDevtoolsTabs,
} from '@newspack-nodes/shared/devtools/tabRegistry';

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
