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
} );
