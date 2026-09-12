/**
 * Station — the floating debug overlay's node-layout storageKey is scoped
 * per active station tab, so switching tabs loads that tab's own canvas layout
 * instead of sharing one garbage layout across every tab.
 */
import { render, fireEvent } from '@testing-library/react';
import Station from '../Station';
import {
	registerTab,
	resetTabs,
} from '@newspack-nodes/shared/tabs/tabRegistry';

// Capture the storageKey prop the station hands the mocked overlay (no FAB/graph).
const overlayStorageKeys = [];
jest.mock( '../../debug-overlay/DebugOverlay', () => ( props ) => {
	overlayStorageKeys.push( props.storageKey );
	return (
		<div data-testid="overlay-mock" data-storage-key={ props.storageKey } />
	);
} );

describe( 'Station — per-tab overlay storageKey', () => {
	beforeEach( () => {
		resetTabs();
		window.localStorage.clear();
		window.history.replaceState( {}, '', '/' );
		overlayStorageKeys.length = 0;
	} );

	const registerConsoleAndTwoTools = () => {
		registerTab( {
			id: 'topology-console',
			label: 'Console',
			host: 'station',
			order: 0,
			component: () => <div data-testid="console" />,
		} );
		registerTab( {
			id: 'topology-manager',
			label: 'Topologies',
			host: 'station',
			order: 10,
			component: () => <div data-testid="manager" />,
		} );
		registerTab( {
			id: 'performance',
			label: 'Performance',
			host: 'station',
			order: 20,
			component: () => <div data-testid="performance" />,
		} );
	};

	it( 'qualifies the overlay storageKey with the active tab id', () => {
		registerConsoleAndTwoTools();
		const { getByRole, getByTestId } = render( <Station /> );
		// Console is selected first → no overlay. Switch to a non-console tab.
		fireEvent.click( getByRole( 'tab', { name: 'Topologies' } ) );
		expect( getByTestId( 'overlay-mock' ).dataset.storageKey ).toBe(
			'newspack-nodes:debug:station:topology-manager'
		);
	} );

	it( 'gives a different storageKey to each tab so layouts do not collide', () => {
		registerConsoleAndTwoTools();
		const { getByRole } = render( <Station /> );
		fireEvent.click( getByRole( 'tab', { name: 'Topologies' } ) );
		fireEvent.click( getByRole( 'tab', { name: 'Performance' } ) );
		const seen = new Set( overlayStorageKeys );
		expect(
			seen.has( 'newspack-nodes:debug:station:topology-manager' )
		).toBe( true );
		expect( seen.has( 'newspack-nodes:debug:station:performance' ) ).toBe(
			true
		);
	} );
} );
