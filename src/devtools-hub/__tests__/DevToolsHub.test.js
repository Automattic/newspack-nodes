import { render } from '@testing-library/react';
import DevToolsHub from '../DevToolsHub';
import {
	registerDevtoolsTab,
	resetDevtoolsTabs,
} from '@newspack-nodes/shared/devtools/tabRegistry';

describe( 'DevToolsHub', () => {
	beforeEach( resetDevtoolsTabs );

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
		const page = container.firstChild;
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
} );
