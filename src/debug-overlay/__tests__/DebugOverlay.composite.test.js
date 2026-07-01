import { render, fireEvent, act } from '@testing-library/react';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { Node } from '../../runtime/node';

// Mock useDebugRepl so we can hold `ready` (replReady) false while the rest of
// the overlay (and useDebugGraph's coreToGraph) reports a non-empty graph. This
// isolates the composite-readiness contract: ready = replReady && graphHasNodes.
let mockReplReady = true;
jest.mock( '../useDebugRepl', () => ( {
	useDebugRepl: () => ( {
		transcript: [],
		sendLine: () => {},
		append: () => {},
		clear: () => {},
		cwd: '',
		setPath: () => {},
		ready: mockReplReady,
	} ),
} ) );

import {
	registerDevtoolsTab,
	resetDevtoolsTabs,
} from '@newspack-nodes/shared/devtools/tabRegistry';
import InspectorTab from '../tabs/InspectorTab';
import DebugOverlay from '../DebugOverlay';

describe( 'DebugOverlay composite readiness', () => {
	beforeEach( () => {
		Core.reset();
		window.localStorage.clear();
		mockReplReady = true;
		// These tests assert the Inspector canvas state; register ONLY it so the
		// panel opens to the Inspector, not the default Overview tab.
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

	it( 'canvas is NOT ready when replReady is false even though the graph has nodes', () => {
		// graphHasNodes is true (a live node in Core → coreToGraph), but the
		// overlay's own infra is not yet mounted (replReady=false), so the
		// composite gate keeps the canvas in the building state — never laying
		// out a partial graph that is missing the overlay's infra nodes.
		mockReplReady = false;
		mountExospine();
		const a = new Node();
		a.name = 'a';
		const { getByRole, container } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		expect(
			container.querySelector( '.nodes-debug__canvas-building' )
		).not.toBeNull();
		expect( container.querySelectorAll( '.topology-node' ).length ).toBe(
			0
		);
	} );

	it( 'canvas becomes ready once replReady is true and the graph has nodes', async () => {
		mockReplReady = true;
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
		expect(
			container.querySelector( '.nodes-debug__canvas-building' )
		).toBeNull();
		expect(
			container.querySelectorAll( '.topology-node' ).length
		).toBeGreaterThan( 0 );
	} );
} );
