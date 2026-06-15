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
} );
