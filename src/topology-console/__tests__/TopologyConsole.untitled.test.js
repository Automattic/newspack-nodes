/* global globalThis */
/**
 * F2 regression: a brand-new install with NO topologies (empty
 * topologyWorkers, so the module-level TOPOLOGIES list is empty and the
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
	topologyWorkers: {},
	activeTopologies: [],
	version: 'test',
	userLogin: 'tester',
};

// Edit mode disables SSE so the graph hook never enables; a minimal mock.
jest.mock( '../hooks/useConsoleGraph', () => ( {
	useConsoleGraph: () => ( { status: 'closed', ssePid: null, shell: null } ),
} ) );
globalThis.__untitledHooks = {
	fetchTopology: jest.fn().mockResolvedValue( null ),
	// fetchLayout must NOT be called when effectiveTopologyName is ''.
	fetchLayout: jest.fn( () => new Promise( () => {} ) ),
	saveLayout: jest.fn().mockResolvedValue( null ),
};
jest.mock( '../hooks/useCatalogs', () => ( {
	// Only what this suite drives is stubbed; useVaults stays real.
	...jest.requireActual( '../hooks/useCatalogs' ),
	useTopologyList: () => ( {
		topologies: [],
		userDir: '',
		loading: false,
		error: null,
	} ),
	useTopology: () => {
		const { useCallback, useState } = require( '@wordpress/element' );
		const [ topology, setTopology ] = useState( null );
		const [ error, setError ] = useState( null );
		const open = useCallback( ( name ) => {
			if ( ! name ) {
				return;
			}
			setError( null );
			globalThis.__untitledHooks
				.fetchTopology( name )
				// The server echoes the name it was asked for; so does this.
				.then( ( resp ) =>
					setTopology( resp ? { source: '', ...resp, name } : null )
				)
				.catch( ( e ) =>
					setError( e?.data?.message || e?.message || String( e ) )
				);
		}, [] );
		return { open, topology, error, loading: null === topology };
	},
	useClassCatalog: () => ( {
		classes: [],
		formatters: [],
		loading: false,
		error: null,
	} ),
} ) );
jest.mock( '../hooks/useLayout', () => ( {
	// Faked over the promises the fixtures still seed: what settles becomes the
	// handler the console now does its work in. The two senders are STABLE, as
	// the real hook's are — a fresh identity per render re-runs the console's
	// fetch effect, which sets state, which renders again.
	useLayout: ( handlers = {} ) => {
		const { useCallback, useRef } = require( '@wordpress/element' );
		const ref = useRef( handlers );
		ref.current = handlers;
		const fetchLayout = useCallback(
			( name ) =>
				globalThis.__untitledHooks
					.fetchLayout( name )
					.then( ( result ) =>
						ref.current.onFetched?.( {
							result,
							error: null,
							args: [ name ],
						} )
					)
					.catch( ( e ) =>
						ref.current.onFetched?.( {
							result: null,
							error: e?.message || String( e ),
							args: [ name ],
						} )
					),
			[]
		);
		const saveLayout = useCallback(
			( { name, positions } ) =>
				globalThis.__untitledHooks
					.saveLayout( { name, positions } )
					.then( ( result ) =>
						ref.current.onSaved?.( {
							result,
							error: null,
							args: [ name ],
						} )
					)
					.catch( ( e ) =>
						ref.current.onSaved?.( {
							result: null,
							error:
								e?.data?.message || e?.message || String( e ),
							args: [ name ],
						} )
					),
			[]
		);
		return { fetchLayout, saveLayout };
	},
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
jest.mock( '../components/Header', () => ( {
	__esModule: true,
	default: () => <header data-testid="brand-header" />,
	HeaderControls: ( props ) => (
		<header data-testid="header" data-mode={ props.mode }>
			<button onClick={ () => props.onModeChange( 'edit' ) }>edit</button>
		</header>
	),
} ) );
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
		// Blank draft's _repl anchor gives graph a node; no fetch fires.
		expect( queryByTestId( 'canvas' ) ).not.toBeNull();
		expect(
			document.querySelector( '.topology-canvas-building' )
		).toBeNull();
		// The empty-name effectiveTopologyName never triggers a layout fetch.
		expect( globalThis.__untitledHooks.fetchLayout ).not.toHaveBeenCalled();
	} );
} );
