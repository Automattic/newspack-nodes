import { render } from '@testing-library/react';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import {
	getDevtoolsTabs,
	resetDevtoolsTabs,
} from '@newspack-nodes/shared/devtools/tabRegistry';

describe( 'InspectorTab registration + render', () => {
	beforeEach( () => {
		Core.reset();
		window.localStorage.clear();
		resetDevtoolsTabs();
	} );

	it( 'registers itself as the inspector overlay tab', () => {
		require( '../tabs' );
		const inspector = getDevtoolsTabs( 'overlay' ).find(
			( t ) => t.id === 'inspector'
		);
		expect( inspector ).toBeTruthy();
		expect( inspector.host ).toBe( 'overlay' );
		expect( typeof inspector.component ).toBe( 'function' );
	} );

	it( 'renders the panel body when mounted with a host context', () => {
		mountExospine();
		const InspectorTab = require( '../tabs/InspectorTab' ).default;
		const { getByTestId } = render(
			<InspectorTab
				host="overlay"
				storageKey="newspack-nodes:debug"
				onClose={ () => {} }
				frame={ { h: 600, w: 800 } }
				onHeaderPointerDown={ () => {} }
				toggleMaximize={ () => {} }
			/>
		);
		expect( getByTestId( 'inspector-tab' ) ).not.toBeNull();
	} );
} );
