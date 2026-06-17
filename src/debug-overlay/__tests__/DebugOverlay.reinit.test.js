/**
 * DebugOverlay — Reset Graph is deterministic and sourced from Core.
 *
 * Reset Graph keeps reserved infra names ∪ Core.reinitNames (the nodes the
 * dashboard build registered), reinit()s to restore wiring, and unregisters
 * everything else. There is NO first-open baseline snapshot and NO reinit
 * prop — the handle and the managed-name set both live on Core, stashed by
 * mountExospine.
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

import DebugOverlay from '../DebugOverlay';

beforeEach( () => {
	Core.reset();
	window.localStorage.clear();
} );

// Mount the exospine with a build that registers one dashboard-managed node, so
// its name lands in Core.reinitNames. Returns that node's name.
function mountWithManagedNode() {
	const managedName = 'dashboard:view';
	mountExospine( () => {
		const view = new Node();
		view.name = managedName;
		return {};
	} );
	return managedName;
}

// Render the overlay (debug-enabled) and open the panel. Opening mounts the
// overlay's own infra (_output/_completion/_metadata/_cwd), so coreToGraph()
// yields a non-empty (reserved-only) graph and the readiness gate renders
// GraphView immediately — no metadata poll needed, and the reserved infra
// nodes never count as user-added (so Reset Graph stays hidden until a gesture).
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

		// Bumped the full-rebuild signal; the user node is gone; the dashboard's
		// build node rebuilt fresh (a fresh instance, not the original).
		expect( bumpSpy ).toHaveBeenCalledTimes( 1 );
		expect( Core.node( 'user-added' ) ).toBeNull();
		expect( Core.node( managedName ) ).not.toBeNull();
		expect( Core.node( managedName ) ).not.toBe( firstManaged );
		bumpSpy.mockRestore();
	} );

	it( 'drops a user-added node and rebuilds reserved infra + the dashboard node', () => {
		const managedName = mountWithManagedNode();
		Core.reinit = jest.fn();
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
		// Build-delegated mount (production overlays are dashboard-mounted): Reset
		// Graph's fullRebuild recreates _router synchronously, so useDebugRepl re-arms
		// metadata on the fresh router with no missing-_router transient.
		mountExospine( () => {} );
		Core.reinit = jest.fn();
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
	it( 'a connect gesture surfaces the Reset Layout chip (a structural change offers a fresh auto-fit)', () => {
		// A drop / connect / disconnect / remove changes the structure, so the
		// canvas offers a fresh auto-fit (Reset Layout) alongside Reset Graph.
		mountExospine();
		openOverlay();
		expect( screen.queryByTestId( 'chip-reset-layout' ) ).toBeNull();
		act( () => fireEvent.click( screen.getByTestId( 'do-connect' ) ) );
		expect( screen.queryByTestId( 'chip-reset-layout' ) ).not.toBeNull();
	} );

	it( 'a connect gesture surfaces the Reset Graph chip when reinit is available', () => {
		mountExospine();
		Core.reinit = jest.fn();
		openOverlay();
		expect( screen.queryByTestId( 'chip-reset-graph' ) ).toBeNull();
		act( () => fireEvent.click( screen.getByTestId( 'do-connect' ) ) );
		expect( screen.queryByTestId( 'chip-reset-graph' ) ).not.toBeNull();
	} );

	it( 'a rewire alone does NOT surface Reset Graph without reinit (nothing to restore)', () => {
		mountExospine();
		Core.reinit = null;
		openOverlay();
		act( () => fireEvent.click( screen.getByTestId( 'do-connect' ) ) );
		expect( screen.queryByTestId( 'chip-reset-graph' ) ).toBeNull();
	} );

	it( 'a node removal surfaces BOTH the Reset Graph and Reset Layout chips', () => {
		mountExospine();
		Core.reinit = jest.fn();
		openOverlay();
		expect( screen.queryByTestId( 'chip-reset-graph' ) ).toBeNull();
		act( () => fireEvent.click( screen.getByTestId( 'do-remove' ) ) );
		expect( screen.queryByTestId( 'chip-reset-graph' ) ).not.toBeNull();
		// A structural change also offers a fresh auto-fit (Reset Layout).
		expect( screen.queryByTestId( 'chip-reset-layout' ) ).not.toBeNull();
	} );

	it( 'a disconnect surfaces the Reset Graph chip', () => {
		mountExospine();
		Core.reinit = jest.fn();
		openOverlay();
		expect( screen.queryByTestId( 'chip-reset-graph' ) ).toBeNull();
		act( () => fireEvent.click( screen.getByTestId( 'do-disconnect' ) ) );
		expect( screen.queryByTestId( 'chip-reset-graph' ) ).not.toBeNull();
	} );

	it( 'Reset Graph surfaces the Reset Layout chip (a rebuild offers a fresh auto-fit)', () => {
		// Build-delegated mount so Reset Graph's fullRebuild recreates _router.
		mountExospine( () => {} );
		Core.reinit = jest.fn();
		openOverlay();
		// A connect surfaces both chips; Reset Graph keeps the layout but still
		// offers a fresh auto-fit (Reset Layout) after the rebuild.
		act( () => fireEvent.click( screen.getByTestId( 'do-connect' ) ) );
		expect( screen.queryByTestId( 'chip-reset-graph' ) ).not.toBeNull();
		act( () =>
			fireEvent.click( screen.getByTestId( 'chip-reset-graph' ) )
		);
		expect( screen.queryByTestId( 'chip-reset-layout' ) ).not.toBeNull();
	} );
} );
