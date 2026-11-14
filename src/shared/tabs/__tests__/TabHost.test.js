/* global PopStateEvent */
import { useEffect } from '@wordpress/element';
import { render, fireEvent, act } from '@testing-library/react';
import TabHost from '../TabHost';
import { registerTab, resetTabs } from '../tabRegistry';
import { useQueryParamState } from '../../hooks/useQueryParamState';
import { openParam, subscribeParam } from '../../utils/queryParams';
import { installViewport } from '../../test-utils/viewportWidth';
import fs from 'fs';
import path from 'path';

describe( 'TabHost', () => {
	beforeEach( resetTabs );

	it( 'renders the empty state when the host has no tabs', () => {
		const { getByTestId } = render(
			<TabHost
				host="station"
				emptyState={ <div data-testid="empty" /> }
			/>
		);
		expect( getByTestId( 'empty' ) ).not.toBeNull();
	} );

	it( 'hides the tab bar with a single tab and mounts it with host + tabProps', () => {
		const Tab = ( { host, label } ) => (
			<div data-testid="tab">{ `${ host }:${ label }` }</div>
		);
		registerTab( {
			id: 'a',
			label: 'A',
			host: 'station',
			component: Tab,
		} );
		const { queryByRole, getByTestId } = render(
			<TabHost host="station" tabProps={ { label: 'X' } } />
		);
		expect( queryByRole( 'tablist' ) ).toBeNull();
		expect( getByTestId( 'tab' ).textContent ).toBe( 'station:X' );
	} );

	it( 'shows a tab whose bundle registers AFTER the host first rendered', () => {
		registerTab( {
			id: 'a',
			label: 'A',
			host: 'station',
			order: 0,
			component: () => <div data-testid="a" />,
		} );
		const { queryByRole, queryByText } = render(
			<TabHost host="station" />
		);
		// One tab so far → no bar, and no "B".
		expect( queryByRole( 'tablist' ) ).toBeNull();
		expect( queryByText( 'B' ) ).toBeNull();
		// A late second tab registers; the host must re-render and show it.
		act( () => {
			registerTab( {
				id: 'b',
				label: 'B',
				host: 'station',
				order: 1,
				component: () => <div data-testid="b" />,
			} );
		} );
		expect( queryByRole( 'tablist' ) ).not.toBeNull();
		expect( queryByText( 'B' ) ).not.toBeNull();
	} );

	it( 'shows the bar with >1 tab and lazy-mounts only the selected one', () => {
		registerTab( {
			id: 'a',
			label: 'A',
			host: 'station',
			order: 0,
			component: () => <div data-testid="a" />,
		} );
		registerTab( {
			id: 'b',
			label: 'B',
			host: 'station',
			order: 1,
			component: () => <div data-testid="b" />,
		} );
		const { getByRole, getByTestId, queryByTestId } = render(
			<TabHost host="station" />
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
		registerTab( {
			id: 'a',
			label: 'A',
			host: 'station',
			component: Tab,
		} );
		const { getByTestId } = render(
			<TabHost host="station" tabProps={ { host: 'WRONG' } } />
		);
		expect( getByTestId( 'tab' ).textContent ).toBe( 'station' );
	} );

	it( 'wraps a default tab in a scrollable content container', () => {
		registerTab( {
			id: 'a',
			label: 'A',
			host: 'station',
			component: () => <div data-testid="a" />,
		} );
		const { container, getByTestId } = render( <TabHost host="station" /> );
		const content = container.querySelector(
			'.nodes-tab-host__tab-content'
		);
		expect( content ).not.toBeNull();
		expect( content.classList.contains( 'is-full-bleed' ) ).toBe( false );
		// The tab mounts inside the scroll container.
		expect( content.contains( getByTestId( 'a' ) ) ).toBe( true );
	} );

	it( 'marks a fullBleed tab content container as full-bleed (opts out of scroll)', () => {
		registerTab( {
			id: 'console',
			label: 'Console',
			host: 'station',
			fullBleed: true,
			component: () => <div data-testid="console" />,
		} );
		const { container } = render( <TabHost host="station" /> );
		const content = container.querySelector(
			'.nodes-tab-host__tab-content'
		);
		expect( content ).not.toBeNull();
		expect( content.classList.contains( 'is-full-bleed' ) ).toBe( true );
	} );

	it( 'insets a default tab by the shared page inset, and a full-bleed one not at all', () => {
		registerTab( {
			id: 'console',
			label: 'Console',
			host: 'station',
			order: 0,
			fullBleed: true,
			component: () => <div data-testid="console" />,
		} );
		registerTab( {
			id: 'roster',
			label: 'Roster',
			host: 'station',
			order: 1,
			component: () => <div data-testid="roster" />,
		} );
		const { container, getByRole } = render( <TabHost host="station" /> );
		const inset = () =>
			container
				.querySelector( '.nodes-tab-host__tab-content' )
				.classList.contains( 'newspack-nodes-page-inset' );
		expect( inset() ).toBe( false );
		fireEvent.click( getByRole( 'tab', { name: 'Roster' } ) );
		expect( inset() ).toBe( true );
	} );

	it( 'keeps the inset for a tab that owns its scroll, and drops the outer scroll', () => {
		registerTab( {
			id: 'tail',
			label: 'Tail',
			host: 'station',
			ownsScroll: true,
			component: () => <div data-testid="tail" />,
		} );
		const { container } = render( <TabHost host="station" /> );
		const content = container.querySelector(
			'.nodes-tab-host__tab-content'
		);
		expect( [ ...content.classList ] ).toEqual( [
			'nodes-tab-host__tab-content',
			'is-own-scroll',
			'newspack-nodes-page-inset',
		] );
	} );

	it( 'reports the initial and switched active tab id via onActiveTabChange', () => {
		registerTab( {
			id: 'console',
			label: 'Console',
			host: 'station',
			order: 0,
			component: () => <div data-testid="console" />,
		} );
		registerTab( {
			id: 'manager',
			label: 'Manager',
			host: 'station',
			order: 1,
			component: () => <div data-testid="manager" />,
		} );
		const onActiveTabChange = jest.fn();
		const { getByRole } = render(
			<TabHost host="station" onActiveTabChange={ onActiveTabChange } />
		);
		// The initial active tab (order 0) is reported on mount.
		expect( onActiveTabChange ).toHaveBeenLastCalledWith( 'console' );
		fireEvent.click( getByRole( 'tab', { name: 'Manager' } ) );
		expect( onActiveTabChange ).toHaveBeenLastCalledWith( 'manager' );
	} );

	it( 'switches the full-bleed policy with the active tab', () => {
		registerTab( {
			id: 'console',
			label: 'Console',
			host: 'station',
			order: 0,
			fullBleed: true,
			component: () => <div data-testid="console" />,
		} );
		registerTab( {
			id: 'manager',
			label: 'Manager',
			host: 'station',
			order: 1,
			component: () => <div data-testid="manager" />,
		} );
		const { container, getByRole } = render( <TabHost host="station" /> );
		const content = () =>
			container.querySelector( '.nodes-tab-host__tab-content' );
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
			registerTab( {
				id: 'topology-console',
				label: 'Console',
				host: 'station',
				slug: 'console',
				params: [ 'topology' ],
				order: 0,
				component: ConsoleTab,
			} );
			registerTab( {
				id: 'topology-manager',
				label: 'Topologies',
				host: 'station',
				slug: 'topologies',
				order: 10,
				component: ManagerTab,
			} );
			registerTab( {
				id: 'raw-logs',
				label: 'Raw Logs',
				host: 'station',
				slug: 'raw-logs',
				params: [ 'log' ],
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
				const { getByTestId } = render( <TabHost host="station" /> );
				expect( getByTestId( 'console' ) ).not.toBeNull();
				expect( window.location.search ).toBe( '' );
			} );

			it( 'switching tabs writes no URL', () => {
				registerThree();
				const { getByRole } = render( <TabHost host="station" /> );
				fireEvent.click( getByRole( 'tab', { name: 'Topologies' } ) );
				expect( window.location.search ).toBe( '' );
			} );

			it( 'ignores ?tab= when syncUrl is off', () => {
				window.history.replaceState( {}, '', '/?tab=topologies' );
				registerThree();
				const { getByTestId } = render( <TabHost host="station" /> );
				expect( getByTestId( 'console' ) ).not.toBeNull();
			} );
		} );

		describe( 'with syncUrl', () => {
			it( 'honors ?tab= for the initial tab', () => {
				window.history.replaceState( {}, '', '/?tab=topologies' );
				registerThree();
				const { getByTestId } = render(
					<TabHost host="station" syncUrl />
				);
				expect( getByTestId( 'manager' ) ).not.toBeNull();
			} );

			it( 'falls back to the first tab for an unknown ?tab=', () => {
				window.history.replaceState( {}, '', '/?tab=nope' );
				registerThree();
				const { getByTestId } = render(
					<TabHost host="station" syncUrl />
				);
				expect( getByTestId( 'console' ) ).not.toBeNull();
			} );

			it( 'falls back to the first tab when ?tab= is absent', () => {
				registerThree();
				const { getByTestId } = render(
					<TabHost host="station" syncUrl />
				);
				expect( getByTestId( 'console' ) ).not.toBeNull();
			} );

			describe( 'deep-link whose tab registers after first render', () => {
				const registerConsole = () =>
					registerTab( {
						id: 'console',
						label: 'Console',
						host: 'station',
						slug: 'console',
						order: 0,
						component: () => <div data-testid="console" />,
					} );
				const registerTopologies = () =>
					registerTab( {
						id: 'topologies',
						label: 'Topologies',
						host: 'station',
						slug: 'topologies',
						params: [ 'topology' ],
						order: 10,
						component: () => <div data-testid="manager" />,
					} );

				it( "preserves the target tab's own param across the late switch", () => {
					window.history.replaceState(
						{},
						'',
						'/?tab=topologies&topology=aggregator'
					);
					registerConsole();
					render( <TabHost host="station" syncUrl /> );
					act( registerTopologies );
					expect(
						new URLSearchParams( window.location.search ).get(
							'topology'
						)
					).toBe( 'aggregator' );
				} );

				it( 'activates the deep-linked tab once it registers', () => {
					window.history.replaceState( {}, '', '/?tab=topologies' );
					registerConsole(); // deep-link target not here yet
					const { queryByTestId } = render(
						<TabHost host="station" syncUrl />
					);
					expect( queryByTestId( 'console' ) ).not.toBeNull();
					act( registerTopologies );
					expect( queryByTestId( 'manager' ) ).not.toBeNull();
				} );

				it( 'keeps the ?tab= deep-link in the URL until its tab registers', () => {
					window.history.replaceState( {}, '', '/?tab=topologies' );
					registerConsole();
					render( <TabHost host="station" syncUrl /> );
					// Do NOT rewrite ?tab=topologies to console while pending.
					expect( tabParam() ).toBe( 'topologies' );
					act( registerTopologies );
					expect( tabParam() ).toBe( 'topologies' );
				} );

				it( 'does not override a tab the user manually picked', () => {
					window.history.replaceState( {}, '', '/?tab=topologies' );
					registerConsole();
					registerTab( {
						id: 'raw',
						label: 'Raw Logs',
						host: 'station',
						slug: 'raw',
						order: 5,
						component: () => <div data-testid="raw" />,
					} );
					const { getByRole, queryByTestId } = render(
						<TabHost host="station" syncUrl />
					);
					fireEvent.click( getByRole( 'tab', { name: 'Raw Logs' } ) );
					act( registerTopologies );
					expect( queryByTestId( 'raw' ) ).not.toBeNull();
					expect( queryByTestId( 'manager' ) ).toBeNull();
				} );
			} );

			it( 'canonicalizes a bare URL to the resolved tab slug on mount', () => {
				registerThree();
				render( <TabHost host="station" syncUrl /> );
				expect( tabParam() ).toBe( 'console' );
			} );

			it( 'preserves other params when canonicalizing on mount', () => {
				window.history.replaceState( {}, '', '/?topology=alpha' );
				registerThree();
				render( <TabHost host="station" syncUrl /> );
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
				render( <TabHost host="station" syncUrl /> );
				const params = new URLSearchParams( window.location.search );
				expect( params.get( 'tab' ) ).toBe( 'raw-logs' );
				// Raw Logs owns `log`, so it stays.
				expect( params.get( 'log' ) ).toBe( 'firehose' );
			} );

			it( 'keeps a param the active tab declares, though another tab declares it too', () => {
				window.history.replaceState(
					{},
					'',
					'/?tab=raw-logs&topology=kea-7960&log=firehose'
				);
				registerTab( {
					id: 'topology-console',
					label: 'Console',
					host: 'station',
					slug: 'console',
					params: [ 'topology' ],
					order: 0,
					component: ConsoleTab,
				} );
				registerTab( {
					id: 'raw-logs',
					label: 'Raw Logs',
					host: 'station',
					slug: 'raw-logs',
					params: [ 'log', 'topology' ],
					order: 20,
					component: RawLogsTab,
				} );
				render( <TabHost host="station" syncUrl /> );
				const params = new URLSearchParams( window.location.search );
				expect( params.get( 'topology' ) ).toBe( 'kea-7960' );
				expect( params.get( 'log' ) ).toBe( 'firehose' );
			} );

			it( 'strips a shared param on a switch, so a tab returned to opens without it', () => {
				window.history.replaceState(
					{},
					'',
					'/?tab=console&edit=1&topology=kea-7961'
				);
				registerTab( {
					id: 'topology-console',
					label: 'Console',
					host: 'station',
					slug: 'console',
					params: [ 'topology', 'edit' ],
					order: 0,
					component: ConsoleTab,
				} );
				registerTab( {
					id: 'overview',
					label: 'Overview',
					host: 'station',
					slug: 'overview',
					params: [ 'edit' ],
					order: 10,
					component: ManagerTab,
				} );
				const { getByRole } = render(
					<TabHost host="station" syncUrl />
				);
				fireEvent.click( getByRole( 'tab', { name: 'Overview' } ) );
				expect(
					new URLSearchParams( window.location.search ).get( 'edit' )
				).toBeNull();
				fireEvent.click( getByRole( 'tab', { name: 'Console' } ) );
				const params = new URLSearchParams( window.location.search );
				expect( params.get( 'tab' ) ).toBe( 'console' );
				expect( params.get( 'edit' ) ).toBeNull();
			} );

			it( "drops another tab's deep-link param on switch", () => {
				window.history.replaceState(
					{},
					'',
					'/?tab=console&topology=alpha&log=firehose'
				);
				registerThree();
				const { getByRole } = render(
					<TabHost host="station" syncUrl />
				);
				// On console: its own topology stays; raw-logs' log is dropped.
				let params = new URLSearchParams( window.location.search );
				expect( params.get( 'topology' ) ).toBe( 'alpha' );
				expect( params.get( 'log' ) ).toBeNull();

				// Switch to Raw Logs: now `topology` (console's) is dropped.
				fireEvent.click( getByRole( 'tab', { name: 'Raw Logs' } ) );
				params = new URLSearchParams( window.location.search );
				expect( params.get( 'tab' ) ).toBe( 'raw-logs' );
				expect( params.get( 'topology' ) ).toBeNull();
			} );

			describe( 'history', () => {
				let pushSpy;
				let replaceSpy;
				const back = ( url ) =>
					act( () => {
						window.history.replaceState( null, '', url );
						window.dispatchEvent( new PopStateEvent( 'popstate' ) );
					} );

				beforeEach( () => {
					pushSpy = jest.spyOn( window.history, 'pushState' );
					replaceSpy = jest.spyOn( window.history, 'replaceState' );
				} );

				afterEach( () => {
					pushSpy.mockRestore();
					replaceSpy.mockRestore();
				} );

				it( 'pushes one entry per tab switch, naming the new tab', () => {
					registerThree();
					const { getByRole } = render(
						<TabHost host="station" syncUrl />
					);
					fireEvent.click(
						getByRole( 'tab', { name: 'Topologies' } )
					);
					expect( pushSpy ).toHaveBeenCalledTimes( 1 );
					expect( pushSpy.mock.calls[ 0 ][ 2 ] ).toBe(
						'/?tab=topologies'
					);
				} );

				it( 'pushes nothing when the active tab is picked again', () => {
					registerThree();
					const { getByRole } = render(
						<TabHost host="station" syncUrl />
					);
					fireEvent.click( getByRole( 'tab', { name: 'Console' } ) );
					expect( pushSpy ).not.toHaveBeenCalled();
				} );

				it( 'writes no entry on load, deep link included', () => {
					window.history.replaceState(
						{},
						'',
						'/?tab=raw-logs&log=firehose&topology=alpha'
					);
					registerThree();
					render( <TabHost host="station" syncUrl /> );
					expect( pushSpy ).not.toHaveBeenCalled();
					expect( window.location.search ).toBe(
						'?tab=raw-logs&log=firehose'
					);
				} );

				it( 'writes no entry when a deep-linked tab registers late', () => {
					window.history.replaceState( {}, '', '/?tab=raw-logs' );
					registerTab( {
						id: 'topology-manager',
						label: 'Topologies',
						host: 'station',
						slug: 'topologies',
						order: 10,
						component: ManagerTab,
					} );
					const { queryByTestId } = render(
						<TabHost host="station" syncUrl />
					);
					act( () =>
						registerTab( {
							id: 'raw-logs',
							label: 'Raw Logs',
							host: 'station',
							slug: 'raw-logs',
							order: 20,
							component: RawLogsTab,
						} )
					);
					expect( queryByTestId( 'raw-logs' ) ).not.toBeNull();
					expect( pushSpy ).not.toHaveBeenCalled();
				} );

				it( 'Back and Forward restore the tab each entry names', () => {
					registerThree();
					const { getByRole, queryByTestId } = render(
						<TabHost host="station" syncUrl />
					);
					fireEvent.click( getByRole( 'tab', { name: 'Raw Logs' } ) );
					expect( queryByTestId( 'raw-logs' ) ).not.toBeNull();

					back( '/?tab=console' );
					expect( queryByTestId( 'console' ) ).not.toBeNull();
					expect( queryByTestId( 'raw-logs' ) ).toBeNull();

					back( '/?tab=raw-logs' );
					expect( queryByTestId( 'raw-logs' ) ).not.toBeNull();
					expect( pushSpy ).toHaveBeenCalledTimes( 1 );
				} );

				it( 'restores a tab without rewriting the landed entry', () => {
					registerThree();
					const { getByRole, queryByTestId } = render(
						<TabHost host="station" syncUrl />
					);
					fireEvent.click(
						getByRole( 'tab', { name: 'Topologies' } )
					);
					replaceSpy.mockClear();
					back( '/?tab=console&topology=alpha' );
					expect( queryByTestId( 'console' ) ).not.toBeNull();
					expect( replaceSpy ).toHaveBeenCalledTimes( 1 );
					expect( pushSpy ).toHaveBeenCalledTimes( 1 );
					expect( window.location.search ).toBe(
						'?tab=console&topology=alpha'
					);
				} );

				it( "drops the left tab's param from the pushed entry alone", () => {
					window.history.replaceState(
						{},
						'',
						'/?tab=console&topology=alpha'
					);
					registerThree();
					const { getByRole, queryByTestId } = render(
						<TabHost host="station" syncUrl />
					);
					fireEvent.click( getByRole( 'tab', { name: 'Raw Logs' } ) );
					expect( pushSpy ).toHaveBeenCalledTimes( 1 );
					expect( pushSpy.mock.calls[ 0 ][ 2 ] ).toBe(
						'/?tab=raw-logs'
					);

					back( '/?tab=console&topology=alpha' );
					expect( queryByTestId( 'console' ) ).not.toBeNull();
					expect(
						new URLSearchParams( window.location.search ).get(
							'topology'
						)
					).toBe( 'alpha' );
				} );

				describe( 'a tab owning several params through the bar', () => {
					/**
					 * A console tab that owns `topology` and `partition` the way
					 * TopologyConsole does: replace-mode state it writes back
					 * over every entry Back or Forward lands on.
					 *
					 * @return {import('react').ReactElement} The tab.
					 */
					const OwningConsole = () => {
						const [ topology ] = useQueryParamState(
							'topology',
							( raw ) => raw ?? 'kestrel-hub',
							( name ) => name
						);
						const [ partition ] = useQueryParamState(
							'partition',
							( raw ) => raw ?? '6',
							( p ) => p
						);
						return (
							<div data-testid="console">{ `${ topology }.p${ partition }` }</div>
						);
					};

					const registerOwning = () => {
						registerTab( {
							id: 'overview',
							label: 'Overview',
							host: 'station',
							slug: 'overview',
							order: 0,
							component: () => <div data-testid="overview" />,
						} );
						registerTab( {
							id: 'topology-console',
							label: 'Console',
							host: 'station',
							slug: 'console',
							params: [ 'topology', 'partition' ],
							order: 15,
							component: OwningConsole,
						} );
					};

					it( 'lands Back on an entry carrying no param of the tab it left', () => {
						window.history.replaceState( {}, '', '/?tab=console' );
						registerOwning();
						const { queryByTestId } = render(
							<TabHost host="station" syncUrl />
						);
						expect( window.location.search ).toBe(
							'?tab=console&topology=kestrel-hub&partition=6'
						);

						back( '/?tab=overview' );
						expect( queryByTestId( 'overview' ) ).not.toBeNull();
						expect( window.location.search ).toBe(
							'?tab=overview'
						);
					} );

					it( 'clears every param the left tab owns from the pushed entry', () => {
						registerOwning();
						const { getByRole } = render(
							<TabHost host="station" syncUrl />
						);
						fireEvent.click(
							getByRole( 'tab', { name: 'Console' } )
						);
						expect( window.location.search ).toBe(
							'?tab=console&topology=kestrel-hub&partition=6'
						);

						fireEvent.click(
							getByRole( 'tab', { name: 'Overview' } )
						);
						expect( pushSpy.mock.calls[ 1 ][ 2 ] ).toBe(
							'/?tab=overview'
						);
						expect( window.location.search ).toBe(
							'?tab=overview'
						);
					} );
				} );

				it( 'answers no popstate without syncUrl', () => {
					registerThree();
					const { getByRole, queryByTestId } = render(
						<TabHost host="station" />
					);
					fireEvent.click( getByRole( 'tab', { name: 'Raw Logs' } ) );
					back( '/?tab=console' );
					expect( queryByTestId( 'raw-logs' ) ).not.toBeNull();
					expect( pushSpy ).not.toHaveBeenCalled();
				} );

				it( 'stops answering popstate once unmounted', () => {
					registerThree();
					const addSpy = jest.spyOn( window, 'addEventListener' );
					const removeSpy = jest.spyOn(
						window,
						'removeEventListener'
					);
					const { unmount } = render(
						<TabHost host="station" syncUrl />
					);
					const listener = addSpy.mock.calls.find(
						( [ type ] ) => 'popstate' === type
					)?.[ 1 ];
					unmount();
					expect( listener ).toBeDefined();
					expect( removeSpy ).toHaveBeenCalledWith(
						'popstate',
						listener
					);
					addSpy.mockRestore();
					removeSpy.mockRestore();
				} );

				describe( 'a tab guarding its leave', () => {
					let asked;

					/**
					 * Register the three tabs, the Console guarding its leave.
					 *
					 * @param {boolean}  answer      What the guard answers.
					 * @param {Function} [component] The Console's component.
					 */
					const guarded = ( answer, component = ConsoleTab ) => {
						registerThree();
						registerTab( {
							id: 'topology-console',
							label: 'Console',
							host: 'station',
							slug: 'console',
							params: [ 'topology' ],
							order: 0,
							component,
							beforeLeave: ( next ) => {
								asked.push( next );
								return answer;
							},
						} );
					};

					beforeEach( () => {
						asked = [];
						window.history.replaceState(
							{},
							'',
							'/?tab=console&topology=kea-7961'
						);
					} );

					it( 'stays on a tab whose guard declines a switch', () => {
						guarded( false );
						const { getByRole, queryByTestId } = render(
							<TabHost host="station" syncUrl />
						);
						fireEvent.click(
							getByRole( 'tab', { name: 'Raw Logs' } )
						);
						expect( asked ).toHaveLength( 1 );
						expect( asked[ 0 ] ).toMatchObject( {
							id: 'raw-logs',
							slug: 'raw-logs',
						} );
						expect( queryByTestId( 'console' ) ).not.toBeNull();
						expect( pushSpy ).not.toHaveBeenCalled();
						expect( window.location.search ).toBe(
							'?tab=console&topology=kea-7961'
						);
					} );

					it( 'switches once a declining guard leaves after all', () => {
						guarded( false );
						const { getByRole, queryByTestId } = render(
							<TabHost host="station" syncUrl />
						);
						fireEvent.click(
							getByRole( 'tab', { name: 'Raw Logs' } )
						);
						act( () => asked[ 0 ].leave() );
						expect( queryByTestId( 'raw-logs' ) ).not.toBeNull();
						expect( pushSpy ).toHaveBeenCalledTimes( 1 );
						expect( pushSpy.mock.calls[ 0 ][ 2 ] ).toBe(
							'/?tab=raw-logs'
						);
					} );

					it( 'switches at once when the guard allows it', () => {
						guarded( true );
						const { getByRole, queryByTestId } = render(
							<TabHost host="station" syncUrl />
						);
						fireEvent.click(
							getByRole( 'tab', { name: 'Raw Logs' } )
						);
						expect( asked ).toHaveLength( 1 );
						expect( queryByTestId( 'raw-logs' ) ).not.toBeNull();
					} );

					it( 'restores the tab and its entry when the guard declines a Back', () => {
						guarded( false );
						const { queryByTestId } = render(
							<TabHost host="station" syncUrl />
						);
						back( '/?tab=raw-logs' );
						expect( asked ).toHaveLength( 1 );
						expect( asked[ 0 ] ).toMatchObject( {
							id: 'raw-logs',
						} );
						expect( queryByTestId( 'console' ) ).not.toBeNull();
						expect( window.location.search ).toBe(
							'?tab=console&topology=kea-7961'
						);
					} );

					it( 'tells no reader of the landed entry when the guard declines a Back', () => {
						guarded( false );
						const topology = openParam( 'topology', {
							parse: ( raw ) => raw ?? '',
							format: ( value ) => value,
							push: true,
						} );
						let told = 0;
						const off = subscribeParam( topology, () => {
							told += 1;
						} );
						render( <TabHost host="station" syncUrl /> );
						const before = told;
						back( '/?tab=raw-logs' );
						expect( asked ).toHaveLength( 1 );
						expect( told ).toBe( before );
						expect( topology.value ).toBe( 'kea-7961' );
						off();
					} );

					describe( 'over indexed history', () => {
						let mounts;

						/**
						 * The Console, counting each time it mounts.
						 *
						 * @return {import('react').ReactElement} The tab.
						 */
						function CountedConsole() {
							useEffect( () => {
								mounts += 1;
							}, [] );
							return <div data-testid="console" />;
						}

						beforeEach( () => {
							mounts = 0;
						} );

						/** Let a traversal and the popstate it queues land. */
						const settle = () =>
							act( async () => {
								for ( let i = 0; i < 4; i++ ) {
									await new Promise( ( done ) =>
										setTimeout( done, 0 )
									);
								}
							} );

						/**
						 * Land on Raw Logs stamped as the landing is, then pick the
						 * guarded Console, which pushes the entry Back leaves.
						 *
						 * @return {Object} What `render()` answers.
						 */
						const pickConsole = () => {
							window.history.replaceState(
								{
									newspackNodesBar: {
										doc: window.__newspackNodesBar.doc,
										at: 0,
									},
								},
								'',
								'/?tab=raw-logs'
							);
							guarded( false, CountedConsole );
							const rendered = render(
								<TabHost host="station" syncUrl />
							);
							fireEvent.click(
								rendered.getByRole( 'tab', { name: 'Console' } )
							);
							return rendered;
						};

						it( 'returns from a declined Back with one go, writing no entry', async () => {
							const { queryByTestId } = pickConsole();
							const length = window.history.length;
							const shown = window.location.search;
							const go = jest.spyOn( window.history, 'go' );
							pushSpy.mockClear();
							replaceSpy.mockClear();
							const landed = new Promise( ( done ) =>
								window.addEventListener( 'popstate', done, {
									once: true,
								} )
							);
							window.history.back();
							await act( () => landed );
							expect( queryByTestId( 'console' ) ).not.toBeNull();
							await settle();
							expect( asked ).toHaveLength( 1 );
							expect( go.mock.calls ).toEqual( [ [ 1 ] ] );
							expect( pushSpy ).not.toHaveBeenCalled();
							expect( replaceSpy ).not.toHaveBeenCalled();
							expect( queryByTestId( 'console' ) ).not.toBeNull();
							expect( mounts ).toBe( 1 );
							expect( window.location.search ).toBe( shown );
							expect( window.history.length ).toBe( length );
							go.mockRestore();
						} );

						it( 'goes to the landed tab once a declined guard leaves', async () => {
							const { queryByTestId } = pickConsole();
							const length = window.history.length;
							window.history.back();
							await settle();
							pushSpy.mockClear();
							act( () => asked[ 0 ].leave() );
							await settle();
							expect(
								queryByTestId( 'raw-logs' )
							).not.toBeNull();
							expect( pushSpy ).not.toHaveBeenCalled();
							expect( window.location.search ).toBe(
								'?tab=raw-logs'
							);
							expect( window.history.length ).toBe( length );

							window.history.forward();
							await settle();
							expect( queryByTestId( 'console' ) ).not.toBeNull();
							expect( window.location.search ).toBe(
								'?tab=console'
							);
						} );
					} );

					it( 'shows the landed tab once a guard that declined a Back leaves', () => {
						guarded( false );
						const { queryByTestId } = render(
							<TabHost host="station" syncUrl />
						);
						back( '/?tab=raw-logs&log=kea-firehose' );
						act( () => asked[ 0 ].leave() );
						expect( queryByTestId( 'raw-logs' ) ).not.toBeNull();
						expect( pushSpy ).not.toHaveBeenCalled();
						expect( window.location.search ).toBe(
							'?tab=raw-logs&log=kea-firehose'
						);
					} );
				} );
			} );
		} );
	} );

	describe( 'ARIA tabs pattern', () => {
		const registerTrio = () => {
			[ 'first', 'second', 'third' ].forEach( ( id, order ) =>
				registerTab( {
					id,
					label: id,
					host: 'station',
					order,
					component: () => <div />,
				} )
			);
		};

		it( 'labels the tablist and links each tab to the panel', () => {
			registerTrio();
			const { getByRole, getAllByRole } = render(
				<TabHost host="station" />
			);
			expect(
				getByRole( 'tablist' ).getAttribute( 'aria-label' )
			).toBeTruthy();
			const tabs = getAllByRole( 'tab' );
			const panel = getByRole( 'tabpanel' );
			expect( tabs[ 0 ].getAttribute( 'aria-controls' ) ).toBe(
				panel.id
			);
			expect( panel.getAttribute( 'aria-labelledby' ) ).toBe(
				tabs[ 0 ].id
			);
		} );

		it( 'leaves a narrow panel its id alone, which the select controls', () => {
			registerTrio();
			const viewport = installViewport( true );
			try {
				const { container, getByLabelText, queryByRole } = render(
					<TabHost host="station" />
				);
				const panel = container.querySelector(
					'.nodes-tab-host__tab-content'
				);
				expect( queryByRole( 'tabpanel' ) ).toBeNull();
				expect( panel.hasAttribute( 'aria-labelledby' ) ).toBe( false );
				expect(
					getByLabelText( 'View' ).getAttribute( 'aria-controls' )
				).toBe( panel.id );
			} finally {
				viewport.restore();
			}
		} );

		it( 'roves tabindex: only the active tab is tabbable', () => {
			registerTrio();
			const { getAllByRole } = render( <TabHost host="station" /> );
			expect( getAllByRole( 'tab' ).map( ( t ) => t.tabIndex ) ).toEqual(
				[ 0, -1, -1 ]
			);
		} );

		it( 'ArrowRight selects + focuses the next tab and wraps around', () => {
			registerTrio();
			const { getAllByRole } = render( <TabHost host="station" /> );
			fireEvent.keyDown( getAllByRole( 'tab' )[ 0 ], {
				key: 'ArrowRight',
			} );
			let tabs = getAllByRole( 'tab' );
			expect( tabs[ 1 ].getAttribute( 'aria-selected' ) ).toBe( 'true' );
			expect( document.activeElement ).toBe( tabs[ 1 ] );
			fireEvent.keyDown( tabs[ 1 ], { key: 'ArrowRight' } );
			fireEvent.keyDown( getAllByRole( 'tab' )[ 2 ], {
				key: 'ArrowRight',
			} );
			tabs = getAllByRole( 'tab' );
			expect( tabs[ 0 ].getAttribute( 'aria-selected' ) ).toBe( 'true' );
		} );

		it( 'ArrowLeft wraps back; Home and End jump to the ends', () => {
			registerTrio();
			const { getAllByRole } = render( <TabHost host="station" /> );
			fireEvent.keyDown( getAllByRole( 'tab' )[ 0 ], {
				key: 'ArrowLeft',
			} );
			expect(
				getAllByRole( 'tab' )[ 2 ].getAttribute( 'aria-selected' )
			).toBe( 'true' );
			fireEvent.keyDown( getAllByRole( 'tab' )[ 2 ], { key: 'Home' } );
			expect(
				getAllByRole( 'tab' )[ 0 ].getAttribute( 'aria-selected' )
			).toBe( 'true' );
			fireEvent.keyDown( getAllByRole( 'tab' )[ 0 ], { key: 'End' } );
			expect(
				getAllByRole( 'tab' )[ 2 ].getAttribute( 'aria-selected' )
			).toBe( 'true' );
		} );
	} );
} );

describe( 'TabHost styles', () => {
	it( 'leaves tab paint and geometry to the canonical semantic role', () => {
		const scss = fs.readFileSync(
			path.join( __dirname, '..', 'TabHost.scss' ),
			'utf8'
		);
		const canonicalRoles = fs.readFileSync(
			path.join(
				__dirname,
				'..',
				'..',
				'styles',
				'_distinctive-roles.scss'
			),
			'utf8'
		);

		expect( scss ).not.toMatch( /\.nodes-tab-host__tab\s*\{/ );
		expect( canonicalRoles ).toMatch( /\.nodes-tab-host__tab\s*\{/ );
	} );
} );
