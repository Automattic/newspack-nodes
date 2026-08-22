/* global globalThis */
/**
 * Drilling into a hull ("Open request-builder.tsl") from LIVE mode.
 *
 * Opening loads the topology into the DRAFT, which is all the header's
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
	// Real shape — `{ save }` — and it parks `onSaved` so a test can land one.
	useSaveTopology: ( onSaved ) => {
		globalThis.__drillHooks.onSaved = onSaved;
		return { save: jest.fn() };
	},
} ) );
jest.mock( '../hooks/useDeleteTopology', () => ( {
	// Real shape — `{ remove }` — parking `onDeleted` the way save does.
	useDeleteTopology: ( onDeleted ) => {
		globalThis.__drillHooks.onDeleted = onDeleted;
		return { remove: jest.fn() };
	},
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
		<button onClick={ () => props.canvasProps.onRemoveNode( 'n1' ) }>
			dirty
		</button>
		<button onClick={ () => props.canvasProps.onRemoveNode( 'n2' ) }>
			dirty2
		</button>
	</div>
) );
jest.mock( '../components/Header', () => ( {
	__esModule: true,
	default: () => <header data-testid="brand-header" />,
	HeaderControls: ( props ) => (
		<header data-testid="header" data-mode={ props.mode }>
			<button onClick={ props.onOpen }>open</button>
			<button onClick={ props.onSave }>save</button>
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
jest.mock( '../components/OpenTopologyModal', () => ( props ) => (
	<button onClick={ () => props.onPick( 'beta' ) }>openpick</button>
) );
jest.mock( '../components/Modal', () => ( {
	// Rendered, so a guard that fires is visible and can be answered — an
	// absence assertion alone passes just as well on a button wired to nothing.
	ConfirmModal: ( props ) => (
		<div data-testid="confirm">
			<button onClick={ props.onConfirm }>confirm</button>
		</div>
	),
	PromptModal: ( props ) => (
		<button onClick={ () => props.onConfirm( 'beta' ) }>
			save-confirm
		</button>
	),
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

	it( 'a SAVED draft is clean, so drilling in does not ask to discard', async () => {
		// `onSaved` dropped to view mode without re-baselining, so a draft
		// stayed "dirty" against its pre-edit baseline for the rest of the
		// session and the next drill-in offered to discard changes already on
		// disk. A guard that fires shows the confirm and fetches nothing.
		globalThis.__drillHooks.fetchTopology.mockResolvedValue( {
			name: 'beta',
			source: 'user',
			tsl: 'make_node Null n1\nmake_node Null n2\n',
		} );
		const { getByTestId, getByText } = render( <TopologyConsole /> );
		await act( async () => {} );

		// Drill in to land in the editor with `beta` loaded, then edit it.
		await act( async () => {
			fireEvent.click( getByText( 'drill' ) );
		} );
		expect( getByTestId( 'header' ).dataset.mode ).toBe( 'edit' );
		await act( async () => {
			fireEvent.click( getByText( 'dirty' ) );
		} );

		// Save it for real — the SEND is what captures the written graph — then
		// answer the reply the way the command hook does.
		await act( async () => {
			fireEvent.click( getByText( 'save' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'save-confirm' ) );
		} );
		await act( async () => {
			globalThis.__drillHooks.onSaved( {
				result: { name: 'beta', shadows_stock: false },
				error: null,
				args: [ 'beta' ],
			} );
		} );
		expect( getByTestId( 'header' ).dataset.mode ).toBe( 'view' );

		globalThis.__drillHooks.fetchTopology.mockClear();
		await act( async () => {
			fireEvent.click( getByText( 'drill' ) );
		} );

		expect( globalThis.__drillHooks.fetchTopology ).toHaveBeenCalledWith(
			'beta'
		);
		expect( getByTestId( 'header' ).dataset.mode ).toBe( 'edit' );
	} );

	it( 'a DELETED topology leaves no draft to discard', async () => {
		// Same hole as save: the file is gone, but the draft that named it was
		// left in place with a stale baseline, so view mode read dirty.
		globalThis.__drillHooks.fetchTopology.mockResolvedValue( {
			name: 'beta',
			source: 'user',
			tsl: 'make_node Null n1\nmake_node Null n2\n',
		} );
		const { getByTestId, getByText } = render( <TopologyConsole /> );
		await act( async () => {} );

		await act( async () => {
			fireEvent.click( getByText( 'drill' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'dirty' ) );
		} );

		await act( async () => {
			globalThis.__drillHooks.onDeleted( {
				result: { deleted: true },
				error: null,
				args: [ 'beta' ],
			} );
		} );
		expect( getByTestId( 'header' ).dataset.mode ).toBe( 'view' );

		globalThis.__drillHooks.fetchTopology.mockClear();
		await act( async () => {
			fireEvent.click( getByText( 'drill' ) );
		} );

		expect( globalThis.__drillHooks.fetchTopology ).toHaveBeenCalledWith(
			'beta'
		);
		expect( getByTestId( 'header' ).dataset.mode ).toBe( 'edit' );
	} );

	it( 'an edit made while the write is in flight is not adopted as saved', async () => {
		// The reply lands seconds later with the canvas live throughout. A save
		// that baselines whatever is there on reply swallows the edit made
		// meanwhile — silent loss, worse than the prompt this all began with.
		globalThis.__drillHooks.fetchTopology.mockResolvedValue( {
			name: 'beta',
			source: 'user',
			tsl: 'make_node Null n1\nmake_node Null n2\n',
		} );
		const { getByText, getByTestId } = render( <TopologyConsole /> );
		await act( async () => {} );

		await act( async () => {
			fireEvent.click( getByText( 'drill' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'dirty' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'save' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'save-confirm' ) );
		} );

		// In flight: the user keeps editing.
		await act( async () => {
			fireEvent.click( getByText( 'dirty2' ) );
		} );
		await act( async () => {
			globalThis.__drillHooks.onSaved( {
				result: { name: 'beta', shadows_stock: false },
				error: null,
				args: [ 'beta' ],
			} );
		} );

		globalThis.__drillHooks.fetchTopology.mockClear();
		await act( async () => {
			fireEvent.click( getByText( 'drill' ) );
		} );

		// n2's removal was never written, so it is still unsaved work.
		expect( getByTestId( 'confirm' ) ).toBeTruthy();
		expect( globalThis.__drillHooks.fetchTopology ).not.toHaveBeenCalled();
	} );

	it( 'the OPEN dialog guards a dirty draft, as drilling in does', async () => {
		// Both paths run the same `openForEdit`, which REPLACES the draft, but
		// only the hull drill-in asked first — so the primary path silently
		// destroyed edited work while the secondary one guarded it.
		globalThis.__drillHooks.fetchTopology.mockResolvedValue( {
			name: 'beta',
			source: 'user',
			tsl: 'make_node Null n1\nmake_node Null n2\n',
		} );
		const { getByText, getByTestId } = render( <TopologyConsole /> );
		await act( async () => {} );

		await act( async () => {
			fireEvent.click( getByText( 'drill' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'dirty' ) );
		} );

		globalThis.__drillHooks.fetchTopology.mockClear();
		await act( async () => {
			fireEvent.click( getByText( 'open' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'openpick' ) );
		} );

		// It ASKED — nothing replaced yet — and answering it goes through.
		expect( getByTestId( 'confirm' ) ).toBeTruthy();
		expect( globalThis.__drillHooks.fetchTopology ).not.toHaveBeenCalled();

		await act( async () => {
			fireEvent.click( getByText( 'confirm' ) );
		} );
		expect( globalThis.__drillHooks.fetchTopology ).toHaveBeenCalledWith(
			'beta'
		);
	} );
} );
