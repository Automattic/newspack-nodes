/* global globalThis */
/**
 * F2 regression: a brand-new install with NO topologies (empty
 * topologyPartitions, so the module-level TOPOLOGIES list is empty and the
 * initial `topology` is empty). Entering edit mode builds a blank/untitled
 * draft whose effectiveTopologyName is '' — the server-layout fetch
 * short-circuits, so the canvas must still render (layoutReady must NOT wait
 * for a fetch that never happens). This lives in its own file because
 * TOPOLOGIES is computed once at module load; the main suite loads with a
 * `demo` topology and can't exercise the empty-install path.
 */

import { render, fireEvent, act } from '@testing-library/react';

// Empty install: no topologies → module-level TOPOLOGIES === [] → topology ''.
window.NewspackNodesData = {
	restUrl: '/wp-json/',
	nonce: 'NONCE',
	topologyPartitions: {},
	activeTopologies: [],
	version: 'test',
	userLogin: 'tester',
};

// Edit mode disables SSE, so the graph hook is never enabled; a minimal mock
// suffices (the draft's _repl anchor gives the canvas its node).
jest.mock( '../hooks/useConsoleGraph', () => ( {
	useConsoleGraph: () => ( { status: 'closed', ssePid: null, shell: null } ),
} ) );
globalThis.__untitledHooks = {
	fetchTopology: jest.fn().mockResolvedValue( null ),
	// fetchLayout must NOT be called when effectiveTopologyName is '' — a
	// never-resolving promise proves the canvas renders without it.
	fetchLayout: jest.fn( () => new Promise( () => {} ) ),
	saveLayout: jest.fn().mockResolvedValue( null ),
};
jest.mock( '../hooks/useTopologyList', () => ( {
	useTopologyList: () => ( {
		topologies: [],
		userDir: '',
		loading: false,
		error: null,
		reload: () => {},
	} ),
	useTopology: () => globalThis.__untitledHooks.fetchTopology,
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
		fetchLayout: globalThis.__untitledHooks.fetchLayout,
		saveLayout: globalThis.__untitledHooks.saveLayout,
	} ),
} ) );
jest.mock( '../hooks/useSaveTopology', () => ( {
	useSaveTopology: () => globalThis.__untitledHooks.saveLayout,
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
	<header data-testid="header" data-mode={ props.mode }>
		<button onClick={ () => props.onModeChange( 'edit' ) }>edit</button>
	</header>
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

describe( 'TopologyConsole — untitled (no topologies) edit mode', () => {
	beforeEach( () => {
		window.history.replaceState( {}, '', '/' );
		window.localStorage.clear();
		Core.reset();
		globalThis.__untitledHooks.fetchTopology.mockClear();
		globalThis.__untitledHooks.fetchLayout.mockClear();
	} );

	it( 'renders the canvas (layoutReady) in edit mode with no topology, without waiting on a layout fetch', async () => {
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		// Blank draft carries the _repl anchor, so the layout graph has a node;
		// effectiveTopologyName is '' so no fetch fires — the canvas must render.
		expect( queryByTestId( 'canvas' ) ).not.toBeNull();
		expect(
			document.querySelector( '.topology-canvas-building' )
		).toBeNull();
		// The empty-name effectiveTopologyName never triggers a layout fetch.
		expect( globalThis.__untitledHooks.fetchLayout ).not.toHaveBeenCalled();
	} );
} );
