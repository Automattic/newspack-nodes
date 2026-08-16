/* global globalThis */
/**
 * Drilling into a hull ("Open request-builder.tsl") from LIVE mode.
 *
 * handleOpenPick loads the topology into the DRAFT, which is all the header's
 * OPEN button ever needed — it only renders in edit mode. The hull drill-in is
 * the one caller that can fire from live mode, and it never switched modes: the
 * draft loaded behind a canvas still rendering the live graph, so the button
 * looked inert. Opening a topology lands you in the editor, like New does.
 */

import { render, act, fireEvent } from '@testing-library/react';

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
globalThis.__drillHooks = {
	fetchTopology: jest
		.fn()
		.mockResolvedValue( { name: 'beta', source: 'user', tsl: '' } ),
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
			globalThis.__drillHooks
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
				globalThis.__drillHooks
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
				globalThis.__drillHooks
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
	useSaveTopology: () => globalThis.__drillHooks.saveLayout,
} ) );
jest.mock( '../hooks/useDeleteTopology', () => ( {
	useDeleteTopology: () => jest.fn(),
} ) );
jest.mock( '../components/SchematicCanvas', () => () => (
	<div data-testid="canvas" />
) );
/**
 * GraphView is ready-gated inside ConsoleShell, so stub the shell and fire the
 * drill-in the way HullPanel's "Open <name>.tsl" button does — that button's own
 * plumbing (HullPanel → Inspector → GraphView) is covered in Inspector.hull.
 */
jest.mock( '../components/ConsoleShell', () => ( props ) => (
	<div data-testid="shell">
		<button onClick={ () => props.canvasProps.onOpenTopology( 'beta' ) }>
			drill
		</button>
	</div>
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

describe( 'TopologyConsole — drilling into a hull', () => {
	beforeEach( () => {
		window.localStorage.clear();
		window.history.replaceState( {}, '', '/' );
		Core.reset();
		globalThis.__drillHooks.fetchTopology.mockClear();
	} );

	it( 'opens the hull topology IN THE EDITOR from live mode', async () => {
		const { getByTestId, getByText } = render( <TopologyConsole /> );
		await act( async () => {} );
		// Live mode: the canvas is showing the running graph, not a draft.
		expect( getByTestId( 'header' ).dataset.mode ).toBe( 'view' );

		await act( async () => {
			fireEvent.click( getByText( 'drill' ) );
		} );

		expect( globalThis.__drillHooks.fetchTopology ).toHaveBeenCalledWith(
			'beta'
		);
		expect( getByTestId( 'header' ).dataset.mode ).toBe( 'edit' );
	} );
} );
