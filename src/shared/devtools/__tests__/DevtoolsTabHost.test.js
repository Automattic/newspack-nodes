import { render, fireEvent } from '@testing-library/react';
import DevtoolsTabHost from '../DevtoolsTabHost';
import { registerDevtoolsTab, resetDevtoolsTabs } from '../tabRegistry';
import fs from 'fs';
import path from 'path';

describe( 'DevtoolsTabHost', () => {
	beforeEach( resetDevtoolsTabs );

	it( 'renders the empty state when no tabs match the host', () => {
		const { getByTestId } = render(
			<DevtoolsTabHost
				host="hub"
				emptyState={ <div data-testid="empty" /> }
			/>
		);
		expect( getByTestId( 'empty' ) ).not.toBeNull();
	} );

	it( 'hides the tab bar with a single tab and mounts it with host + tabProps', () => {
		const Tab = ( { host, label } ) => (
			<div data-testid="tab">{ `${ host }:${ label }` }</div>
		);
		registerDevtoolsTab( {
			id: 'a',
			label: 'A',
			host: 'hub',
			component: Tab,
		} );
		const { queryByRole, getByTestId } = render(
			<DevtoolsTabHost host="hub" tabProps={ { label: 'X' } } />
		);
		expect( queryByRole( 'tablist' ) ).toBeNull();
		expect( getByTestId( 'tab' ).textContent ).toBe( 'hub:X' );
	} );

	it( 'shows the bar with >1 tab and lazy-mounts only the selected one', () => {
		registerDevtoolsTab( {
			id: 'a',
			label: 'A',
			host: 'hub',
			order: 0,
			component: () => <div data-testid="a" />,
		} );
		registerDevtoolsTab( {
			id: 'b',
			label: 'B',
			host: 'hub',
			order: 1,
			component: () => <div data-testid="b" />,
		} );
		const { getByRole, getByTestId, queryByTestId } = render(
			<DevtoolsTabHost host="hub" />
		);
		expect( getByRole( 'tablist' ) ).not.toBeNull();
		expect( getByTestId( 'a' ) ).not.toBeNull();
		expect( queryByTestId( 'b' ) ).toBeNull();
		fireEvent.click( getByRole( 'tab', { name: 'B' } ) );
		expect( getByTestId( 'b' ) ).not.toBeNull();
		expect( queryByTestId( 'a' ) ).toBeNull();
	} );

	it( 'forces the routing host even if tabProps carries a host key', () => {
		const Tab = ( { host } ) => <div data-testid="tab">{ host }</div>;
		registerDevtoolsTab( {
			id: 'a',
			label: 'A',
			host: 'hub',
			component: Tab,
		} );
		const { getByTestId } = render(
			<DevtoolsTabHost host="hub" tabProps={ { host: 'WRONG' } } />
		);
		expect( getByTestId( 'tab' ).textContent ).toBe( 'hub' );
	} );

	it( 'wraps a default tab in a scrollable content container', () => {
		registerDevtoolsTab( {
			id: 'a',
			label: 'A',
			host: 'hub',
			component: () => <div data-testid="a" />,
		} );
		const { container, getByTestId } = render(
			<DevtoolsTabHost host="hub" />
		);
		const content = container.querySelector(
			'.nodes-devtools__tab-content'
		);
		expect( content ).not.toBeNull();
		expect( content.classList.contains( 'is-full-bleed' ) ).toBe( false );
		// The tab mounts inside the scroll container.
		expect( content.contains( getByTestId( 'a' ) ) ).toBe( true );
	} );

	it( 'marks a fullBleed tab content container as full-bleed (opts out of scroll)', () => {
		registerDevtoolsTab( {
			id: 'console',
			label: 'Console',
			host: 'hub',
			fullBleed: true,
			component: () => <div data-testid="console" />,
		} );
		const { container } = render( <DevtoolsTabHost host="hub" /> );
		const content = container.querySelector(
			'.nodes-devtools__tab-content'
		);
		expect( content ).not.toBeNull();
		expect( content.classList.contains( 'is-full-bleed' ) ).toBe( true );
	} );

	it( 'reports the initial and switched active tab id via onActiveTabChange', () => {
		registerDevtoolsTab( {
			id: 'console',
			label: 'Console',
			host: 'hub',
			order: 0,
			component: () => <div data-testid="console" />,
		} );
		registerDevtoolsTab( {
			id: 'manager',
			label: 'Manager',
			host: 'hub',
			order: 1,
			component: () => <div data-testid="manager" />,
		} );
		const onActiveTabChange = jest.fn();
		const { getByRole } = render(
			<DevtoolsTabHost
				host="hub"
				onActiveTabChange={ onActiveTabChange }
			/>
		);
		// The initial active tab (order 0) is reported on mount.
		expect( onActiveTabChange ).toHaveBeenLastCalledWith( 'console' );
		fireEvent.click( getByRole( 'tab', { name: 'Manager' } ) );
		expect( onActiveTabChange ).toHaveBeenLastCalledWith( 'manager' );
	} );

	it( 'switches the full-bleed policy with the active tab', () => {
		registerDevtoolsTab( {
			id: 'console',
			label: 'Console',
			host: 'hub',
			order: 0,
			fullBleed: true,
			component: () => <div data-testid="console" />,
		} );
		registerDevtoolsTab( {
			id: 'manager',
			label: 'Manager',
			host: 'hub',
			order: 1,
			component: () => <div data-testid="manager" />,
		} );
		const { container, getByRole } = render(
			<DevtoolsTabHost host="hub" />
		);
		const content = () =>
			container.querySelector( '.nodes-devtools__tab-content' );
		// Console (order 0) is active first → full-bleed.
		expect( content().classList.contains( 'is-full-bleed' ) ).toBe( true );
		fireEvent.click( getByRole( 'tab', { name: 'Manager' } ) );
		// Manager scrolls → not full-bleed.
		expect( content().classList.contains( 'is-full-bleed' ) ).toBe( false );
	} );

	describe( 'URL routing', () => {
		const ConsoleTab = () => <div data-testid="console" />;
		const ManagerTab = () => <div data-testid="manager" />;
		const RawLogsTab = () => <div data-testid="raw-logs" />;

		const registerThree = () => {
			registerDevtoolsTab( {
				id: 'topology-console',
				label: 'Console',
				host: 'hub',
				slug: 'console',
				param: 'topology',
				order: 0,
				component: ConsoleTab,
			} );
			registerDevtoolsTab( {
				id: 'topology-manager',
				label: 'Topologies',
				host: 'hub',
				slug: 'topologies',
				order: 10,
				component: ManagerTab,
			} );
			registerDevtoolsTab( {
				id: 'raw-logs',
				label: 'Raw Logs',
				host: 'hub',
				slug: 'raw-logs',
				param: 'log',
				order: 20,
				component: RawLogsTab,
			} );
		};

		const tabParam = () =>
			new URLSearchParams( window.location.search ).get( 'tab' );

		beforeEach( () => {
			window.history.replaceState( {}, '', '/' );
		} );

		describe( 'without syncUrl (default)', () => {
			it( 'selects the first tab and writes no URL', () => {
				registerThree();
				const { getByTestId } = render(
					<DevtoolsTabHost host="hub" />
				);
				expect( getByTestId( 'console' ) ).not.toBeNull();
				expect( window.location.search ).toBe( '' );
			} );

			it( 'switching tabs writes no URL', () => {
				registerThree();
				const { getByRole } = render( <DevtoolsTabHost host="hub" /> );
				fireEvent.click( getByRole( 'tab', { name: 'Topologies' } ) );
				expect( window.location.search ).toBe( '' );
			} );

			it( 'ignores ?tab= when syncUrl is off', () => {
				window.history.replaceState( {}, '', '/?tab=topologies' );
				registerThree();
				const { getByTestId } = render(
					<DevtoolsTabHost host="hub" />
				);
				expect( getByTestId( 'console' ) ).not.toBeNull();
			} );
		} );

		describe( 'with syncUrl', () => {
			it( 'honors ?tab= for the initial tab', () => {
				window.history.replaceState( {}, '', '/?tab=topologies' );
				registerThree();
				const { getByTestId } = render(
					<DevtoolsTabHost host="hub" syncUrl />
				);
				expect( getByTestId( 'manager' ) ).not.toBeNull();
			} );

			it( 'falls back to the first tab for an unknown ?tab=', () => {
				window.history.replaceState( {}, '', '/?tab=nope' );
				registerThree();
				const { getByTestId } = render(
					<DevtoolsTabHost host="hub" syncUrl />
				);
				expect( getByTestId( 'console' ) ).not.toBeNull();
			} );

			it( 'falls back to the first tab when ?tab= is absent', () => {
				registerThree();
				const { getByTestId } = render(
					<DevtoolsTabHost host="hub" syncUrl />
				);
				expect( getByTestId( 'console' ) ).not.toBeNull();
			} );

			it( 'canonicalizes a bare URL to the resolved tab slug on mount', () => {
				registerThree();
				render( <DevtoolsTabHost host="hub" syncUrl /> );
				expect( tabParam() ).toBe( 'console' );
			} );

			it( 'preserves other params when canonicalizing on mount', () => {
				window.history.replaceState( {}, '', '/?topology=alpha' );
				registerThree();
				render( <DevtoolsTabHost host="hub" syncUrl /> );
				const params = new URLSearchParams( window.location.search );
				expect( params.get( 'topology' ) ).toBe( 'alpha' );
				expect( params.get( 'tab' ) ).toBe( 'console' );
			} );

			it( "preserves the active tab's own param across canonicalization", () => {
				window.history.replaceState(
					{},
					'',
					'/?tab=raw-logs&log=firehose'
				);
				registerThree();
				render( <DevtoolsTabHost host="hub" syncUrl /> );
				const params = new URLSearchParams( window.location.search );
				expect( params.get( 'tab' ) ).toBe( 'raw-logs' );
				// Raw Logs owns `log`, so it stays.
				expect( params.get( 'log' ) ).toBe( 'firehose' );
			} );

			it( "drops another tab's deep-link param on switch", () => {
				window.history.replaceState(
					{},
					'',
					'/?tab=console&topology=alpha&log=firehose'
				);
				registerThree();
				const { getByRole } = render(
					<DevtoolsTabHost host="hub" syncUrl />
				);
				// Land on console: its own `topology` stays, raw-logs' `log` is dropped.
				let params = new URLSearchParams( window.location.search );
				expect( params.get( 'topology' ) ).toBe( 'alpha' );
				expect( params.get( 'log' ) ).toBeNull();

				// Switch to Raw Logs: now `topology` (console's) is dropped.
				fireEvent.click( getByRole( 'tab', { name: 'Raw Logs' } ) );
				params = new URLSearchParams( window.location.search );
				expect( params.get( 'tab' ) ).toBe( 'raw-logs' );
				expect( params.get( 'topology' ) ).toBeNull();
			} );

			it( 'switching uses replaceState, not pushState', () => {
				registerThree();
				const pushSpy = jest.spyOn( window.history, 'pushState' );
				const { getByRole } = render(
					<DevtoolsTabHost host="hub" syncUrl />
				);
				fireEvent.click( getByRole( 'tab', { name: 'Topologies' } ) );
				expect( pushSpy ).not.toHaveBeenCalled();
				pushSpy.mockRestore();
			} );
		} );
	} );
} );

describe( 'DevtoolsTabHost styles', () => {
	it( 'reskin off the universal --cyan accent, not fixed --np-*', () => {
		// The tab focus ring + active underline must follow the console-selected
		// skin, so the SCSS reads the universal --cyan accent (which maps to
		// --np-primary under Newspack), never the Newspack-fixed --np-* directly.
		const scss = fs.readFileSync(
			path.join( __dirname, '..', 'DevtoolsTabHost.scss' ),
			'utf8'
		);
		expect( scss ).not.toMatch( /var\(\s*--np-/ );
		expect( scss ).toMatch( /var\(\s*--cyan/ );
	} );
} );
