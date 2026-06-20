/* global globalThis */
/**
 * The Topologies-tab Edit / New deep-links: `?topology=X&edit=1` opens topology
 * X in the editor; `?edit=1` (no `?topology`) opens a blank New draft. The `?edit`
 * mount effect branches on the URL's `?topology` (handleNew when absent) so New
 * doesn't fall through to the `topology`-state default (TOPOLOGIES[0]).
 *
 * NOTE: the production-bug case (New loading TOPOLOGIES[0]) is NOT reproducible in
 * jest — module `import`s are hoisted above the `window.NewspackNodesData`
 * assignment below, so the module-level TOPOLOGIES is computed empty and the
 * fallback is undefined. The Edit deep-link asserts the topology-present branch
 * fetches; the New deep-link can only assert it reaches edit mode.
 */

import { render, act } from '@testing-library/react';

window.NewspackNodesData = {
	restUrl: '/wp-json/',
	nonce: 'NONCE',
	topologyPartitions: { alpha: 1, beta: 1 },
	activeTopologies: [],
	version: 'test',
	userLogin: 'tester',
};

jest.mock( '../hooks/useConsoleGraph', () => ( {
	useConsoleGraph: () => ( { status: 'closed', ssePid: null, shell: null } ),
} ) );
globalThis.__newHooks = {
	fetchTopology: jest
		.fn()
		.mockResolvedValue( { name: 'alpha', source: 'user', tsl: '' } ),
	fetchLayout: jest.fn().mockResolvedValue( { positions: null } ),
	saveLayout: jest.fn().mockResolvedValue( null ),
};
jest.mock( '../hooks/useTopologyList', () => ( {
	useTopologyList: () => ( {
		topologies: [ 'alpha', 'beta' ],
		userDir: '',
		loading: false,
		error: null,
		reload: () => {},
	} ),
	useTopology: () => globalThis.__newHooks.fetchTopology,
} ) );
jest.mock( '../hooks/useClassCatalog', () => ( {
	useClassCatalog: () => ( {
		classes: [],
		formatters: [],
		loading: false,
		error: null,
	} ),
} ) );
jest.mock( '../hooks/useLayout', () => ( {
	useLayout: () => ( {
		fetchLayout: globalThis.__newHooks.fetchLayout,
		saveLayout: globalThis.__newHooks.saveLayout,
	} ),
} ) );
jest.mock( '../hooks/useSaveTopology', () => ( {
	useSaveTopology: () => globalThis.__newHooks.saveLayout,
} ) );
jest.mock( '../hooks/useDeleteTopology', () => ( {
	useDeleteTopology: () => jest.fn(),
} ) );
jest.mock( '../components/SchematicCanvas', () => () => (
	<div data-testid="canvas" />
) );
jest.mock( '../components/Inspector', () => () => (
	<div data-testid="inspector" />
) );
jest.mock( '../components/Header', () => ( props ) => (
	<header data-testid="header" data-mode={ props.mode } />
) );
jest.mock( '../components/Palette', () => () => (
	<aside data-testid="palette" />
) );
jest.mock( '../components/ReplFooter', () => () => (
	<footer data-testid="repl" />
) );
jest.mock( '../components/CanvasFrame', () => ( props ) => (
	<div data-testid="canvas-frame">{ props.children }</div>
) );
jest.mock( '../components/OpenTopologyModal', () => () => null );
jest.mock( '../components/Modal', () => ( {
	ConfirmModal: () => null,
	PromptModal: () => null,
	NewNodeModal: () => null,
} ) );

import TopologyConsole from '../TopologyConsole';
import { Core } from '../../runtime/core';

describe( 'TopologyConsole — Topologies-tab New/Edit deep-links', () => {
	beforeEach( () => {
		window.localStorage.clear();
		Core.reset();
		globalThis.__newHooks.fetchTopology.mockClear();
	} );

	it( 'enters edit mode for a New deep-link (?edit=1, no ?topology)', async () => {
		window.history.replaceState( {}, '', '/?edit=1' );
		const { getByTestId } = render( <TopologyConsole /> );
		await act( async () => {} );
		expect( getByTestId( 'header' ).dataset.mode ).toBe( 'edit' );
		// The production bug — New loading TOPOLOGIES[0] instead of a blank draft
		// — can't be reproduced here: jest hoists the TopologyConsole import above
		// this file's NewspackNodesData assignment, so the module-level TOPOLOGIES
		// is frozen empty and the `topology`-state fallback is undefined. The fix
		// (branch the ?edit effect on the URL's ?topology → handleNew when absent)
		// is guarded by the Edit-deep-link test below (topology present → fetch)
		// plus code review; here we only assert the New deep-link reaches edit mode.
		expect( globalThis.__newHooks.fetchTopology ).not.toHaveBeenCalled();
	} );

	it( 'loads the named topology for an Edit deep-link (?topology=beta&edit=1)', async () => {
		window.history.replaceState( {}, '', '/?topology=beta&edit=1' );
		const { getByTestId } = render( <TopologyConsole /> );
		await act( async () => {} );
		expect( getByTestId( 'header' ).dataset.mode ).toBe( 'edit' );
		// Edit loads the named topology's TSL via fetchTopology.
		expect( globalThis.__newHooks.fetchTopology ).toHaveBeenCalledWith(
			'beta'
		);
	} );
} );
