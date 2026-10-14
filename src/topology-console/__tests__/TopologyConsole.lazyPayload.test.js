/**
 * The Console reads its localized payload from its own lazy-tab entry when it
 * mounts, so a footer `var NewspackNodesData = {…}` that replaces the shared
 * global after the station injected the bundle cannot strip the topology list.
 * The module is imported before any global is set, the state a background tab
 * evaluates it in once the replacement has run.
 */

import { render } from '@testing-library/react';

// The topology the console asks its graph for is the one it opened.
globalThis.__graphTopology = null;
jest.mock( '../hooks/useConsoleGraph', () => ( {
	useConsoleGraph: ( { topology } ) => {
		globalThis.__graphTopology = topology;
		return { status: 'closed', sseSession: null, shell: null };
	},
} ) );
jest.mock( '../hooks/useCatalogs', () => ( {
	...jest.requireActual( '../hooks/useCatalogs' ),
	useTopologyList: () => ( {
		topologies: [],
		userDir: '',
		loading: false,
		error: null,
	} ),
	useTopology: () => ( {
		open: () => {},
		topology: null,
		error: null,
		loading: false,
	} ),
	useClassCatalog: () => ( {
		classes: [],
		formatters: [],
		loading: false,
		error: null,
	} ),
} ) );
jest.mock( '../hooks/useLayout', () => {
	const fetchLayout = () => {};
	const saveLayout = () => {};
	return { useLayout: () => ( { fetchLayout, saveLayout } ) };
} );
jest.mock( '../hooks/useSaveTopology', () => ( {
	useSaveTopology: () => ( { save: () => {} } ),
} ) );
jest.mock( '../hooks/useDeleteTopology', () => ( {
	useDeleteTopology: () => ( { remove: () => {} } ),
} ) );
jest.mock( '../components/ConsoleShell', () => () => (
	<div data-testid="shell" />
) );
jest.mock( '../../shared/components/Header', () => ( {
	__esModule: true,
	default: () => <header data-testid="brand-header" />,
	HeaderControls: () => <header data-testid="header" />,
} ) );
jest.mock( '../components/OpenTopologyModal', () => () => null );
jest.mock( '../components/Modal', () => ( {
	ConfirmModal: () => null,
	PromptModal: () => null,
	NewNodeModal: () => null,
} ) );

import TopologyConsole from '../TopologyConsole';
import { loadTabBundle } from '../../station/loadTabBundle';
import { Core } from '../../runtime/core';

const HANDLE = 'newspack-nodes-topology-console';

/** Distinct from every fallback: two topologies, the link names the second. */
const CONSOLE_PAYLOAD = {
	topologyWorkers: { 'aardvark-probe': 1, 'zephyr-fleet': 3 },
	activeTopologies: [ 'aardvark-probe', 'zephyr-fleet' ],
	configNumPartitions: 4,
	configStaleTimeout: 75,
	configOnDemandIdle: 30,
};

describe( 'TopologyConsole — lazy-tab payload', () => {
	beforeEach( () => {
		Core.reset();
		globalThis.__graphTopology = null;
		window.localStorage.clear();
		document.head.innerHTML = '';
		delete window.NewspackNodesLazyTabs;
		window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'N1' };
	} );

	afterEach( () => {
		window.history.replaceState( {}, '', '/' );
		delete window.NewspackNodesLazyTabs;
	} );

	it( 'opens the linked topology after a later localize replaced the shared global', () => {
		window.NewspackNodesLazyTabs = {
			[ HANDLE ]: {
				src: 'http://x/topology-console/index.js?ver=race',
				data: CONSOLE_PAYLOAD,
			},
		};
		loadTabBundle( HANDLE );
		window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'N2' };
		window.history.replaceState(
			{},
			'',
			'/wp-admin/admin.php?page=newspack-nodes-station&tab=console&topology=zephyr-fleet'
		);

		render( <TopologyConsole /> );

		expect( window.location.search ).toContain( 'topology=zephyr-fleet' );
		expect( globalThis.__graphTopology ).toBe( 'zephyr-fleet' );
	} );

	it( 'still honors a deep link carried on the shared global alone', () => {
		window.NewspackNodesData = {
			restUrl: '/wp-json/',
			nonce: 'N3',
			...CONSOLE_PAYLOAD,
		};
		window.history.replaceState( {}, '', '/?topology=zephyr-fleet' );

		render( <TopologyConsole /> );

		expect( window.location.search ).toContain( 'topology=zephyr-fleet' );
		expect( globalThis.__graphTopology ).toBe( 'zephyr-fleet' );
	} );

	it( 'opens the first topology the tab payload sorts when the link names an unknown one', () => {
		window.NewspackNodesLazyTabs = {
			[ HANDLE ]: { src: 'http://x/tc.js', data: CONSOLE_PAYLOAD },
		};
		window.history.replaceState( {}, '', '/?topology=ghost-fleet' );

		render( <TopologyConsole /> );

		expect( window.location.search ).toContain( 'topology=aardvark-probe' );
		expect( globalThis.__graphTopology ).toBe( 'aardvark-probe' );
	} );
} );
