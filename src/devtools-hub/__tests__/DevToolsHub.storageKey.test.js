/**
 * DevToolsHub — the floating debug overlay's node-layout storageKey is scoped
 * per active hub tab, so switching tabs loads that tab's own canvas layout
 * instead of sharing one garbage layout across every tab.
 */
import { render, fireEvent } from '@testing-library/react';
import DevToolsHub from '../DevToolsHub';
import {
	registerDevtoolsTab,
	resetDevtoolsTabs,
} from '@newspack-nodes/shared/devtools/tabRegistry';

// Capture the storageKey the overlay is mounted with. Mocking the overlay also
// keeps this test off the real overlay's FAB/graph machinery — we only care
// about the prop the hub hands down.
const overlayStorageKeys = [];
jest.mock( '../../debug-overlay/DebugOverlay', () => ( props ) => {
	overlayStorageKeys.push( props.storageKey );
	return (
		<div data-testid="overlay-mock" data-storage-key={ props.storageKey } />
	);
} );

describe( 'DevToolsHub — per-tab overlay storageKey', () => {
	beforeEach( () => {
		resetDevtoolsTabs();
		window.localStorage.clear();
		window.history.replaceState( {}, '', '/' );
		overlayStorageKeys.length = 0;
	} );

	const registerConsoleAndTwoTools = () => {
		registerDevtoolsTab( {
			id: 'topology-console',
			label: 'Console',
			host: 'hub',
			order: 0,
			component: () => <div data-testid="console" />,
		} );
		registerDevtoolsTab( {
			id: 'topology-manager',
			label: 'Topologies',
			host: 'hub',
			order: 10,
			component: () => <div data-testid="manager" />,
		} );
		registerDevtoolsTab( {
			id: 'performance',
			label: 'Performance',
			host: 'hub',
			order: 20,
			component: () => <div data-testid="performance" />,
		} );
	};

	it( 'qualifies the overlay storageKey with the active tab id', () => {
		registerConsoleAndTwoTools();
		const { getByRole, getByTestId } = render( <DevToolsHub /> );
		// Console is selected first → no overlay. Switch to a non-console tab.
		fireEvent.click( getByRole( 'tab', { name: 'Topologies' } ) );
		expect( getByTestId( 'overlay-mock' ).dataset.storageKey ).toBe(
			'newspack-nodes:debug:hub:topology-manager'
		);
	} );

	it( 'gives a different storageKey to each tab so layouts do not collide', () => {
		registerConsoleAndTwoTools();
		const { getByRole } = render( <DevToolsHub /> );
		fireEvent.click( getByRole( 'tab', { name: 'Topologies' } ) );
		fireEvent.click( getByRole( 'tab', { name: 'Performance' } ) );
		const seen = new Set( overlayStorageKeys );
		expect( seen.has( 'newspack-nodes:debug:hub:topology-manager' ) ).toBe(
			true
		);
		expect( seen.has( 'newspack-nodes:debug:hub:performance' ) ).toBe(
			true
		);
	} );
} );
