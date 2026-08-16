/* global globalThis */
/**
 * The Topologies-tab deep-links: `?topology=X&edit=1` opens topology X in the
 * editor; `?new=1` opens a blank New draft (handleNew). New uses a DISTINCT
 * signal — not `?edit=1` sans topology — because the console's topology→URL sync
 * writes the default `?topology=TOPOLOGIES[0]` on mount, which would make a
 * topology-absent edit link look like editing that default. `?new=1` is
 * sync-proof. (TOPOLOGIES itself is frozen empty in jest — module `import`s hoist
 * above the NewspackNodesData seed below — but `?new=1` doesn't depend on it.)
 */

import { render, act } from '@testing-library/react';

window.NewspackNodesData = {
	restUrl: '/wp-json/',
	nonce: 'NONCE',
	topologyWorkers: { alpha: 1, beta: 1 },
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
jest.mock( '../hooks/useCatalogs', () => ( {
	// Only what this suite drives is stubbed; useVaults stays real.
	...jest.requireActual( '../hooks/useCatalogs' ),
	useTopologyList: () => ( {
		topologies: [ 'alpha', 'beta' ],
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
			globalThis.__newHooks
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
		load: () => Promise.resolve( { classes: [], formatters: [] } ),
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
				globalThis.__newHooks
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
				globalThis.__newHooks
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
jest.mock( '../components/Header', () => ( {
	__esModule: true,
	default: () => <header data-testid="brand-header" />,
	HeaderControls: ( props ) => (
		<header data-testid="header" data-mode={ props.mode } />
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

describe( 'TopologyConsole — Topologies-tab New/Edit deep-links', () => {
	beforeEach( () => {
		window.localStorage.clear();
		Core.reset();
		globalThis.__newHooks.fetchTopology.mockClear();
	} );

	it( 'opens a blank New draft for ?new=1 (handleNew — never fetches a topology)', async () => {
		window.history.replaceState( {}, '', '/?new=1' );
		const { getByTestId } = render( <TopologyConsole /> );
		await act( async () => {} );
		// ?new=1 is the New signal: enters edit mode, NEVER fetches a TSL.
		expect( getByTestId( 'header' ).dataset.mode ).toBe( 'edit' );
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
