import { loadTabBundle } from '../loadTabBundle';

describe( 'loadTabBundle', () => {
	beforeEach( () => {
		document.head.innerHTML = '';
		delete window.NewspackNodesData;
		window.NewspackNodesLazyTabs = {};
	} );

	it( 'injects the script + style and sets the localize global for a handle', () => {
		window.NewspackNodesLazyTabs = {
			'lazy-inject': {
				src: 'http://x/vault/index.js?ver=9c',
				style: 'http://x/vault/index.css?ver=9c',
				data: {
					restUrl: 'http://x/wp-json/',
					nonce: 'abc',
					mode: 'zonk',
				},
			},
		};
		loadTabBundle( 'lazy-inject' );
		expect(
			document.head.querySelector(
				'script[src="http://x/vault/index.js?ver=9c"]'
			)
		).not.toBeNull();
		expect(
			document.head.querySelector(
				'link[href="http://x/vault/index.css?ver=9c"]'
			)
		).not.toBeNull();
		expect( window.NewspackNodesData.mode ).toBe( 'zonk' );
	} );

	it( 'is idempotent: a second call injects no duplicate script', () => {
		window.NewspackNodesLazyTabs = {
			'lazy-idem': { src: 'http://x/agg/index.js?ver=7d' },
		};
		loadTabBundle( 'lazy-idem' );
		loadTabBundle( 'lazy-idem' );
		expect(
			document.head.querySelectorAll(
				'script[src="http://x/agg/index.js?ver=7d"]'
			).length
		).toBe( 1 );
	} );

	it( 'does nothing for an unknown handle', () => {
		loadTabBundle( 'lazy-unknown' );
		expect( document.head.querySelector( 'script' ) ).toBeNull();
	} );

	it( 'merges the localize payload instead of clobbering sibling-tab keys', () => {
		// Console reads window.NewspackNodesData live on every render; a lazy
		// Vault load replacing the whole global would silently reset Console's
		// configNumPartitions to its fallback on the next tab switch back.
		window.NewspackNodesData = {
			restUrl: 'http://x/wp-json/',
			nonce: 'abc',
			configNumPartitions: 4,
		};
		window.NewspackNodesLazyTabs = {
			'lazy-merge': {
				src: 'http://x/vault/index.js?ver=1a',
				data: {
					restUrl: 'http://x/wp-json/',
					nonce: 'abc',
					vaultOnly: 'v',
				},
			},
		};
		loadTabBundle( 'lazy-merge' );
		expect( window.NewspackNodesData.vaultOnly ).toBe( 'v' );
		expect( window.NewspackNodesData.configNumPartitions ).toBe( 4 );
	} );
} );
