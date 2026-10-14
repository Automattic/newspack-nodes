import { loadTabBundle, tabData } from '../loadTabBundle';

describe( 'loadTabBundle', () => {
	beforeEach( () => {
		document.head.innerHTML = '';
		delete window.NewspackNodesData;
		window.NewspackNodesLazyTabs = {};
	} );

	it( 'injects the script + style and leaves the shared global alone', () => {
		const shared = { restUrl: 'http://x/wp-json/', nonce: 'abc' };
		window.NewspackNodesData = shared;
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
		expect( window.NewspackNodesData ).toBe( shared );
		expect( window.NewspackNodesData.mode ).toBeUndefined();
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

	it( 'tabData lays the tab entry over the shared payload', () => {
		window.NewspackNodesData = {
			restUrl: 'http://x/wp-json/',
			nonce: 'n-4417',
		};
		window.NewspackNodesLazyTabs = {
			'lazy-console': {
				src: 'http://x/console/index.js?ver=3e',
				data: { configNumPartitions: 7 },
			},
		};
		expect( tabData( 'lazy-console' ) ).toEqual( {
			restUrl: 'http://x/wp-json/',
			nonce: 'n-4417',
			configNumPartitions: 7,
		} );
	} );

	it( 'tabData survives a later localize replacing the shared global', () => {
		window.NewspackNodesData = { restUrl: 'http://x/wp-json/', nonce: 'a' };
		window.NewspackNodesLazyTabs = {
			'newspack-nodes-topology-console': {
				src: 'http://x/console/index.js?ver=5f',
				data: {
					topologyWorkers: { 'zephyr-fleet': 3 },
					activeTopologies: [ 'zephyr-fleet' ],
				},
			},
			'newspack-nodes-vault': {
				src: 'http://x/vault/index.js?ver=5f',
				data: { vaultMarker: 'v-7731' },
			},
		};
		loadTabBundle( 'newspack-nodes-topology-console' );
		loadTabBundle( 'newspack-nodes-vault' );
		// A footer `var NewspackNodesData = {…}` runs after the injection.
		window.NewspackNodesData = { restUrl: 'http://later/', nonce: 'b' };

		const consoleData = tabData( 'newspack-nodes-topology-console' );
		expect( consoleData.topologyWorkers ).toEqual( { 'zephyr-fleet': 3 } );
		expect( consoleData.activeTopologies ).toEqual( [ 'zephyr-fleet' ] );
		expect( consoleData.restUrl ).toBe( 'http://later/' );
		expect( consoleData.nonce ).toBe( 'b' );
		expect( tabData( 'newspack-nodes-vault' ).vaultMarker ).toBe(
			'v-7731'
		);
	} );

	it( 'tabData answers the shared payload for a handle with no entry', () => {
		window.NewspackNodesData = { restUrl: 'http://x/wp-json/', nonce: 'c' };
		expect( tabData( 'lazy-absent' ) ).toEqual( {
			restUrl: 'http://x/wp-json/',
			nonce: 'c',
		} );
	} );
} );
