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
		view.setName( managedName );
		return {};
	} );
	return managedName;
}

// Render the overlay (debug-enabled) and open the panel so GraphView mounts.
function openOverlay() {
	const utils = render( <DebugOverlay search="?nodes-debug=1" /> );
	act( () => {
		fireEvent.click( screen.getByRole( 'button', { name: /debug/i } ) );
	} );
	return utils;
}

describe( 'DebugOverlay — Reset Graph reinit', () => {
	it( 'calls the Core.reinit handle when Reset Graph is clicked', () => {
		mountExospine();
		// Stash a spy AFTER mountExospine so it isn't overwritten; the overlay
		// reads Core.reinit on the do-connect re-render.
		const spy = ( Core.reinit = jest.fn() );
		openOverlay();
		// A rewire surfaces the Reset Graph chip (graphDirty + reinit available).
		act( () => fireEvent.click( screen.getByTestId( 'do-connect' ) ) );
		act( () =>
			fireEvent.click( screen.getByTestId( 'chip-reset-graph' ) )
		);
		expect( spy ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'drops a user-added node but keeps reserved infra and reinit-managed nodes', () => {
		const managedName = mountWithManagedNode();
		Core.reinit = jest.fn();
		openOverlay();
		// User adds a node AFTER the overlay opened.
		act( () => {
			const u = new Node();
			u.setName( 'user-added' );
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
		mountExospine();
		Core.reinit = jest.fn();
		// User node exists BEFORE the panel opens.
		const pre = new Node();
		pre.setName( 'pre-open' );
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
	it( 'a connect gesture surfaces the Reset Layout chip (markDirty)', () => {
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
} );
