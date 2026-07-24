import { render } from '@testing-library/react';
import { registerLazyTabs } from '../lazyTabs';
import {
	getDevtoolsTabs,
	resetDevtoolsTabs,
} from '@newspack-nodes/shared/devtools/tabRegistry';

describe( 'lazyTabs', () => {
	beforeEach( () => {
		resetDevtoolsTabs();
		document.head.innerHTML = '';
		window.NewspackNodesLazyTabs = {};
	} );

	it( 'registers the heavy tabs as hub placeholders carrying full metadata', () => {
		registerLazyTabs();
		const ids = getDevtoolsTabs( 'hub' ).map( ( t ) => t.id );
		expect( ids ).toEqual(
			expect.arrayContaining( [
				'topology-console',
				'vault',
				'aggregator',
			] )
		);
		// The placeholder must match the real tab's bar/URL identity pre-load.
		const consoleTab = getDevtoolsTabs( 'hub' ).find(
			( t ) => t.id === 'topology-console'
		);
		expect( consoleTab.slug ).toBe( 'console' );
		expect( consoleTab.fullBleed ).toBe( true );
		expect( typeof consoleTab.component ).toBe( 'function' );
	} );

	it( 'a placeholder injects its bundle when first rendered', () => {
		window.NewspackNodesLazyTabs = {
			'newspack-nodes-vault': {
				src: 'http://x/vault/index.js?ver=lazyv1',
			},
		};
		registerLazyTabs();
		const Placeholder = getDevtoolsTabs( 'hub' ).find(
			( t ) => t.id === 'vault'
		).component;
		render( <Placeholder /> );
		expect(
			document.head.querySelector(
				'script[src="http://x/vault/index.js?ver=lazyv1"]'
			)
		).not.toBeNull();
	} );
} );
