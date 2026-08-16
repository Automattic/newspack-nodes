import { render, act } from '@testing-library/react';
import { Core } from '../../runtime/core';
import { Node } from '../../runtime/node';
import { mountExospine } from '../../runtime/exospine';
import {
	getDevtoolsTabs,
	resetDevtoolsTabs,
} from '@newspack-nodes/shared/devtools/tabRegistry';
import { TYPE, TM_RESPONSE, TM_ERROR } from '../../runtime/message';
import { replMaxHeight, measureTabBarHeight } from '../tabs/InspectorTab';

// mock-prefixed holder: a ref the jest.mock factory can close over.
const mockCaptured = { consoleShell: null, modal: null };
jest.mock( '../../topology-console/components/ConsoleShell', () => ( {
	__esModule: true,
	default: function ConsoleShellDouble( props ) {
		// The catalogs reach the canvas through context now, not canvasProps.
		const {
			useCatalog,
		} = require( '../../topology-console/CatalogContext' );
		mockCaptured.consoleShell = { ...props, catalogs: useCatalog() };
		return null;
	},
} ) );
jest.mock( '../../topology-console/components/Modal', () => ( {
	NewNodeModal: ( props ) => {
		mockCaptured.modal = props;
		return <div data-testid="pending-node-modal" />;
	},
} ) );
// Stub catalog hooks so cwd changes don't fire an async fetch after act().
jest.mock( '../../topology-console/hooks/useJsCatalog', () => ( {
	useJsCatalog: () => ( {
		classes: [ { shell_name: 'Echo', arguments: [] } ],
		loading: false,
		formatters: {},
	} ),
} ) );
jest.mock( '../../topology-console/hooks/useCatalogs', () => ( {
	useClassCatalog: () => ( { classes: [], loading: false, formatters: {} } ),
	useVaults: () => ( {
		vaults: [ { id: 'austin', url: '' } ],
		loading: false,
		error: null,
	} ),
} ) );

describe( 'replMaxHeight', () => {
	it( 'subtracts header, prompt bar, the measured tab bar, AND the resize-handle overhang from the frame height', () => {
		// Reserve tab-bar height + trailing -4 for the resize-handle overhang.
		expect( replMaxHeight( 600, 37 ) ).toBe( 600 - 64 - 38 - 37 - 4 );
	} );

	it( 'reserves nothing for the tab bar when its height is 0 (single-tab host, no bar)', () => {
		expect( replMaxHeight( 600, 0 ) ).toBe( 600 - 64 - 38 - 4 );
	} );

	it( 'defaults the tab-bar height to 0 when omitted', () => {
		expect( replMaxHeight( 600 ) ).toBe( 600 - 64 - 38 - 4 );
	} );

	it( 'floors at 80px so the transcript never collapses', () => {
		expect( replMaxHeight( 0, 37 ) ).toBe( 80 );
	} );
} );

describe( 'measureTabBarHeight', () => {
	it( 'returns 0 for a null root (not yet mounted)', () => {
		expect( measureTabBarHeight( null ) ).toBe( 0 );
	} );

	it( 'returns 0 when no tab bar precedes the inspector content', () => {
		const panel = document.createElement( 'div' );
		const content = document.createElement( 'div' );
		content.className = 'nodes-devtools__tab-content';
		const root = document.createElement( 'div' );
		content.appendChild( root );
		panel.appendChild( content );
		expect( measureTabBarHeight( root ) ).toBe( 0 );
	} );

	it( 'returns the tab bar offsetHeight when one precedes the content', () => {
		const panel = document.createElement( 'div' );
		const bar = document.createElement( 'div' );
		bar.className = 'nodes-devtools__tabbar';
		Object.defineProperty( bar, 'offsetHeight', { value: 37 } );
		const content = document.createElement( 'div' );
		content.className = 'nodes-devtools__tab-content';
		const root = document.createElement( 'div' );
		content.appendChild( root );
		panel.appendChild( bar );
		panel.appendChild( content );
		expect( measureTabBarHeight( root ) ).toBe( 37 );
	} );
} );

describe( 'InspectorTab registration + render', () => {
	beforeEach( () => {
		Core.reset();
		window.localStorage.clear();
		resetDevtoolsTabs();
	} );

	it( 'registers itself as the Console overlay tab', () => {
		require( '../tabs' );
		const consoleTab = getDevtoolsTabs( 'overlay' ).find(
			( t ) => t.id === 'console'
		);
		expect( consoleTab ).toBeTruthy();
		expect( consoleTab.host ).toBe( 'overlay' );
		expect( typeof consoleTab.component ).toBe( 'function' );
	} );

	it( 'renders the panel body when mounted with a host context', () => {
		mountExospine();
		const InspectorTab = require( '../tabs/InspectorTab' ).default;
		const { getByTestId } = render(
			<InspectorTab
				host="overlay"
				storageKey="newspack-nodes:debug"
				onClose={ () => {} }
				frame={ { h: 600, w: 800 } }
				onHeaderPointerDown={ () => {} }
				toggleMaximize={ () => {} }
			/>
		);
		expect( getByTestId( 'inspector-tab' ) ).not.toBeNull();
	} );

	function renderReplOff() {
		mountExospine();
		const InspectorTab = require( '../tabs/InspectorTab' ).default;
		return render(
			<InspectorTab
				host="overlay"
				storageKey="newspack-nodes:debug"
				onClose={ () => {} }
				frame={ { h: 600, w: 800 } }
				buildRepl={ false }
			/>
		);
	}

	it( 'is Overview-only when buildRepl is false (no infra; points at the Console)', () => {
		const { getByTestId } = renderReplOff();
		// No overlay infra: Console tab owns `_output`; a second collides.
		expect( Core.node( '_output' ) ).toBeNull();
		expect( getByTestId( 'inspector-tab' ).textContent ).toBe(
			"The graph and REPL live in this page's own Console tab. " +
				"Switch to Overview to watch this browser's I/O."
		);
	} );

	it( 'holds I/O on one line so it cannot orphan across the slash', () => {
		const { container } = renderReplOff();
		const nowrap = container.querySelector( '.nodes-debug__nowrap' );
		expect( nowrap ).not.toBeNull();
		expect( nowrap.textContent ).toBe( 'I/O' );
	} );
} );

describe( 'InspectorTab interactions', () => {
	beforeEach( () => {
		Core.reset();
		window.localStorage.clear();
		resetDevtoolsTabs();
		mockCaptured.consoleShell = null;
		mockCaptured.modal = null;
	} );

	function renderInspector( props = {} ) {
		mountExospine();
		const InspectorTab = require( '../tabs/InspectorTab' ).default;
		return render(
			<InspectorTab
				host="overlay"
				storageKey="newspack-nodes:debug"
				frame={ { h: 600, w: 800 } }
				{ ...props }
			/>
		);
	}

	it( 'leaves the topology layout root to inherit its host UI provider', () => {
		const { container } = renderInspector();
		const root = container.querySelector( '.topology-app' );

		expect( root.classList.contains( 'newspack-nodes-theme' ) ).toBe(
			false
		);
		expect( root.classList.contains( 'newspack-nodes-ui' ) ).toBe( false );
		expect( root.classList.contains( 'newspack-nodes-skin-root' ) ).toBe(
			false
		);
		expect( container.querySelectorAll( '.topology-app' ) ).toHaveLength(
			1
		);
	} );

	it( 'observes the tab bar with a ResizeObserver and disconnects on unmount', () => {
		const observe = jest.fn();
		const disconnect = jest.fn();
		window.ResizeObserver = class {
			observe( ...args ) {
				observe( ...args );
			}
			disconnect() {
				disconnect();
			}
		};
		// Effect wires a ResizeObserver when a tabbar precedes content.
		const tabbar = document.createElement( 'div' );
		tabbar.className = 'nodes-devtools__tabbar';
		const content = document.createElement( 'div' );
		content.className = 'nodes-devtools__tab-content';
		document.body.appendChild( tabbar );
		document.body.appendChild( content );

		try {
			mountExospine();
			const InspectorTab = require( '../tabs/InspectorTab' ).default;
			const view = render(
				<InspectorTab
					host="overlay"
					storageKey="k"
					frame={ { h: 600, w: 800 } }
				/>,
				{ container: content }
			);
			expect( observe ).toHaveBeenCalledWith( tabbar );
			view.unmount();
			expect( disconnect ).toHaveBeenCalled();
		} finally {
			delete window.ResizeObserver;
			document.body.removeChild( tabbar );
			document.body.removeChild( content );
		}
	} );

	it( 'publishes a ref-stable onPathChange that routes through setPath', () => {
		const publishHeader = jest.fn();
		renderInspector( { publishHeader } );
		const cfg = publishHeader.mock.calls
			.map( ( c ) => c[ 0 ] )
			.find( ( c ) => c && 'function' === typeof c.onPathChange );
		expect( cfg ).toBeTruthy();
		// Initial scope is local (empty path).
		expect( cfg.path ).toBe( '' );

		// onPathChange → setPath `cd /_http` republishes the header.
		act( () => cfg.onPathChange( '_http' ) );
		const latest = publishHeader.mock.calls
			.map( ( c ) => c[ 0 ] )
			.filter( ( c ) => c && 'function' === typeof c.onPathChange )
			.pop();
		expect( latest.path ).toBe( '_http' );
	} );

	it( 'requestCompletion fills the local command interpreter', () => {
		renderInspector();
		const ci = Core.node( '_command_interpreter' );
		const seen = [];
		const realFill = ci.fill.bind( ci );
		ci.fill = ( m ) => {
			seen.push( m );
			return realFill( m );
		};
		act( () => mockCaptured.consoleShell.replProps.onComplete( 'gi' ) );
		expect( seen ).toHaveLength( 1 );
	} );

	it( 'a "command" inspector action expands the REPL and dispatches the raw line', () => {
		renderInspector();
		const output = Core.node( '_output' );
		const before = output._transcript.length;
		act( () =>
			mockCaptured.consoleShell.canvasProps.onInspectorAction(
				'command',
				null,
				'debug_level'
			)
		);
		// The Shell echoed the typed line into the transcript.
		expect( output._transcript.length ).toBeGreaterThan( before );
	} );

	it( 'a structured inspector action delegates to the graph handler', () => {
		renderInspector();
		const output = Core.node( '_output' );
		const before = output._transcript.length;
		act( () =>
			mockCaptured.consoleShell.canvasProps.onInspectorAction(
				'dump',
				'_router',
				{}
			)
		);
		// dump_node echoes a `sent` line into the transcript via the handler.
		expect( output._transcript.length ).toBeGreaterThan( before );
	} );

	it( 'a structured inspector action with Compose reply-flags ORs TM_RESPONSE / TM_ERROR onto the dispatched TYPE', () => {
		renderInspector();
		const ci = Core.node( '_command_interpreter' );
		const seen = [];
		const realFill = ci.fill.bind( ci );
		ci.fill = ( m ) => {
			seen.push( m.slice() );
			return realFill( m );
		};
		// Nonexistent target + TM_ERROR → Router drops it silently.
		act( () =>
			mockCaptured.consoleShell.canvasProps.onInspectorAction(
				'cmd',
				'no-such-node',
				'dmesg',
				{ response: true, error: true }
			)
		);
		expect( seen ).toHaveLength( 1 );
		expect( seen[ 0 ][ TYPE ] & TM_RESPONSE ).toBeTruthy();
		expect( seen[ 0 ][ TYPE ] & TM_ERROR ).toBeTruthy();
	} );

	it( 'passes composeTargets derived from the local graph (_command_interpreter first; a node offers its :config sidecar only when it has one, NOT Core.nodes)', () => {
		mountExospine();
		const a = new Node();
		a.name = 'a';
		// Give `a` a patron-linked `:config` sidecar → offers `a:config`.
		const aConfig = new Node();
		aConfig.name = 'a:config';
		aConfig.patron = a;
		// `b` has NO sidecar → it must NOT offer `b:config`.
		const b = new Node();
		b.name = 'b';
		const InspectorTab = require( '../tabs/InspectorTab' ).default;
		render(
			<InspectorTab
				host="overlay"
				storageKey="newspack-nodes:debug"
				frame={ { h: 600, w: 800 } }
			/>
		);
		const targets = mockCaptured.consoleShell.catalogs.composeTargets;
		expect( targets[ 0 ] ).toBe( '_command_interpreter' );
		expect( targets ).toContain( 'a' );
		expect( targets ).toContain( 'a:config' );
		// `b` has no sidecar → present, but no synthesized `b:config`.
		expect( targets ).toContain( 'b' );
		expect( targets ).not.toContain( 'b:config' );
		// _router: real Core node, graph-hidden → source is graph.nodes.
		expect( Core.node( '_router' ) ).not.toBeNull();
		expect( targets ).not.toContain( '_router' );
		expect( targets ).not.toContain( '_router:config' );
	} );

	/**
	 * The overlay drives the BROWSER graph, and no JS class declares a
	 * `vault_id` arg — so `CtorField`'s vault picker can never fire here. The
	 * catalog only reached a PHP class at `/_http`, whose node dies with the
	 * request. It cost a node named `vault:list`, which collided with the
	 * Vault page's view, plus a `vault list` round trip per scope. The
	 * standalone console still offers it: it edits topologies that persist.
	 */
	it( 'offers NO vault catalog — nothing in the browser graph takes one', () => {
		const InspectorTab = require( '../tabs/InspectorTab' ).default;
		render(
			<InspectorTab
				host="overlay"
				storageKey="newspack-nodes:debug"
				frame={ { h: 600, w: 800 } }
			/>
		);
		expect( mockCaptured.consoleShell.catalogs.vaults ).toEqual( [] );
		expect( Core.node( 'vaults:catalog' ) ).toBeNull();
	} );

	it( 'a palette drop records the drop position when the modal is confirmed', () => {
		const { container, getByTestId } = renderInspector();
		act( () =>
			mockCaptured.consoleShell.canvasProps.onDropNode( {
				shellName: 'Echo',
				x: 120,
				y: 80,
			} )
		);
		expect( mockCaptured.modal ).toBeTruthy();
		expect( container.querySelectorAll( '.topology-app' ) ).toHaveLength(
			1
		);
		const modalWrapper = getByTestId( 'pending-node-modal' ).parentElement;
		expect( modalWrapper.style.display ).toBe( 'contents' );
		expect( modalWrapper.className ).toBe( '' );
		// commitDrop fires `make_node Echo my_echo` → creates the node.
		expect( Core.node( 'my_echo' ) ).toBeNull();
		act( () =>
			mockCaptured.modal.onConfirm( { name: 'my_echo', args: '' } )
		);
		expect( Core.node( 'my_echo' ) ).toBeTruthy();
	} );
} );
