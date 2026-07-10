import { render, fireEvent, act } from '@testing-library/react';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { Node } from '../../runtime/node';

// Mock useDebugRepl to hold replReady false; isolates the readiness gate.
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
		// Register ONLY the Inspector tab so the panel skips Overview.
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
		// graphHasNodes true but replReady=false, so the gate stays building.
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
