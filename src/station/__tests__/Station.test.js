import { render, fireEvent } from '@testing-library/react';
import Station from '../Station';
import {
	registerTab,
	resetTabs,
} from '@newspack-nodes/shared/tabs/tabRegistry';

describe( 'Station', () => {
	beforeEach( () => {
		resetTabs();
		window.localStorage.clear();
		window.history.replaceState( {}, '', '/' );
	} );

	it( 'syncs the active tab into ?tab= (deep-linkable)', () => {
		registerTab( {
			id: 'topology-console',
			label: 'Console',
			host: 'station',
			slug: 'console',
			order: 0,
			component: () => <div data-testid="console" />,
		} );
		render( <Station /> );
		expect(
			new URLSearchParams( window.location.search ).get( 'tab' )
		).toBe( 'console' );
	} );

	it( 'shows the empty state when no station tabs are registered', () => {
		const { getByText } = render( <Station /> );
		expect( getByText( /no tools registered/i ) ).not.toBeNull();
	} );

	it( 'renders a registered station tab', () => {
		registerTab( {
			id: 'demo',
			label: 'Demo',
			host: 'station',
			component: () => <div data-testid="demo" />,
		} );
		const { getByTestId } = render( <Station /> );
		expect( getByTestId( 'demo' ) ).not.toBeNull();
	} );

	it( 'wraps the tab host in a full-height fixed admin-page container', () => {
		registerTab( {
			id: 'demo',
			label: 'Demo',
			host: 'station',
			component: () => <div data-testid="demo" />,
		} );
		const { container } = render( <Station /> );
		// firstChild is the token host; .nodes-station is the fixed box.
		const page = container.querySelector( '.nodes-station' );
		expect( page.style.position ).toBe( 'fixed' );
		expect( page.style.top ).toBe( '32px' );
		expect( page.style.right ).toBe( '0px' );
		expect( page.style.bottom ).toBe( '0px' );
	} );

	it( 'owns one non-graph skin provider without repeating provider classes on the station', () => {
		registerTab( {
			id: 'demo',
			label: 'Demo',
			host: 'station',
			component: () => <div data-testid="demo" />,
		} );
		const { container } = render( <Station /> );
		const provider = container.firstElementChild;
		const station = container.querySelector( '.nodes-station' );

		expect( provider.className ).toBe(
			'newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui'
		);
		expect( station.className ).toBe( 'nodes-station' );
		expect( station.closest( '.newspack-nodes-theme' ) ).toBe( provider );
		expect(
			station.querySelectorAll( '.newspack-nodes-theme' )
		).toHaveLength( 0 );
	} );

	it( 'renders the console first and topologies second when both are registered', () => {
		registerTab( {
			id: 'topology-manager',
			label: 'Topologies',
			host: 'station',
			order: 10,
			component: () => <div data-testid="manager" />,
		} );
		registerTab( {
			id: 'topology-console',
			label: 'Console',
			host: 'station',
			order: 0,
			component: () => <div data-testid="console" />,
		} );
		const { getAllByRole, getByTestId, queryByTestId } = render(
			<Station />
		);
		const tabs = getAllByRole( 'tab' ).map( ( t ) => t.textContent );
		expect( tabs ).toEqual( [ 'Console', 'Topologies' ] );
		// Order 0 (console) is selected first; the host lazy-mounts only it.
		expect( getByTestId( 'console' ) ).not.toBeNull();
		expect( queryByTestId( 'manager' ) ).toBeNull();
	} );

	describe( 'debug overlay gating', () => {
		// FAB gates on isDebugEnabled; sans ?nodes-debug, reads localStorage.
		const enableDebug = () =>
			window.localStorage.setItem( 'newspack-nodes:debug', '1' );

		const registerConsoleAndManager = () => {
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
		};

		it( 'shows the debug overlay FAB on the Console tab too (Overview-only there)', () => {
			enableDebug();
			registerConsoleAndManager();
			const { getByRole } = render( <Station /> );
			// Console selected first; overlay rides it, REPL Overview-only.
			expect(
				getByRole( 'button', { name: /node debugger/i } )
			).not.toBeNull();
		} );

		it( 'keeps the debug overlay FAB mounted across tabs', () => {
			enableDebug();
			registerConsoleAndManager();
			const { getByRole } = render( <Station /> );
			expect(
				getByRole( 'button', { name: /node debugger/i } )
			).not.toBeNull();
			fireEvent.click( getByRole( 'tab', { name: 'Topologies' } ) );
			expect(
				getByRole( 'button', { name: /node debugger/i } )
			).not.toBeNull();
		} );

		it( 'does not mount the overlay when debug is disabled, even on a non-console tab', () => {
			// No enableDebug() — sticky flag absent, isDebugEnabled false.
			registerConsoleAndManager();
			const { getByRole, queryByRole } = render( <Station /> );
			fireEvent.click( getByRole( 'tab', { name: 'Topologies' } ) );
			expect(
				queryByRole( 'button', { name: /node debugger/i } )
			).toBeNull();
		} );
	} );
} );
