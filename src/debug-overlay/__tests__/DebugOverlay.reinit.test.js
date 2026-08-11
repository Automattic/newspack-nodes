/**
 * DebugOverlay — Reset Graph is deterministic and sourced from Core.
 *
 * Reset Graph removes every node, then reinit()s so each build rebuilds off
 * the canonical wiring. There is NO first-open baseline snapshot and NO reinit
 * prop — the rebuild handle lives on Core, stashed by mountExospine.
 *
 * The sibling DebugOverlay.test.js drives the REAL GraphView/CanvasFrame through
 * the canvas DOM; here we mock GraphView so a connect gesture and the two reset
 * chips are directly drivable. The mock exposes `onConnect` as a button and
 * renders a chip button for each non-null `frameProps.onReset*` handler.
 */

import { render, fireEvent, act, screen } from '@testing-library/react';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { Node } from '../../runtime/node';

// Mock GraphView: surface onConnect + the reset chips so tests can drive them.
jest.mock( '../../topology-console/components/GraphView', () => ( props ) => (
	<div data-testid="graphview-mock">
		<button
			type="button"
			data-testid="do-connect"
			onClick={ () => props.onConnect && props.onConnect( 'a', 'b' ) }
		>
			do-connect
		</button>
		<button
			type="button"
			data-testid="do-remove"
			onClick={ () => props.onRemoveNode && props.onRemoveNode( 'x' ) }
		>
			do-remove
		</button>
		<button
			type="button"
			data-testid="do-disconnect"
			onClick={ () =>
				props.onInspectorAction &&
				props.onInspectorAction( 'disconnect', 'x', null )
			}
		>
			do-disconnect
		</button>
		{ props.frameProps && props.frameProps.onResetLayout && (
			<button
				type="button"
				data-testid="chip-reset-layout"
				onClick={ props.frameProps.onResetLayout }
			>
				reset-layout
			</button>
		) }
		{ props.frameProps && props.frameProps.onResetGraph && (
			<button
				type="button"
				data-testid="chip-reset-graph"
				onClick={ props.frameProps.onResetGraph }
			>
				reset-graph
			</button>
		) }
	</div>
) );

import {
	registerDevtoolsTab,
	resetDevtoolsTabs,
} from '@newspack-nodes/shared/devtools/tabRegistry';
import InspectorTab from '../tabs/InspectorTab';
import DebugOverlay from '../DebugOverlay';

beforeEach( () => {
	Core.reset();
	window.localStorage.clear();
	// Register ONLY the Inspector tab so the panel skips the Overview default.
	resetDevtoolsTabs();
	registerDevtoolsTab( {
		id: 'inspector',
		label: 'Inspector',
		host: 'overlay',
		order: 0,
		fullBleed: true,
		component: InspectorTab,
	} );
} );

// Mount with a build registering one dashboard-managed node; returns its name.
function mountWithManagedNode() {
	const managedName = 'dashboard:view';
	mountExospine( () => {
		const view = new Node();
		view.name = managedName;
		return {};
	} );
	return managedName;
}

// Render the overlay and open the panel (mounts infra; gate renders GraphView).
function openOverlay() {
	const utils = render( <DebugOverlay search="?nodes-debug=1" /> );
	act( () => {
		fireEvent.click( screen.getByRole( 'button', { name: /debug/i } ) );
	} );
	return utils;
}

describe( 'DebugOverlay — Reset Graph (full rebuild)', () => {
	it( 'removes every node then bumps graphGeneration to rebuild the whole graph', () => {
		const managedName = mountWithManagedNode();
		openOverlay();
		// A user node + a rewire so there is something to reset.
		act( () => {
			const u = new Node();
			u.name = 'user-added';
		} );
		act( () => fireEvent.click( screen.getByTestId( 'do-connect' ) ) );
		const firstManaged = Core.node( managedName );
		const bumpSpy = jest.spyOn( Core, 'bumpGraphGeneration' );

		act( () =>
			fireEvent.click( screen.getByTestId( 'chip-reset-graph' ) )
		);

		// Full-rebuild bumped; user node gone; dashboard node rebuilt fresh.
		expect( bumpSpy ).toHaveBeenCalledTimes( 1 );
		expect( Core.node( 'user-added' ) ).toBeNull();
		expect( Core.node( managedName ) ).not.toBeNull();
		expect( Core.node( managedName ) ).not.toBe( firstManaged );
		bumpSpy.mockRestore();
	} );

	it( 'drops a user-added node and rebuilds reserved infra + the dashboard node', () => {
		const managedName = mountWithManagedNode();
		Core.rebuildable = true;
		openOverlay();
		// User adds a node AFTER the overlay opened.
		act( () => {
			const u = new Node();
			u.name = 'user-added';
		} );
		// Force a re-render so hasUserNodes recomputes from the live graph.
		act( () => fireEvent.click( screen.getByTestId( 'do-connect' ) ) );
		expect( Core.node( 'user-added' ) ).not.toBeNull();
		act( () =>
			fireEvent.click( screen.getByTestId( 'chip-reset-graph' ) )
		);
		// User node gone; reserved infra + the managed dashboard node kept.
		expect( Core.node( 'user-added' ) ).toBeNull();
		expect( Core.node( '_command_interpreter' ) ).not.toBeNull();
		expect( Core.node( '_router' ) ).not.toBeNull();
		expect( Core.node( '_output' ) ).not.toBeNull();
		expect( Core.node( managedName ) ).not.toBeNull();
	} );

	it( 'drops a user node added BEFORE the overlay opened (no first-open snapshot)', () => {
		// Build-delegated mount: Reset Graph recreates _router synchronously.
		mountExospine( () => {} );
		Core.rebuildable = true;
		// User node exists BEFORE the panel opens.
		const pre = new Node();
		pre.name = 'pre-open';
		openOverlay();
		// Surface the chip via a rewire, then reset.
		act( () => fireEvent.click( screen.getByTestId( 'do-connect' ) ) );
		expect( Core.node( 'pre-open' ) ).not.toBeNull();
		act( () =>
			fireEvent.click( screen.getByTestId( 'chip-reset-graph' ) )
		);
		expect( Core.node( 'pre-open' ) ).toBeNull();
	} );
} );

describe( 'DebugOverlay — dirty-on-rewire', () => {
	it( 'a connect gesture surfaces the Reset Layout chip (a structural change offers a fresh auto-fit)', async () => {
		// A drop/connect/disconnect/remove offers a fresh auto-fit.
		mountExospine();
		openOverlay();
		// Reset Layout chip needs an initialized layout; let the settle fire.
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 300 ) );
		} );
		expect( screen.queryByTestId( 'chip-reset-layout' ) ).toBeNull();
		act( () => fireEvent.click( screen.getByTestId( 'do-connect' ) ) );
		expect( screen.queryByTestId( 'chip-reset-layout' ) ).not.toBeNull();
	} );

	it( 'a connect gesture surfaces the Reset Graph chip when reinit is available', () => {
		mountExospine();
		Core.rebuildable = true;
		openOverlay();
		expect( screen.queryByTestId( 'chip-reset-graph' ) ).toBeNull();
		act( () => fireEvent.click( screen.getByTestId( 'do-connect' ) ) );
		expect( screen.queryByTestId( 'chip-reset-graph' ) ).not.toBeNull();
	} );

	it( 'a rewire alone does NOT surface Reset Graph without reinit (nothing to restore)', () => {
		mountExospine();
		Core.rebuildable = false;
		openOverlay();
		act( () => fireEvent.click( screen.getByTestId( 'do-connect' ) ) );
		expect( screen.queryByTestId( 'chip-reset-graph' ) ).toBeNull();
	} );

	it( 'a node removal surfaces BOTH the Reset Graph and Reset Layout chips', async () => {
		mountExospine();
		Core.rebuildable = true;
		openOverlay();
		// Reset Layout chip needs an initialized layout; let the settle fire.
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 300 ) );
		} );
		expect( screen.queryByTestId( 'chip-reset-graph' ) ).toBeNull();
		act( () => fireEvent.click( screen.getByTestId( 'do-remove' ) ) );
		expect( screen.queryByTestId( 'chip-reset-graph' ) ).not.toBeNull();
		// A structural change also offers a fresh auto-fit (Reset Layout).
		expect( screen.queryByTestId( 'chip-reset-layout' ) ).not.toBeNull();
	} );

	it( 'a disconnect surfaces the Reset Graph chip', () => {
		mountExospine();
		Core.rebuildable = true;
		openOverlay();
		expect( screen.queryByTestId( 'chip-reset-graph' ) ).toBeNull();
		act( () => fireEvent.click( screen.getByTestId( 'do-disconnect' ) ) );
		expect( screen.queryByTestId( 'chip-reset-graph' ) ).not.toBeNull();
	} );

	it( 'Reset Graph surfaces the Reset Layout chip (a rebuild offers a fresh auto-fit)', async () => {
		// Build-delegated mount so Reset Graph's fullRebuild recreates _router.
		mountExospine( () => {} );
		Core.rebuildable = true;
		openOverlay();
		// Reset Layout chip needs an initialized layout; let the settle fire.
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 300 ) );
		} );
		// A connect surfaces both chips; Reset Graph still offers a fresh fit.
		act( () => fireEvent.click( screen.getByTestId( 'do-connect' ) ) );
		expect( screen.queryByTestId( 'chip-reset-graph' ) ).not.toBeNull();
		act( () =>
			fireEvent.click( screen.getByTestId( 'chip-reset-graph' ) )
		);
		expect( screen.queryByTestId( 'chip-reset-layout' ) ).not.toBeNull();
	} );
} );
