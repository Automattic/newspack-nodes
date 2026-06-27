import { render, fireEvent } from '@testing-library/react';
import DevToolsHub from '../DevToolsHub';
import {
	registerDevtoolsTab,
	resetDevtoolsTabs,
} from '@newspack-nodes/shared/devtools/tabRegistry';

describe( 'DevToolsHub', () => {
	beforeEach( () => {
		resetDevtoolsTabs();
		window.localStorage.clear();
		window.history.replaceState( {}, '', '/' );
	} );

	it( 'syncs the active tab into ?tab= (deep-linkable)', () => {
		registerDevtoolsTab( {
			id: 'topology-console',
			label: 'Console',
			host: 'hub',
			slug: 'console',
			order: 0,
			component: () => <div data-testid="console" />,
		} );
		render( <DevToolsHub /> );
		expect(
			new URLSearchParams( window.location.search ).get( 'tab' )
		).toBe( 'console' );
	} );

	it( 'shows the empty state when no hub tabs are registered', () => {
		const { getByText } = render( <DevToolsHub /> );
		expect( getByText( /no tools registered/i ) ).not.toBeNull();
	} );

	it( 'renders a registered hub tab', () => {
		registerDevtoolsTab( {
			id: 'demo',
			label: 'Demo',
			host: 'hub',
			component: () => <div data-testid="demo" />,
		} );
		const { getByTestId } = render( <DevToolsHub /> );
		expect( getByTestId( 'demo' ) ).not.toBeNull();
	} );

	it( 'wraps the tab host in a full-height fixed admin-page container', () => {
		registerDevtoolsTab( {
			id: 'demo',
			label: 'Demo',
			host: 'hub',
			component: () => <div data-testid="demo" />,
		} );
		const { container } = render( <DevToolsHub /> );
		// firstChild is the display:contents theme token-provider; the fixed
		// admin-page container is `.nodes-devtools-hub` inside it.
		const page = container.querySelector( '.nodes-devtools-hub' );
		expect( page.style.position ).toBe( 'fixed' );
		expect( page.style.top ).toBe( '32px' );
		expect( page.style.right ).toBe( '0px' );
		expect( page.style.bottom ).toBe( '0px' );
	} );

	it( 'renders the console first and topologies second when both are registered', () => {
		registerDevtoolsTab( {
			id: 'topology-manager',
			label: 'Topologies',
			host: 'hub',
			order: 10,
			component: () => <div data-testid="manager" />,
		} );
		registerDevtoolsTab( {
			id: 'topology-console',
			label: 'Console',
			host: 'hub',
			order: 0,
			component: () => <div data-testid="console" />,
		} );
		const { getAllByRole, getByTestId, queryByTestId } = render(
			<DevToolsHub />
		);
		const tabs = getAllByRole( 'tab' ).map( ( t ) => t.textContent );
		expect( tabs ).toEqual( [ 'Console', 'Topologies' ] );
		// Order 0 (console) is selected first; the host lazy-mounts only it.
		expect( getByTestId( 'console' ) ).not.toBeNull();
		expect( queryByTestId( 'manager' ) ).toBeNull();
	} );

	describe( 'debug overlay gating', () => {
		// The overlay's FAB is gated on isDebugEnabled, which (absent the
		// ?nodes-debug query param) reads the sticky localStorage flag.
		const enableDebug = () =>
			window.localStorage.setItem( 'newspack-nodes:debug', '1' );

		const registerConsoleAndManager = () => {
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
		};

		it( 'shows the debug overlay FAB on the Console tab too (Overview-only there)', () => {
			enableDebug();
			registerConsoleAndManager();
			const { getByRole } = render( <DevToolsHub /> );
			// Console (order 0) is selected first → the overlay now rides it too
			// (its Overview shows browser I/O; its REPL body is Overview-only).
			expect(
				getByRole( 'button', { name: /node debugger/i } )
			).not.toBeNull();
		} );

		it( 'keeps the debug overlay FAB mounted across tabs', () => {
			enableDebug();
			registerConsoleAndManager();
			const { getByRole } = render( <DevToolsHub /> );
			expect(
				getByRole( 'button', { name: /node debugger/i } )
			).not.toBeNull();
			fireEvent.click( getByRole( 'tab', { name: 'Topologies' } ) );
			expect(
				getByRole( 'button', { name: /node debugger/i } )
			).not.toBeNull();
		} );

		it( 'does not mount the overlay when debug is disabled, even on a non-console tab', () => {
			// No enableDebug() — sticky flag absent, so isDebugEnabled is false.
			registerConsoleAndManager();
			const { getByRole, queryByRole } = render( <DevToolsHub /> );
			fireEvent.click( getByRole( 'tab', { name: 'Topologies' } ) );
			expect(
				queryByRole( 'button', { name: /node debugger/i } )
			).toBeNull();
		} );
	} );
} );
