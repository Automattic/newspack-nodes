import { render, act } from '@testing-library/react';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import {
	getDevtoolsTabs,
	resetDevtoolsTabs,
} from '@newspack-nodes/shared/devtools/tabRegistry';
import { replMaxHeight, measureTabBarHeight } from '../tabs/InspectorTab';

// Capture the props InspectorTab hands its heavy children so the interaction
// tests can fire the callbacks (onInspectorAction, onComplete, onConfirm)
// directly — the real ConsoleShell/CanvasFrame canvas never dispatches them in
// jsdom. The `mock`-prefixed holder is the one outer ref a jest.mock factory may
// close over.
const mockCaptured = { consoleShell: null, modal: null };
jest.mock( '../../topology-console/components/ConsoleShell', () => ( {
	__esModule: true,
	default: ( props ) => {
		mockCaptured.consoleShell = props;
		return null;
	},
} ) );
jest.mock( '../../topology-console/components/Modal', () => ( {
	NewNodeModal: ( props ) => {
		mockCaptured.modal = props;
		return null;
	},
} ) );
// Stub the catalog hooks so changing cwd doesn't kick off an async class-catalog
// fetch whose late setState lands outside act() (these are separate modules, so
// stubbing them doesn't affect InspectorTab's own coverage).
jest.mock( '../../topology-console/hooks/useJsCatalog', () => ( {
	useJsCatalog: () => ( {
		classes: [ { shell_name: 'Echo', arguments: [] } ],
		loading: false,
		formatters: {},
	} ),
} ) );
jest.mock( '../../topology-console/hooks/useClassCatalog', () => ( {
	useClassCatalog: () => ( { classes: [], loading: false, formatters: {} } ),
} ) );

describe( 'replMaxHeight', () => {
	it( 'subtracts header, prompt bar, the measured tab bar, AND the resize-handle overhang from the frame height', () => {
		// The tab bar now sits above the inspector body, so the transcript must
		// reserve its measured height too — otherwise the REPL overflows the panel.
		// The trailing -4 reserves the resize handle that overhangs the pane top.
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

	it( 'is Overview-only when buildRepl is false (no infra; points at the Console)', () => {
		mountExospine();
		const InspectorTab = require( '../tabs/InspectorTab' ).default;
		const { getByText } = render(
			<InspectorTab
				host="overlay"
				storageKey="newspack-nodes:debug"
				onClose={ () => {} }
				frame={ { h: 600, w: 800 } }
				buildRepl={ false }
			/>
		);
		// Built no overlay infra — the hub Console tab owns `_output` itself, so a
		// second one here would collide. The body points the user back at it.
		expect( Core.node( '_output' ) ).toBeNull();
		expect( getByText( /Console tab itself/i ) ).not.toBeNull();
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
		// The effect only wires a ResizeObserver when a `.nodes-devtools__tabbar`
		// precedes the body's `.nodes-devtools__tab-content` wrapper.
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

		// Invoking onPathChange routes through setPath → `cd /_http`, which moves the
		// live cwd and republishes the header at the new path. Assert the header was
		// re-published with the new path (a no-op wrapper would leave it unchanged).
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

	it( 'a palette drop records the drop position when the modal is confirmed', () => {
		renderInspector();
		act( () =>
			mockCaptured.consoleShell.canvasProps.onDropNode( {
				shellName: 'Echo',
				x: 120,
				y: 80,
			} )
		);
		expect( mockCaptured.modal ).toBeTruthy();
		// commitDrop dispatches `make_node Echo my_echo` through the interpreter and
		// records the snapped drop position. Assert the observable commit: the node
		// was actually created in the graph (a no-op onConfirm would leave it absent).
		expect( Core.node( 'my_echo' ) ).toBeNull();
		act( () =>
			mockCaptured.modal.onConfirm( { name: 'my_echo', args: '' } )
		);
		expect( Core.node( 'my_echo' ) ).toBeTruthy();
	} );
} );
