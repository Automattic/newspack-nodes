import { render, fireEvent } from '@testing-library/react';
import DevtoolsTabHost from '../DevtoolsTabHost';
import { registerDevtoolsTab, resetDevtoolsTabs } from '../tabRegistry';

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
} );
