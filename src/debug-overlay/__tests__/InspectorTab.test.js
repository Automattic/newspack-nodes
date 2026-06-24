import { render } from '@testing-library/react';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import {
	getDevtoolsTabs,
	resetDevtoolsTabs,
} from '@newspack-nodes/shared/devtools/tabRegistry';
import { replMaxHeight, measureTabBarHeight } from '../tabs/InspectorTab';

describe( 'replMaxHeight', () => {
	it( 'subtracts header, prompt bar, the measured tab bar, AND the resize-handle overhang from the frame height', () => {
		// The tab bar now sits above the inspector body, so the transcript must
		// reserve its measured height too — otherwise the REPL overflows the panel.
		// The trailing -6 reserves the resize handle that overhangs the pane top.
		expect( replMaxHeight( 600, 37 ) ).toBe( 600 - 64 - 38 - 37 - 6 );
	} );

	it( 'reserves nothing for the tab bar when its height is 0 (single-tab host, no bar)', () => {
		expect( replMaxHeight( 600, 0 ) ).toBe( 600 - 64 - 38 - 6 );
	} );

	it( 'defaults the tab-bar height to 0 when omitted', () => {
		expect( replMaxHeight( 600 ) ).toBe( 600 - 64 - 38 - 6 );
	} );

	it( 'floors at 80px so the transcript never collapses', () => {
		expect( replMaxHeight( 0, 37 ) ).toBe( 80 );
	} );
} );

describe( 'measureTabBarHeight', () => {
	it( 'returns 0 for a null root (not yet mounted)', () => {
		expect( measureTabBarHeight( null ) ).toBe( 0 );
	} );

	it( 'returns 0 when no tab bar precedes the inspector content', () => {
		const panel = document.createElement( 'div' );
		const content = document.createElement( 'div' );
		content.className = 'nodes-devtools__tab-content';
		const root = document.createElement( 'div' );
		content.appendChild( root );
		panel.appendChild( content );
		expect( measureTabBarHeight( root ) ).toBe( 0 );
	} );

	it( 'returns the tab bar offsetHeight when one precedes the content', () => {
		const panel = document.createElement( 'div' );
		const bar = document.createElement( 'div' );
		bar.className = 'nodes-devtools__tabbar';
		Object.defineProperty( bar, 'offsetHeight', { value: 37 } );
		const content = document.createElement( 'div' );
		content.className = 'nodes-devtools__tab-content';
		const root = document.createElement( 'div' );
		content.appendChild( root );
		panel.appendChild( bar );
		panel.appendChild( content );
		expect( measureTabBarHeight( root ) ).toBe( 37 );
	} );
} );

describe( 'InspectorTab registration + render', () => {
	beforeEach( () => {
		Core.reset();
		window.localStorage.clear();
		resetDevtoolsTabs();
	} );

	it( 'registers itself as the Console overlay tab', () => {
		require( '../tabs' );
		const consoleTab = getDevtoolsTabs( 'overlay' ).find(
			( t ) => t.id === 'console'
		);
		expect( consoleTab ).toBeTruthy();
		expect( consoleTab.host ).toBe( 'overlay' );
		expect( typeof consoleTab.component ).toBe( 'function' );
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
