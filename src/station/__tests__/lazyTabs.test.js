import { render } from '@testing-library/react';
import { registerLazyTabs } from '../lazyTabs';
import { getTabs, resetTabs } from '@newspack-nodes/shared/tabs/tabRegistry';

describe( 'lazyTabs', () => {
	beforeEach( () => {
		resetTabs();
		document.head.innerHTML = '';
		window.NewspackNodesLazyTabs = {};
	} );

	it( 'registers the heavy tabs as station placeholders carrying full metadata', () => {
		registerLazyTabs();
		const ids = getTabs( 'station' ).map( ( t ) => t.id );
		expect( ids ).toEqual(
			expect.arrayContaining( [
				'topology-console',
				'vault',
				'aggregator',
			] )
		);
		// The placeholder must match the real tab's bar/URL identity pre-load.
		const consoleTab = getTabs( 'station' ).find(
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
		const Placeholder = getTabs( 'station' ).find(
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
