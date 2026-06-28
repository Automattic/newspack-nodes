/* global globalThis */
/**
 * TopologyConsole tests. useConsoleGraph is mocked to build the REAL receive
 * graph (Router → Dumper/_output, Metadata/_metadata, Uptime/_uptime) plus a
 * real Shell whose sink is the (capture-only) CommandInterpreter and a real
 * per-worker RemoteIpc (named `{topology}.p{N}`) whose composed HttpOut records
 * POSTs via a capturing postBatch client. SSE replies are simulated by filling
 * the RemoteIpc's composed SseIn (the substrate's only format). Mocked child
 * components expose every prop callback as a button so handlers run end-to-end.
 */

import { render, fireEvent, act } from '@testing-library/react';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	KEY,
	VALUE,
	LOCAL,
	TM_BYTESTREAM,
	TM_COMMAND,
	TM_EOF,
	TM_ERROR,
	TM_INFO,
	TM_PING,
	TM_REQUEST,
	TM_RESPONSE,
	TM_STRUCT,
} from '../../runtime/message';
import names from '../../runtime/reserved-node-names.json';

// Pre-seed window.NewspackNodesData for the module-level IIFEs.
window.NewspackNodesData = {
	restUrl: '/wp-json/',
	nonce: 'NONCE',
	topologyWorkers: { demo: 2 },
	activeTopologies: [ 'demo' ],
	version: 'test',
	userLogin: 'tester',
};

// Capture HttpOut POSTs (the worker-bound batch each typed/poll command makes).
globalThis.__httpPosts = [];
// {topology}.p{N} the mock graph is built for; a change rebuilds a fresh graph.
globalThis.__graphKey = null;
globalThis.__shell = null;
// The reader the current mock RemoteIpc is registered under (for teardown).
globalThis.__reader = null;
// A no-op EventSource so the RemoteIpc's composed SseIn can start() without a
// real network connection.
class FakeEventSource {
	constructor( url ) {
		this.url = url;
	}
	addEventListener() {}
	close() {}
}
global.EventSource = FakeEventSource;
jest.mock( '../hooks/useConsoleGraph', () => {
	const { Core } = require( '../../runtime/core' );
	const { RouterNode } = require( '../../runtime/router-node' );
	const {
		CommandInterpreterNode,
	} = require( '../../runtime/command-interpreter-node' );
	const { Node } = require( '../../runtime/node' );
	const { DumperNode } = require( '../../runtime/dumper-node' );
	const { MetadataNode } = require( '../../runtime/metadata-node' );
	const { UptimeNode } = require( '../../runtime/uptime-node' );
	const { CompletionNode } = require( '../../runtime/completion-node' );
	const { RemoteIpcNode } = require( '../../runtime/remote-ipc-node' );
	const { ShellNode } = require( '../../runtime/shell-node' );
	const reserved = require( '../../runtime/reserved-node-names.json' );
	const NAMES = [
		reserved.ROUTER,
		reserved.COMMAND_INTERPRETER,
		reserved.OUTPUT,
		reserved.METADATA,
		reserved.UPTIME,
		reserved.COMPLETION,
		reserved.CWD,
	];
	const teardown = () => {
		Core.node( reserved.ROUTER )?.stopTimer();
		// The per-worker RemoteIpc tears down its composed children + stream.
		if ( globalThis.__reader ) {
			Core.node( globalThis.__reader )?.removeNode();
		}
		RemoteIpcNode.active = null;
		for ( const n of NAMES ) {
			Core.unregisterNode( n );
		}
		globalThis.__graphKey = null;
		globalThis.__shell = null;
		globalThis.__reader = null;
	};
	return {
		useConsoleGraph: ( {
			topology,
			partition,
			enabled,
			debugLevelRef,
		} ) => {
			// Mirror the real hook: rebuild on a graphGeneration bump (Reset Graph
			// bumps it via useGraphReset). Rules of hooks require this unconditional
			// call before the enabled early-return, hence assigned-before-use.
			// eslint-disable-next-line @wordpress/no-unused-vars-before-return
			const generation =
				require( '../../runtime/react' ).useGraphGeneration();
			if ( ! enabled ) {
				teardown();
				return { status: 'closed', ssePid: null, shell: null };
			}
			const reader = `${ topology }.p${ partition }`;
			// Tear down + rebuild whenever the reader OR the generation changes —
			// without the generation here the mock would never re-mount on a
			// reset-graph click, masking cwd-preservation / wipe bugs.
			const key = `${ reader }|${ generation }`;
			if ( globalThis.__graphKey !== key ) {
				teardown();
				const router = new RouterNode();
				router.name = reserved.ROUTER;
				const interpreter = new CommandInterpreterNode();
				interpreter.name = reserved.COMMAND_INTERPRETER;
				interpreter.sink = router;
				const dumper = new DumperNode();
				dumper.debugLevelRef = debugLevelRef;
				dumper.name = reserved.OUTPUT;
				const metadata = new MetadataNode();
				metadata.name = reserved.METADATA;
				const uptime = new UptimeNode();
				uptime.name = reserved.UPTIME;
				new CompletionNode().name = reserved.COMPLETION;
				// One RemoteIpc for the session's worker, named `{reader}`. It
				// composes a SseIn (receive) + an HttpOut (POST) + a Heartbeat; its
				// composed HttpOut's client captures the routed batch instead of
				// POSTing. The RemoteIpc wraps a reply-node FROM into `_sse:{pid}` and
				// bundles connect_worker_input — the worker-pivot send path.
				const remote = interpreter.makeNode(
					'RemoteIpc',
					reader,
					`${ reader } / `
				);
				remote.target = reserved.OUTPUT;
				remote.client = {
					postBatch: ( entries ) => {
						globalThis.__httpPosts.push( ...entries );
						return Promise.resolve( [] );
					},
				};
				// Boot its stream + force a connected pid so the FROM-wrap resolves to
				// the stable 1234 the assertions expect. The connected envelope is
				// now the flat string the server sends; _applyConnected parses pid +
				// slot into the SseIn's plain fields (the no-op FakeEventSource here
				// can't deliver a real `msg` frame).
				remote.connect();
				remote.sseIn._applyConnected(
					'PID 1234 SLOT 1 SUBSCRIPTIONS demo.p0 INTERVAL 2000'
				);
				const shell = new ShellNode();
				shell.path = reader;
				shell.sink = interpreter;
				// `_cwd` indirection node: a plain Node whose target IS the cwd.
				const cwdNode = new Node();
				cwdNode.name = reserved.CWD;
				cwdNode.sink = interpreter;
				cwdNode.target = shell.path;
				// Mirror the real timer wiring so the cadence test exercises the
				// Router TIMER → notify_timer → Metadata/Uptime fire → … → RemoteIpc path.
				metadata.sink = interpreter;
				uptime.sink = interpreter;
				metadata.target = reserved.CWD;
				uptime.target = reserved.CWD;
				router.beforeTimerNotify = () =>
					RemoteIpcNode.active?.httpOut?.lock();
				router.afterTimerNotify = () =>
					RemoteIpcNode.active?.httpOut?.flush();
				// Metadata/Uptime hitchhike the _router TIMER (set_timer() no args):
				// notify_timer calls their fireCb -> fire each tick.
				metadata.setTimer();
				uptime.setTimer();
				// Router self-starts a 1s real-timer slot in its constructor
				// (setTimer(1000), no immediate fire). Stop the recurring interval so
				// that under heavy parallel-coverage CPU pressure a slow test (>1s)
				// doesn't see a surprise dump_metadata round-trip overwrite
				// test-injected metadata state. The cadence test re-installs its own
				// fake-timer interval below before relying on it.
				router.stopTimer();
				globalThis.__shell = shell;
				globalThis.__reader = reader;
				globalThis.__graphKey = key;
			}
			// `__connecting` simulates the pre-connect window: enabled (worker cwd)
			// but no pid yet, so the cwd guard can be exercised.
			return globalThis.__connecting
				? {
						status: 'connecting',
						ssePid: null,
						shell: globalThis.__shell,
				  }
				: { status: 'open', ssePid: 1234, shell: globalThis.__shell };
		},
	};
} );
// Mutable globals the hoisted jest.mock factories read at call time.
globalThis.__hooks = {
	topologies: [],
	fetchTopology: jest.fn().mockResolvedValue( null ),
	saveTopology: jest.fn().mockResolvedValue( null ),
	deleteTopology: jest.fn().mockResolvedValue( null ),
	// Default: never resolves. Tests that need a resolved layout call
	// `hooks.fetchLayout.mockResolvedValueOnce(...)` in setup. Resolving by
	// default fires setSavedLayout outside the test's act() boundary,
	// producing the act()-warning swarm.
	fetchLayout: jest.fn( () => new Promise( () => {} ) ),
	saveLayout: jest.fn().mockResolvedValue( null ),
	// Live topology catalog: `catalog` null → mirror the real hook's seed from
	// window.NewspackNodesData (so the existing pathOptions tests keep driving via
	// the global); set it to override. reloadCatalog asserts the save/delete refresh.
	reloadCatalog: jest.fn(),
	catalog: null,
};
const hooks = globalThis.__hooks;
jest.mock( '../hooks/useTopologyList', () => ( {
	useTopologyList: () => ( {
		topologies: globalThis.__hooks.topologies,
		userDir: '',
		loading: false,
		error: null,
		reload: () => {},
	} ),
	useTopology: () => globalThis.__hooks.fetchTopology,
} ) );
jest.mock( '../hooks/useTopologyCatalog', () => ( {
	useTopologyCatalog: () => {
		const override = globalThis.__hooks.catalog;
		const data = globalThis.NewspackNodesData || {};
		return {
			partitions: override
				? override.partitions
				: data.topologyWorkers || {},
			active: override ? override.active : data.activeTopologies || [],
			reload: globalThis.__hooks.reloadCatalog,
		};
	},
} ) );
// Mutable catalog the hoisted mock reads at call time; tests seed
// classes (with is_interpreter) before rendering to exercise verb routing.
globalThis.__catalog = { classes: [], formatters: [] };
jest.mock( '../hooks/useClassCatalog', () => ( {
	useClassCatalog: () => ( {
		classes: globalThis.__catalog.classes,
		formatters: globalThis.__catalog.formatters,
		loading: false,
		error: null,
	} ),
} ) );
jest.mock( '../hooks/useLayout', () => ( {
	useLayout: () => ( {
		fetchLayout: globalThis.__hooks.fetchLayout,
		saveLayout: globalThis.__hooks.saveLayout,
	} ),
} ) );
jest.mock( '../hooks/useSaveTopology', () => ( {
	useSaveTopology: () => globalThis.__hooks.saveTopology,
} ) );
jest.mock( '../hooks/useDeleteTopology', () => ( {
	useDeleteTopology: () => globalThis.__hooks.deleteTopology,
} ) );
// Capture canvas + inspector props so tests can invoke any threaded handler.
let lastCanvasProps = null;
let lastInspectorProps = null;
let lastHeaderProps = null;
jest.mock( '../components/SchematicCanvas', () => {
	// Pure renderer: useCanvasLayout owns positions now, so the mock just
	// records props and renders the gesture buttons (no seed effect).
	return ( props ) => {
		lastCanvasProps = props;
		return mockCanvasMarkup( props );
	};
} );
function mockCanvasMarkup( props ) {
	return (
		<div
			data-testid="canvas"
			data-mode={ props.editMode ? 'edit' : 'view' }
			data-node-count={ props.parsed?.nodes?.length ?? 0 }
		>
			<button onClick={ () => props.onSelect && props.onSelect( 'n1' ) }>
				select-n1
			</button>
			<button
				onClick={ () =>
					props.onSelectEdge &&
					props.onSelectEdge( { from: 'n1', to: 'n2' } )
				}
			>
				select-edge
			</button>
			<button onClick={ () => props.onDeselect && props.onDeselect() }>
				deselect
			</button>
			<button
				onClick={ () =>
					props.onPositionChange &&
					props.onPositionChange( 'n1', { x: 100, y: 200 } )
				}
			>
				move-n1
			</button>
			<button
				onClick={ () =>
					props.onViewportChange &&
					props.onViewportChange( {
						x: 10,
						y: 20,
						w: 800,
						h: 600,
					} )
				}
			>
				vp-change
			</button>
			<button
				onClick={ () => props.onConnect && props.onConnect( 'a', 'b' ) }
			>
				connect-a-b
			</button>
			<button
				onClick={ () =>
					props.onBackgroundClickConsumed &&
					props.onBackgroundClickConsumed()
				}
			>
				bg-consumed
			</button>
		</div>
	);
}
jest.mock( '../components/Inspector', () => ( props ) => {
	lastInspectorProps = props;
	return (
		<div
			data-testid="inspector"
			data-selected-id={ props.selectedId ?? '' }
		>
			<button
				onClick={ () =>
					props.onAction && props.onAction( 'dump', 'n1' )
				}
			>
				action-dump
			</button>
			<button
				onClick={ () =>
					props.onAction && props.onAction( 'tail', 'n1' )
				}
			>
				action-tail
			</button>
			<button
				onClick={ () =>
					props.onAction && props.onAction( 'send', 'n1', 'payload' )
				}
			>
				action-send
			</button>
			<button
				onClick={ () =>
					props.onAction && props.onAction( 'trace', 'n1', 1 )
				}
			>
				action-trace
			</button>
			<button
				onClick={ () =>
					props.onAction &&
					props.onAction( 'invoke', 'n1', {
						verb: 'GET_LAG',
						kind: 'request',
						positional: '',
						byName: {},
					} )
				}
			>
				action-request
			</button>
			<button
				onClick={ () =>
					props.onAction &&
					props.onAction( 'invoke', 'n1', {
						verb: 'set_is_hub',
						kind: 'command',
						positional: '',
						byName: {},
					} )
				}
			>
				action-command
			</button>
			<button
				onClick={ () =>
					props.onAction && props.onAction( 'disconnect', 'n1' )
				}
			>
				action-disconnect
			</button>
			<button
				onClick={ () =>
					props.onRemoveNode && props.onRemoveNode( 'n1' )
				}
			>
				remove-n1
			</button>
			<button
				onClick={ () =>
					props.onRemoveEdge && props.onRemoveEdge( 'n1', 'n2' )
				}
			>
				remove-edge
			</button>
			<button
				onClick={ () =>
					props.onRenameNode && props.onRenameNode( 'n1', 'renamed' )
				}
			>
				rename-n1
			</button>
			<button
				onClick={ () =>
					props.onUpdateArgs && props.onUpdateArgs( 'n1', [ 'arg1' ] )
				}
			>
				update-args
			</button>
			<button
				onClick={ () =>
					props.onUpdateVerbs && props.onUpdateVerbs( 'n1', [] )
				}
			>
				update-verbs
			</button>
		</div>
	);
} );
// The Console now portals its controls via the named `HeaderControls` export
// (the default `Header` is the hub's brand bar, unused here). Capture the
// control props + render the buttons off HeaderControls.
jest.mock( '../components/Header', () => ( {
	__esModule: true,
	default: () => <header data-testid="brand-header" />,
	HeaderControls: ( props ) => {
		lastHeaderProps = props;
		return (
			<header data-testid="header" data-mode={ props.mode }>
				<button onClick={ () => props.onModeChange( 'edit' ) }>
					edit
				</button>
				<button onClick={ () => props.onModeChange( 'view' ) }>
					view
				</button>
				<button onClick={ () => props.onSave && props.onSave() }>
					save
				</button>
				<button onClick={ () => props.onOpen && props.onOpen() }>
					open
				</button>
				<button onClick={ () => props.onNew && props.onNew() }>
					new
				</button>
				<button
					onClick={ () => props.onSettings && props.onSettings() }
				>
					settings
				</button>
				<button onClick={ () => props.onDelete && props.onDelete() }>
					delete
				</button>
			</header>
		);
	},
} ) );
let lastPaletteProps = null;
jest.mock( '../components/Palette', () => ( props ) => {
	lastPaletteProps = props;
	return (
		<aside data-testid="palette">
			<button
				onClick={ () =>
					props.onDropNode &&
					props.onDropNode( {
						shellName: 'Echo',
						x: 50,
						y: 60,
					} )
				}
			>
				drop-echo
			</button>
		</aside>
	);
} );
let lastReplProps = null;
jest.mock( '../components/ReplFooter', () => ( props ) => {
	lastReplProps = props;
	return (
		<footer
			data-testid="repl"
			data-expanded={ props.expanded ? '1' : '0' }
			data-can-send={ props.canSend ? '1' : '0' }
		>
			<button onClick={ () => props.onSubmit && props.onSubmit( 'ls' ) }>
				submit
			</button>
			<button
				onClick={ () => props.onComplete && props.onComplete( 'conn' ) }
			>
				complete-verb
			</button>
			<button
				onClick={ () =>
					props.onComplete && props.onComplete( 'dump_node ec' )
				}
			>
				complete-arg
			</button>
			<button
				onClick={ () =>
					props.onShowCandidates &&
					props.onShowCandidates( [ 'connect', 'connect_node' ] )
				}
			>
				show-candidates
			</button>
			<button
				onClick={ () =>
					props.onSubmit && props.onSubmit( 'clear; debug_level 1' )
				}
			>
				submit-multi
			</button>
			<ul data-testid="repl-transcript">
				{ ( props.transcript || [] ).map( ( t ) => (
					<li key={ t.key } data-kind={ t.kind } data-text={ t.text }>
						{ t.text }
					</li>
				) ) }
			</ul>
		</footer>
	);
} );
jest.mock( '../components/CanvasFrame', () => ( props ) => {
	return (
		<div data-testid="canvas-frame">
			{ props.onSaveLayout && (
				<button onClick={ () => props.onSaveLayout() }>
					save-layout
				</button>
			) }
			{ props.onResetLayout && (
				<button onClick={ () => props.onResetLayout() }>
					reset-layout
				</button>
			) }
			{ props.onResetGraph && (
				<button onClick={ () => props.onResetGraph() }>
					reset-graph
				</button>
			) }
			{ props.children }
		</div>
	);
} );
// Expose modal callbacks so tests can invoke confirm/cancel/onPick.
globalThis.__lastConfirmModal = null;
globalThis.__lastPromptModal = null;
globalThis.__lastOpenTopologyModal = null;
jest.mock( '../components/OpenTopologyModal', () => ( props ) => {
	globalThis.__lastOpenTopologyModal = props;
	return (
		<div data-testid="open-modal">
			<button onClick={ () => props.onPick && props.onPick( 'picked' ) }>
				pick
			</button>
			<button onClick={ () => props.onCancel && props.onCancel() }>
				cancel-open
			</button>
		</div>
	);
} );
jest.mock( '../components/Modal', () => ( {
	ConfirmModal: ( props ) => {
		globalThis.__lastConfirmModal = props;
		return (
			<div data-testid="confirm-modal">
				<button onClick={ () => props.onConfirm && props.onConfirm() }>
					confirm
				</button>
				<button onClick={ () => props.onCancel && props.onCancel() }>
					cancel-confirm
				</button>
			</div>
		);
	},
	PromptModal: ( props ) => {
		globalThis.__lastPromptModal = props;
		return (
			<div data-testid="prompt-modal">
				<button
					onClick={ () =>
						props.onConfirm && props.onConfirm( 'newname' )
					}
				>
					prompt-ok
				</button>
				<button onClick={ () => props.onCancel && props.onCancel() }>
					prompt-cancel
				</button>
			</div>
		);
	},
	NewNodeModal: ( props ) => {
		globalThis.__lastNewNodeModal = props;
		return (
			<div data-testid="newnode-modal">
				<button
					onClick={ () =>
						props.onConfirm &&
						props.onConfirm( {
							name: props.defaultName,
							args: '',
						} )
					}
				>
					Add
				</button>
				<button onClick={ () => props.onCancel && props.onCancel() }>
					newnode-cancel
				</button>
			</div>
		);
	},
} ) );

// Capture the activate dispatch (a brand-new save prompts "Activate now?",
// confirming routes through the command client). send() resolves so the
// post-activate toast path runs in act().
globalThis.__activateSend = jest.fn().mockResolvedValue( null );
jest.mock( '../utils/commandClient', () => ( {
	getCommandClient: () => ( {
		send: ( ...args ) => globalThis.__activateSend( ...args ),
	} ),
} ) );

import TopologyConsole, { initialTopologyFromUrl } from '../TopologyConsole';
import { Core } from '../../runtime/core';

// Build a positional Message; default TO routes to the Dumper transcript.
function posMsg( { type, value, from = 'worker', to = names.OUTPUT } ) {
	const m = newMessage();
	m[ TYPE ] = type;
	m[ FROM ] = from;
	m[ TO ] = to;
	m[ VALUE ] = value;
	return m;
}

describe( 'TopologyConsole boot', () => {
	beforeEach( () => {
		window.history.replaceState( {}, '', '/' );
		window.localStorage.clear();
		Core.reset();
		globalThis.__graphKey = null;
		globalThis.__shell = null;
		globalThis.__httpPosts = [];
		hooks.fetchTopology.mockReset();
		hooks.fetchTopology.mockResolvedValue( null );
		hooks.saveTopology.mockReset();
		hooks.saveTopology.mockResolvedValue( null );
		globalThis.__activateSend.mockReset();
		globalThis.__activateSend.mockResolvedValue( null );
		hooks.deleteTopology.mockReset();
		hooks.deleteTopology.mockResolvedValue( null );
		hooks.fetchLayout.mockReset();
		// Resolve to "no saved layout" by default so layoutReady's
		// serverFetchResolved gate clears (a never-resolving fetch would hold the
		// canvas behind the building placeholder forever). Tests needing a saved
		// layout override with mockResolvedValueOnce.
		hooks.fetchLayout.mockResolvedValue( { positions: null } );
		hooks.saveLayout.mockReset();
		hooks.saveLayout.mockResolvedValue( null );
		hooks.topologies = [];
		hooks.reloadCatalog.mockReset();
		hooks.catalog = null;
		globalThis.__catalog = { classes: [], formatters: [] };
	} );

	// Simulate an SSE reply: the Router routes a positional Message by TO.
	// Followed by a second empty act() to drain React's deferred-batch queue —
	// under `run-coverage`'s parallel fan-out (3 jest --coverage processes
	// competing for CPU) the post-fill re-render can slip past a single act
	// boundary, causing `getByText`/`queryByText` assertions to see a stale
	// pre-render DOM. The second act flushes the next batch deterministically.
	const fireMsg = async ( opts ) => {
		await act( async () => {
			Core.node( names.ROUTER ).fill( posMsg( opts ) );
		} );
		await act( async () => {} );
	};

	// Publish a dump_metadata snapshot so the canvas's layout graph is ready
	// (the GraphView only renders once layoutReady, i.e. the graph has ≥1 node).
	// Defaults to a single Echo `n1` for tests that just need the canvas mounted.
	const publishMeta = async (
		value = { n1: { class: 'Echo', counter: 0, sink: '', target: '' } }
	) => {
		await fireMsg( { type: TM_STRUCT, to: names.METADATA, value } );
	};

	it( 'renders Header, Palette, Canvas, and ReplFooter on mount (Inspector collapsed to a rail until selected)', async () => {
		// Palette is always-on per the interactive-live-canvas spec: a drop in
		// view mode issues `make_node` via sendLine; a drop in edit adds to the
		// draft. Edit-only gating was a stale Task 3 regression. The canvas
		// renders once the layout graph is ready (≥1 node published).
		const { getByTestId, queryByTestId } = render( <TopologyConsole /> );
		await publishMeta();
		expect( getByTestId( 'header' ) ).not.toBeNull();
		expect( getByTestId( 'palette' ) ).not.toBeNull();
		expect( getByTestId( 'canvas' ) ).not.toBeNull();
		// The inspector defaults collapsed (a rail) — its panel content isn't
		// rendered until a selection (or the chevron) expands it.
		expect( queryByTestId( 'inspector' ) ).toBeNull();
		expect( getByTestId( 'repl' ) ).not.toBeNull();
	} );

	it( 'starts in view mode by default', async () => {
		const { getByTestId } = render( <TopologyConsole /> );
		await publishMeta();
		expect( getByTestId( 'header' ).dataset.mode ).toBe( 'view' );
		expect( getByTestId( 'canvas' ).dataset.mode ).toBe( 'view' );
	} );

	it( 'polls dump_metadata every tick and uptime on the 5s cadence (reply pivots to _metadata/_uptime)', async () => {
		jest.useFakeTimers();
		try {
			globalThis.__httpPosts = [];
			window.history.replaceState( {}, '', '/?topology=demo' );
			act( () => {
				render( <TopologyConsole /> );
			} );
			// The useConsoleGraph mock stops the Router's auto-started 1s
			// timer (real-timer flake mitigation for OTHER tests). Re-install
			// the 1s cadence here so jest.advanceTimersByTime(1000) below
			// triggers the next dump_metadata round-trip, then drive one tick
			// (setTimer doesn't fire immediately) for the initial paint.
			act( () => {
				Core.node( names.ROUTER ).setTimer( 1000 );
				Core.node( names.ROUTER ).fireCb();
			} );
			const verbOf = ( m ) => m[ VALUE ] && m[ VALUE ].name;
			const fromOf = ( m ) => m[ FROM ];
			const dumps = () =>
				globalThis.__httpPosts.filter(
					( m ) => verbOf( m ) === 'dump_metadata'
				);
			const uptimes = () =>
				globalThis.__httpPosts.filter(
					( m ) => verbOf( m ) === 'uptime'
				);
			// Immediate paint: one of each.
			expect( dumps().length ).toBeGreaterThanOrEqual( 1 );
			expect( uptimes().length ).toBeGreaterThanOrEqual( 1 );
			// RemoteIpc wrapped each poll's bare reply-node FROM into the private pivot.
			expect( fromOf( dumps()[ 0 ] ) ).toBe(
				`${ names.SSE }:1234/${ names.METADATA }`
			);
			expect( fromOf( uptimes()[ 0 ] ) ).toBe(
				`${ names.SSE }:1234/${ names.UPTIME }`
			);
			// The Router peeled _http before delivering to HttpOut, so the
			// captured TO is the bare reader.
			expect( dumps()[ 0 ][ TO ] ).toBe( 'demo.p0' );
			// One stats tick: a new dump, uptime NOT due.
			const dumpBefore = dumps().length;
			const uptimeBefore = uptimes().length;
			act( () => {
				jest.advanceTimersByTime( 1000 );
			} );
			expect( dumps().length ).toBeGreaterThan( dumpBefore );
			expect( uptimes().length ).toBe( uptimeBefore );
			// Reaching the 5s cadence: uptime fires again.
			act( () => {
				jest.advanceTimersByTime( 4000 );
			} );
			expect( uptimes().length ).toBeGreaterThan( uptimeBefore );
		} finally {
			jest.useRealTimers();
		}
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'onComplete on the FIRST token dispatches a `help` completion query (KEY=completion, FROM pivots to _completion)', async () => {
		globalThis.__httpPosts = [];
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		act( () => {
			fireEvent.click( getByText( 'complete-verb' ) );
		} );
		const completions = globalThis.__httpPosts.filter(
			( m ) => m[ KEY ] === 'completion'
		);
		expect( completions.length ).toBe( 1 );
		const m = completions[ 0 ];
		expect( m[ VALUE ].name ).toBe( 'help' );
		// RemoteIpc wrapped the bare _completion reply-node FROM into the private pivot.
		expect( m[ FROM ] ).toBe( `${ names.SSE }:1234/${ names.COMPLETION }` );
		expect( m[ TO ] ).toBe( 'demo.p0' );
		// Minted in-process → LOCAL taint set (the wire pack() strips it later).
		expect( m[ LOCAL ] ).toBe( true );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'onComplete on a LATER token dispatches an `ls` completion query', async () => {
		globalThis.__httpPosts = [];
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		act( () => {
			fireEvent.click( getByText( 'complete-arg' ) );
		} );
		const completions = globalThis.__httpPosts.filter(
			( m ) => m[ KEY ] === 'completion'
		);
		expect( completions.length ).toBe( 1 );
		expect( completions[ 0 ][ VALUE ].name ).toBe( 'ls' );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'onShowCandidates renders the candidate list into the transcript', () => {
		const { getByText, container } = render( <TopologyConsole /> );
		act( () => {
			fireEvent.click( getByText( 'show-candidates' ) );
		} );
		const items = Array.from(
			container.querySelectorAll( '[data-testid="repl-transcript"] li' )
		);
		const listed = items.find( ( i ) =>
			i.textContent.includes( 'connect_node' )
		);
		expect( listed ).not.toBeUndefined();
	} );

	it( 'clicking New keeps the editor body rendered (blank draft carries the _repl anchor, not blanked behind the building gate)', async () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'new' ) );
		} );
		// Regression: handleNew built a raw { nodes: [] } draft (no _repl anchor),
		// so layoutGraph had 0 nodes → ConsoleShell's ready gate fell to the
		// building placeholder, blanking palette/canvas/inspector.
		expect(
			document.querySelector( '.topology-canvas-building' )
		).toBeNull();
		expect( queryByTestId( 'canvas' ) ).not.toBeNull();
	} );

	it( 'auto-enters edit mode on mount when the URL carries ?edit=1 (Topologies-tab deep link)', async () => {
		window.history.replaceState( {}, '', '/?topology=demo&edit=1' );
		render( <TopologyConsole /> );
		await act( async () => {} );
		// The Topologies tab's Edit/New buttons deep-link with ?edit=1; the console
		// must land in edit mode rather than live view.
		expect( lastHeaderProps.mode ).toBe( 'edit' );
	} );

	it( 'clicking New from live mode enters edit mode with a blank draft', async () => {
		const { getByText } = render( <TopologyConsole /> );
		expect( lastHeaderProps.mode ).toBe( 'view' );
		await act( async () => {
			fireEvent.click( getByText( 'new' ) );
		} );
		// New is a "start a fresh topology" affordance — it must switch into edit
		// mode, not just blank the (unshown) draft while staying in live view.
		expect( lastHeaderProps.mode ).toBe( 'edit' );
	} );

	it( 'switching to edit mode flips header + canvas + reveals palette', () => {
		const { getByText, getByTestId, queryByTestId } = render(
			<TopologyConsole />
		);
		fireEvent.click( getByText( 'edit' ) );
		expect( getByTestId( 'header' ) ).not.toBeNull();
		fireEvent.click( getByText( 'view' ) );
		expect( queryByTestId( 'header' ) ).not.toBeNull();
	} );

	it( 'edit shows the delete button when the loaded topology has a user copy (no Open needed)', async () => {
		// canDelete must derive from the get response `source`, NOT the
		// Open-modal topology list (which is empty until Open is shown). Empty
		// list + source:user => delete button still appears on edit.
		globalThis.__hooks.topologies = [];
		globalThis.__hooks.fetchTopology.mockResolvedValue( {
			name: 'demo',
			source: 'user',
			tsl: 'make_node Echo e\n',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		expect( lastHeaderProps.canDelete ).toBe( true );
	} );

	it( 'edit hides the delete button when the loaded topology is stock-only', async () => {
		globalThis.__hooks.topologies = [];
		globalThis.__hooks.fetchTopology.mockResolvedValue( {
			name: 'demo',
			source: 'stock',
			tsl: 'make_node Echo e\n',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		expect( lastHeaderProps.canDelete ).toBe( false );
	} );

	it( 'ReplFooter onSubmit dispatches without throwing', async () => {
		const { getByText, getByTestId } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'submit' ) );
		} );
		expect( getByTestId( 'repl' ) ).not.toBeNull();
	} );

	it( 'Dumper: TM_BYTESTREAM appends value to transcript as recv', async () => {
		const { container } = render( <TopologyConsole /> );
		await fireMsg( { type: TM_BYTESTREAM, value: 'hello world' } );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const recv = Array.from( items ).find(
			( i ) => i.dataset.kind === 'recv'
		);
		expect( recv ).not.toBeUndefined();
		expect( recv.textContent ).toBe( 'hello world' );
	} );

	it( 'Dumper: TM_EOF is dropped silently', async () => {
		const { container } = render( <TopologyConsole /> );
		await fireMsg( { type: TM_EOF, value: '' } );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		expect( items.length ).toBe( 0 );
	} );

	it( 'Dumper: TM_PING formats round trip time', async () => {
		const { container } = render( <TopologyConsole /> );
		const past = Date.now() / 1000 - 0.05;
		await fireMsg( { type: TM_PING, value: String( past ) } );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const info = Array.from( items ).find(
			( i ) => i.dataset.kind === 'info'
		);
		expect( info ).not.toBeUndefined();
		expect( info.textContent ).toMatch( /round trip time:.+ms/ );
	} );

	it( 'Dumper: TM_ERROR routes to error transcript kind', async () => {
		const { container } = render( <TopologyConsole /> );
		await fireMsg( { type: TM_ERROR, value: 'something went wrong' } );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const err = Array.from( items ).find(
			( i ) => i.dataset.kind === 'error'
		);
		expect( err ).not.toBeUndefined();
		expect( err.textContent ).toBe( 'something went wrong' );
	} );

	it( 'Dumper: TM_COMMAND|TM_RESPONSE unwraps payload', async () => {
		const { container } = render( <TopologyConsole /> );
		const t = TM_COMMAND | TM_RESPONSE;
		await fireMsg( {
			type: t,
			value: { name: 'ls', payload: 'ls result' },
		} );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const recv = Array.from( items ).find(
			( i ) => i.dataset.kind === 'recv'
		);
		expect( recv ).not.toBeUndefined();
		expect( recv.textContent ).toBe( 'ls result' );
	} );

	it( 'Dumper: TM_COMMAND|TM_RESPONSE with empty payload is dropped', async () => {
		const { container } = render( <TopologyConsole /> );
		const t = TM_COMMAND | TM_RESPONSE;
		await fireMsg( { type: t, value: { payload: '' } } );
		await fireMsg( { type: t, value: null } );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		expect( items.length ).toBe( 0 );
	} );

	it( 'Dumper: a structured dump_node reply renders as JSON, not [object Object]', async () => {
		const { container } = render( <TopologyConsole /> );
		const t = TM_COMMAND | TM_RESPONSE;
		await fireMsg( {
			type: t,
			value: { name: 'dump_node', payload: { sink: 'x', counter: 3 } },
		} );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const recv = Array.from( items ).find(
			( i ) => i.dataset.kind === 'recv'
		);
		expect( recv ).not.toBeUndefined();
		expect( recv.textContent ).toMatch( /"counter": 3/ );
		expect( recv.textContent ).not.toContain( '[object Object]' );
	} );

	it( 'Dumper: TM_COMMAND|TM_ERROR unwraps as error', async () => {
		const { container } = render( <TopologyConsole /> );
		const t = TM_COMMAND | TM_ERROR;
		await fireMsg( { type: t, value: { name: 'x', payload: 'bad arg' } } );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const err = Array.from( items ).find(
			( i ) => i.dataset.kind === 'error'
		);
		expect( err ).not.toBeUndefined();
		expect( err.textContent ).toBe( 'bad arg' );
	} );

	it( 'Dumper: TM_STRUCT stringifies object payload', async () => {
		const { container } = render( <TopologyConsole /> );
		await fireMsg( { type: TM_STRUCT, value: { foo: 'bar' } } );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const recv = Array.from( items ).find(
			( i ) => i.dataset.kind === 'recv'
		);
		expect( recv ).not.toBeUndefined();
		expect( recv.textContent ).toMatch( /"foo": "bar"/ );
	} );

	it( 'Dumper: TM_INFO routes through as recv (curated level 0)', async () => {
		const { container } = render( <TopologyConsole /> );
		await fireMsg( { type: TM_INFO, value: 'some info' } );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const recv = Array.from( items ).find(
			( i ) => i.dataset.kind === 'recv'
		);
		expect( recv ).not.toBeUndefined();
		expect( recv.textContent ).toBe( 'some info' );
	} );

	it( 'Dumper: unknown TM flag falls through to null (dropped)', async () => {
		const { container } = render( <TopologyConsole /> );
		await fireMsg( { type: 0, value: 'noflag' } );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		expect( items.length ).toBe( 0 );
	} );

	it( 'reply TO=_metadata feeds parseMetadata + skips transcript', async () => {
		const { getByTestId } = render( <TopologyConsole /> );
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: {
				n1: {
					class: 'Echo',
					counter: 7,
					sink: '_command_interpreter',
					target: 'n2',
				},
				n2: {
					class: 'Echo',
					counter: 3,
					sink: '_command_interpreter',
					target: '',
				},
			},
		} );
		expect( getByTestId( 'canvas' ).dataset.nodeCount ).toBe( '2' );
		const items = document.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		expect( items.length ).toBe( 0 );
	} );

	it( 'reply TO=_metadata with a {name,payload} envelope feeds the canvas', async () => {
		const { getByTestId } = render( <TopologyConsole /> );
		await fireMsg( {
			type: TM_COMMAND | TM_RESPONSE,
			to: names.METADATA,
			value: {
				name: 'dump_metadata',
				payload: {
					n1: { class: 'Echo', counter: 7, target: 'n2' },
					n2: { class: 'Echo', counter: 3, target: '' },
				},
			},
		} );
		expect( getByTestId( 'canvas' ).dataset.nodeCount ).toBe( '2' );
	} );

	it( 'reply TO=_uptime extracts the right-half uptime + skips the transcript', async () => {
		const { getByTestId } = render( <TopologyConsole /> );
		await fireMsg( {
			type: TM_BYTESTREAM,
			to: names.UPTIME,
			value: '09:44:52  up 0 days, 00:01:00\n',
		} );
		expect( getByTestId( 'repl-transcript' ).children.length ).toBe( 0 );
	} );

	it( 'debug_level 1 injects a type/from header', async () => {
		const { container, getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'submit-multi' ) );
		} );
		await fireMsg( { type: TM_BYTESTREAM, value: 'hi' } );
		const items = Array.from(
			container.querySelectorAll( '[data-testid="repl-transcript"] li' )
		);
		const header = items.find( ( i ) =>
			i.textContent.includes( 'TM_BYTESTREAM from worker:' )
		);
		expect( header ).not.toBeUndefined();
	} );

	it( 'sendLine: clear builtin empties the transcript', async () => {
		const { container, getByText } = render( <TopologyConsole /> );
		await fireMsg( { type: TM_BYTESTREAM, value: 'pre-clear' } );
		expect(
			container.querySelectorAll( '[data-testid="repl-transcript"] li' )
				.length
		).toBeGreaterThan( 0 );
		await act( async () => {
			fireEvent.click( getByText( 'submit-multi' ) );
		} );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		expect( items.length ).toBe( 2 );
		expect( items[ 0 ].dataset.kind ).toBe( 'sent' );
		expect( items[ 1 ].dataset.kind ).toBe( 'info' );
		expect( items[ 1 ].textContent ).toMatch( /debug_level:/ );
	} );

	it( 'transcript caps at TRANSCRIPT_MAX entries', async () => {
		const { container } = render( <TopologyConsole /> );
		await act( async () => {
			for ( let i = 0; i < 250; i++ ) {
				Core.node( names.ROUTER ).fill(
					posMsg( { type: TM_BYTESTREAM, value: `msg-${ i }` } )
				);
			}
		} );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		expect( items.length ).toBe( 200 );
		expect( items[ 0 ].textContent ).toBe( 'msg-50' );
		expect( items[ 199 ].textContent ).toBe( 'msg-249' );
	} );

	it( 'URL state: ?topology=demo is read on mount', async () => {
		window.history.replaceState( {}, '', '/?topology=demo&partition=0' );
		const { getByTestId } = render( <TopologyConsole /> );
		expect( getByTestId( 'header' ).dataset.mode ).toBe( 'view' );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'URL state: invalid ?topology fallback to first entry', () => {
		window.history.replaceState( {}, '', '/?topology=nonexistent' );
		const { getByTestId } = render( <TopologyConsole /> );
		expect( getByTestId( 'header' ) ).not.toBeNull();
	} );

	it( 'URL state: invalid ?partition coerces to 0', () => {
		window.history.replaceState( {}, '', '/?partition=NaN' );
		const { getByTestId } = render( <TopologyConsole /> );
		expect( getByTestId( 'header' ) ).not.toBeNull();
	} );

	it( 'selecting a node opens the inspector', async () => {
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		await publishMeta();
		expect( queryByTestId( 'inspector' ) ).toBeNull();
		fireEvent.click( getByText( 'select-n1' ) );
		expect( queryByTestId( 'inspector' ).dataset.selectedId ).toBe( 'n1' );
	} );

	it( 'a canvas background click deselects the node (inspector stays open, empty)', async () => {
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		await publishMeta();
		fireEvent.click( getByText( 'select-n1' ) );
		expect( queryByTestId( 'inspector' ).dataset.selectedId ).toBe( 'n1' );
		fireEvent.click( getByText( 'deselect' ) );
		expect( queryByTestId( 'inspector' ).dataset.selectedId ).toBe( '' );
	} );

	it( 'the inspector column is always reserved (rail or panel)', async () => {
		const { getByText, container } = render( <TopologyConsole /> );
		await publishMeta();
		const cls = () => container.querySelector( '.topology-app' ).className;
		expect( cls() ).toContain( 'is-inspector-open' );
		fireEvent.click( getByText( 'select-n1' ) );
		expect( cls() ).toContain( 'is-inspector-open' );
	} );

	it( 'select edge clears any selected node', async () => {
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		await publishMeta();
		fireEvent.click( getByText( 'select-n1' ) );
		expect( queryByTestId( 'inspector' ).dataset.selectedId ).toBe( 'n1' );
		fireEvent.click( getByText( 'select-edge' ) );
		expect( queryByTestId( 'inspector' ).dataset.selectedId ).toBe( '' );
	} );

	it( 'Inspector dump action emits a sent transcript entry', async () => {
		const { container, getByText } = render( <TopologyConsole /> );
		await publishMeta();
		fireEvent.click( getByText( 'select-n1' ) );
		fireEvent.click( getByText( 'action-dump' ) );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const sent = Array.from( items ).find(
			( i ) => i.dataset.kind === 'sent'
		);
		expect( sent ).not.toBeUndefined();
		expect( sent.textContent ).toMatch( /dump_node n1/ );
	} );

	it( 'Inspector tail action posts connect_node command', async () => {
		const { container, getByText } = render( <TopologyConsole /> );
		await publishMeta();
		fireEvent.click( getByText( 'select-n1' ) );
		fireEvent.click( getByText( 'action-tail' ) );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const sent = Array.from( items ).find(
			( i ) => i.dataset.kind === 'sent'
		);
		expect( sent.textContent ).toMatch( /connect_node n1/ );
	} );

	it( 'Inspector send action emits send_node with payload', async () => {
		const { container, getByText } = render( <TopologyConsole /> );
		await publishMeta();
		fireEvent.click( getByText( 'select-n1' ) );
		fireEvent.click( getByText( 'action-send' ) );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const sent = Array.from( items ).find(
			( i ) => i.dataset.kind === 'sent'
		);
		expect( sent.textContent ).toMatch( /send_node n1 payload/ );
	} );

	it( 'Inspector trace action emits debug_state with level', async () => {
		const { container, getByText } = render( <TopologyConsole /> );
		await publishMeta();
		fireEvent.click( getByText( 'select-n1' ) );
		fireEvent.click( getByText( 'action-trace' ) );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const sent = Array.from( items ).find(
			( i ) => i.dataset.kind === 'sent'
		);
		expect( sent.textContent ).toMatch( /debug_state n1 1/ );
	} );

	it( 'Inspector request action emits request_node with verb', async () => {
		const { container, getByText } = render( <TopologyConsole /> );
		await publishMeta();
		fireEvent.click( getByText( 'select-n1' ) );
		fireEvent.click( getByText( 'action-request' ) );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const sent = Array.from( items ).find(
			( i ) => i.dataset.kind === 'sent'
		);
		expect( sent.textContent ).toMatch( /request_node n1 GET_LAG/ );
	} );

	it( 'Inspector command invoke on an INTERPRETER node targets the bare node (no :config)', async () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		globalThis.__catalog = {
			classes: [ { shell_name: 'Performance_CI', is_interpreter: true } ],
			formatters: [],
		};
		const { container, getByText } = render( <TopologyConsole /> );
		// Seed the live graph so n1's class resolves to the interpreter class.
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: { n1: { class: 'Performance_CI', counter: 1 } },
		} );
		// Capture the routed command so we can assert its TO.
		const captured = [];
		globalThis.__shell.sink = { fill: ( m ) => captured.push( m ) };

		fireEvent.click( getByText( 'select-n1' ) );
		fireEvent.click( getByText( 'action-command' ) );

		// Echo: bare node, NO :config.
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const sent = Array.from( items ).find(
			( i ) => i.dataset.kind === 'sent'
		);
		expect( sent.textContent ).toBe( 'command_node n1 set_is_hub' );
		// TO routes to the bare node (prefix(cwd, 'n1')), not n1:config.
		expect( captured ).toHaveLength( 1 );
		expect( captured[ 0 ][ TO ] ).toBe( 'demo.p0/n1' );
	} );

	it( 'Inspector command invoke on a NON-interpreter node targets <name>:config', async () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		globalThis.__catalog = {
			classes: [ { shell_name: 'Partition', is_interpreter: false } ],
			formatters: [],
		};
		const { container, getByText } = render( <TopologyConsole /> );
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: { n1: { class: 'Partition', counter: 1 } },
		} );
		const captured = [];
		globalThis.__shell.sink = { fill: ( m ) => captured.push( m ) };

		fireEvent.click( getByText( 'select-n1' ) );
		fireEvent.click( getByText( 'action-command' ) );

		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const sent = Array.from( items ).find(
			( i ) => i.dataset.kind === 'sent'
		);
		expect( sent.textContent ).toBe( 'command_node n1:config set_is_hub' );
		expect( captured ).toHaveLength( 1 );
		expect( captured[ 0 ][ TO ] ).toBe( 'demo.p0/n1:config' );
	} );

	it( 'Inspector disconnect action emits disconnect_node', async () => {
		const { container, getByText } = render( <TopologyConsole /> );
		await publishMeta();
		fireEvent.click( getByText( 'select-n1' ) );
		fireEvent.click( getByText( 'action-disconnect' ) );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const sent = Array.from( items ).find(
			( i ) => i.dataset.kind === 'sent'
		);
		expect( sent.textContent ).toMatch( /disconnect_node n1/ );
	} );

	// useCanvasLayout stores the whole layout under one key per scope shaped
	// `{ positions, viewport, modified }`. The `modified` boolean is the single
	// signal "user touched this" (drag/drop/tuck).
	it( 'position change persists into the single layout entry, flipping modified', async () => {
		const { getByText } = render( <TopologyConsole /> );
		await publishMeta();
		fireEvent.click( getByText( 'move-n1' ) );
		const keys = Object.keys( window.localStorage ).filter( ( k ) =>
			k.startsWith( 'newspack-nodes:topology:' )
		);
		expect( keys.length ).toBeGreaterThan( 0 );
		const stored = JSON.parse(
			window.localStorage.getItem( keys[ 0 ] ) || '{}'
		);
		expect( stored.positions.n1 ).toEqual( { x: 100, y: 200 } );
		expect( stored.modified ).toBe( true );
	} );

	it( 'viewport change debounces into the single layout entry without flipping modified', async () => {
		const { getByText } = render( <TopologyConsole /> );
		await publishMeta();
		jest.useFakeTimers();
		try {
			fireEvent.click( getByText( 'vp-change' ) );
			act( () => {
				jest.advanceTimersByTime( 250 );
			} );
			const keys = Object.keys( window.localStorage ).filter( ( k ) =>
				k.startsWith( 'newspack-nodes:topology:' )
			);
			expect( keys.length ).toBeGreaterThan( 0 );
			const stored = JSON.parse(
				window.localStorage.getItem( keys[ 0 ] ) || '{}'
			);
			expect( stored.viewport ).toEqual( {
				x: 10,
				y: 20,
				w: 800,
				h: 600,
			} );
			// Pan/zoom is not a layout modification — modified stays false.
			expect( stored.modified ).toBe( false );
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'header new resets draft + selection state', async () => {
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		await publishMeta();
		fireEvent.click( getByText( 'select-n1' ) );
		expect( queryByTestId( 'inspector' ) ).not.toBeNull();
		fireEvent.click( getByText( 'new' ) );
		expect( queryByTestId( 'inspector' ).dataset.selectedId ).toBe( '' );
	} );

	it( 'header save in view mode is a no-op (still mounted)', () => {
		const { getByText, getByTestId } = render( <TopologyConsole /> );
		fireEvent.click( getByText( 'save' ) );
		expect( getByTestId( 'header' ) ).not.toBeNull();
	} );

	it( 'header open opens the OpenTopologyModal', () => {
		const { getByText, getByTestId } = render( <TopologyConsole /> );
		fireEvent.click( getByText( 'open' ) );
		expect( getByTestId( 'header' ) ).not.toBeNull();
	} );

	it( 'Header receives pathOptions built from topologies + partitions', async () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		// demo has 2 partitions → '', '_http', 'demo.p0', 'demo.p1'.
		expect( lastHeaderProps.pathOptions ).toEqual( [
			'',
			'_http',
			'demo.p0',
			'demo.p1',
		] );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'pathOptions lists only ACTIVE topologies (excludes inactive ones)', async () => {
		const prev = window.NewspackNodesData;
		window.NewspackNodesData = {
			...prev,
			topologyWorkers: { demo: 2, idle: 1 },
			activeTopologies: [ 'demo' ],
		};
		try {
			window.history.replaceState( {}, '', '/?topology=demo' );
			render( <TopologyConsole /> );
			expect( lastHeaderProps.pathOptions ).toEqual( [
				'',
				'_http',
				'demo.p0',
				'demo.p1',
			] );
			expect( lastHeaderProps.pathOptions ).not.toContain( 'idle.p0' );
		} finally {
			window.NewspackNodesData = prev;
		}
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'pathOptions derives from the live catalog hook, not the static global', async () => {
		// The page-load global still says only `demo`, but the live catalog has
		// since gained an active `extra` topology. The menu must reflect the live
		// catalog (the bug: it stayed frozen on the global until a page reload).
		hooks.catalog = {
			partitions: { demo: 1, extra: 2 },
			active: [ 'demo', 'extra' ],
		};
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		expect( lastHeaderProps.pathOptions ).toEqual( [
			'',
			'_http',
			'demo.p0',
			'extra.p0',
			'extra.p1',
		] );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'saving a topology refreshes the live catalog', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( { tsl: '', name: 'demo' } );
		hooks.saveTopology.mockResolvedValueOnce( {
			name: 'demo',
			restarted_fleets: [],
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'save' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'prompt-ok' ) );
		} );
		expect( hooks.reloadCatalog ).toHaveBeenCalled();
	} );

	it( 'deleting a topology refreshes the live catalog', async () => {
		hooks.topologies = [ { name: 'demo', source: 'user' } ];
		hooks.fetchTopology.mockResolvedValueOnce( { tsl: '', name: 'demo' } );
		hooks.deleteTopology.mockResolvedValueOnce( { stock_fallback: false } );
		try {
			window.history.replaceState( {}, '', '/?topology=demo' );
			const { getByText } = render( <TopologyConsole /> );
			await act( async () => {
				fireEvent.click( getByText( 'edit' ) );
			} );
			await act( async () => {
				fireEvent.click( getByText( 'delete' ) );
			} );
			await act( async () => {
				fireEvent.click( getByText( 'confirm' ) );
			} );
			expect( hooks.reloadCatalog ).toHaveBeenCalled();
		} finally {
			hooks.topologies = [];
		}
	} );

	it( 'Header onPathChange to a different worker re-keys the graph (URL follows)', async () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastHeaderProps.onPathChange( 'demo.p1' );
		} );
		expect( window.location.search ).toMatch( /partition=1/ );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'Header onPathChange to a root path just moves the cwd (no partition URL)', async () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastHeaderProps.onPathChange( '_http' );
		} );
		expect( lastHeaderProps.path ).toBe( '_http' );
		expect( window.location.search ).not.toMatch( /partition=/ );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'REPL cd to a different worker re-keys the graph like the menu', async () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /demo.p1' );
		} );
		expect( window.location.search ).toMatch( /partition=1/ );
		expect( lastHeaderProps.path ).toBe( 'demo.p1' );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'REPL cd into a sub-node of the CURRENT worker is free navigation (no re-key)', async () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /demo.p0/firehose-in' );
		} );
		// cwd follows the deep path; same worker → no rebuild, no partition URL.
		expect( lastHeaderProps.path ).toBe( 'demo.p0/firehose-in' );
		expect( window.location.search ).not.toMatch( /partition=/ );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'REPL cd into a sub-node of a DIFFERENT worker mounts that worker (largest prefix)', async () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /demo.p1/firehose-in' );
		} );
		// Longest menu prefix is demo.p1 → mount p1.
		expect( window.location.search ).toMatch( /partition=1/ );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'REPL cd to a non-menu path is free navigation, not clobbered to root', async () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /_http/demo.p0' );
		} );
		expect( lastHeaderProps.path ).toBe( '_http/demo.p0' );
		expect( window.location.search ).not.toMatch( /partition=/ );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'cd into a worker sub-node sets _cwd.target to the cwd verbatim', async () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /demo.p0/firehose-in' );
		} );
		// The poll nodes target `_cwd`; the cwd is re-stamped from `_cwd.target`.
		expect( Core.node( names.CWD ).target ).toBe( 'demo.p0/firehose-in' );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'a worker cwd during the connecting window keeps _cwd pointed at the worker (not local)', async () => {
		// Previously the guard pointed _cwd at '' (the local interpreter) during the
		// connecting window, which made the canvas DISPLAY the local graph at
		// a worker cwd — misleading. Now _cwd tracks the cwd verbatim; the
		// POST will fail to round-trip without a pid but is cheap and silent,
		// and the canvas just holds its last state until the stream connects.
		globalThis.__connecting = true;
		try {
			window.history.replaceState( {}, '', '/?topology=demo' );
			render( <TopologyConsole /> );
			act( () => {
				lastReplProps.onSubmit( 'cd /demo.p0' );
			} );
			expect( Core.node( names.CWD ).target ).toBe( 'demo.p0' );
		} finally {
			globalThis.__connecting = false;
		}
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'a non-worker root (cd /_http) sets _cwd.target to that path verbatim', async () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /_http' );
		} );
		expect( Core.node( names.CWD ).target ).toBe( '_http' );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'local graph (cd /) sets _cwd.target to the empty local-root path', async () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		expect( Core.node( names.CWD ).target ).toBe( '' );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'cd onto a worker sets _cwd.target to that worker', async () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /demo.p1' );
		} );
		expect( Core.node( names.CWD ).target ).toBe( 'demo.p1' );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'REPL cd echoes into the transcript like other builtins', async () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /_http' );
		} );
		const sent = ( lastReplProps.transcript || [] ).filter(
			( t ) => t.kind === 'sent'
		);
		expect( sent.map( ( t ) => t.text ) ).toContain( 'cd /_http' );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'mounts the receive graph in view mode (Dumper registered as _output)', () => {
		render( <TopologyConsole /> );
		const { DumperNode } = require( '../../runtime/dumper-node' );
		expect( Core.node( names.OUTPUT ) ).toBeInstanceOf( DumperNode );
	} );

	it( 'edit mode: entering shows the Palette', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: '',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		expect( queryByTestId( 'palette' ) ).not.toBeNull();
	} );

	it( 'edit mode: handleConnect adds an edge via canvas wiring', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo a\nmake_node Echo b\nconnect_node a c\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'connect-a-b' ) );
		} );
		expect( lastCanvasProps ).not.toBeNull();
	} );

	it( 'live canvas: connect gesture dispatches connect_node via sendLine', async () => {
		const { container, getByText } = render( <TopologyConsole /> );
		await publishMeta();
		fireEvent.click( getByText( 'connect-a-b' ) );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const sent = Array.from( items ).find(
			( i ) => i.dataset.kind === 'sent'
		);
		expect( sent ).not.toBeUndefined();
		expect( sent.textContent ).toMatch( /^connect_node a b$/ );
	} );

	it( 'live canvas: palette drop opens NewNodeModal; clicking Add dispatches make_node', async () => {
		const { container, getByText } = render( <TopologyConsole /> );
		await publishMeta();
		fireEvent.click( getByText( 'drop-echo' ) );
		// Pre-confirm: no make_node yet — the NewNodeModal renders first so
		// the user can override the auto-generated name.
		const before = Array.from(
			container.querySelectorAll( '[data-testid="repl-transcript"] li' )
		).find( ( i ) => i.dataset.kind === 'sent' );
		expect( before ).toBeUndefined();
		// Confirm: clicking Add dispatches make_node via sendLine.
		fireEvent.click( getByText( 'Add' ) );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const sent = Array.from( items ).find(
			( i ) => i.dataset.kind === 'sent'
		);
		expect( sent ).not.toBeUndefined();
		expect( sent.textContent ).toMatch( /^make_node Echo \S+$/ );
	} );

	it( 'live canvas: delete selected node dispatches remove_node via sendLine', async () => {
		const { container, getByText } = render( <TopologyConsole /> );
		await publishMeta();
		fireEvent.click( getByText( 'select-n1' ) );
		fireEvent.click( getByText( 'remove-n1' ) );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const sent = Array.from( items ).find(
			( i ) => i.dataset.kind === 'sent'
		);
		expect( sent ).not.toBeUndefined();
		expect( sent.textContent ).toMatch( /^remove_node n1$/ );
	} );

	it( 'live canvas: SchematicCanvas receives interactive=true in view mode', () => {
		render( <TopologyConsole /> );
		expect( lastCanvasProps.interactive ).toBe( true );
	} );

	it( 'live canvas: reset-graph control re-mounts the graph without throwing', async () => {
		const { findByText } = render( <TopologyConsole /> );
		// The console boots viewing a worker; cd to the local graph (the only
		// scope where the reset chip shows) before exercising it.
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		// Chip only shows when there's a user-added node beyond the canonical
		// console graph — inject one via the METADATA payload.
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: {
				n1: { class: 'Echo', counter: 0, sink: '', target: '' },
			},
		} );
		// findByText polls (up to 1s) so the gate (metadata + cwd) has time
		// to settle under parallel-coverage CPU pressure.
		const chip = await findByText( 'reset-graph' );
		expect( () => fireEvent.click( chip ) ).not.toThrow();
	} );

	it( 'reset-graph preserves cwd (rebuild rehomes Shell.path to default; reset must restore the user cwd)', async () => {
		// Boot into a worker, navigate to '/' (local), then reset-graph.
		// Previously the rebuild snapped Shell.path back to {reader} and
		// the [shell] sync effect dragged cwd along, taking the user off '/'.
		// Reset must rebuild AND keep cwd at '/'.
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { findByText } = render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		expect( lastHeaderProps.path ).toBe( '' );
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: {
				n1: { class: 'Echo', counter: 0, sink: '', target: '' },
			},
		} );
		const chip = await findByText( 'reset-graph' );
		act( () => {
			fireEvent.click( chip );
		} );
		expect( lastHeaderProps.path ).toBe( '' );
	} );

	it( 'reset-graph wipes user-added nodes (and leaves the canonical spine + console graph)', async () => {
		// User-`make_node`'d local nodes survived the canonical-only unregister
		// loop, so the "reset" didn't feel like a reset. Now any node not in
		// the canonical console-graph set (or the backbone) is removed.
		const { Node } = require( '../../runtime/node' );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { findByText } = render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		// Simulate user `make_node Tee my-tee` having survived from a prior session.
		const userNode = new Node();
		userNode.name = 'my-user-tee';
		expect( Core.node( 'my-user-tee' ) ).toBeTruthy();
		// Surface it in the metadata payload so the chip is visible (the chip
		// gating reads parsed.nodes, not Core directly).
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: {
				'my-user-tee': {
					class: 'Node',
					counter: 0,
					sink: '',
					target: '',
				},
			},
		} );
		// Reset must remove it.
		const chip = await findByText( 'reset-graph' );
		act( () => {
			fireEvent.click( chip );
		} );
		expect( Core.node( 'my-user-tee' ) ).toBeFalsy();
		// And the canonical backbone must STILL be present after the rebuild.
		expect( Core.node( '_command_interpreter' ) ).toBeTruthy();
		expect( Core.node( '_router' ) ).toBeTruthy();
	} );

	it( 'reset-graph surfaces Reset Layout (a full rebuild offers a fresh auto-fit)', async () => {
		// A graph rewire alone does not dirty the LAYOUT, but Reset Graph (a full
		// teardown + rebuild) marks it dirty so Reset Layout surfaces — the rebuilt
		// graph can be re-auto-fit. Matches the debug overlay.
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { findByText, queryByText } = render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		// A user node surfaces the reset-graph chip; no layout edits yet → no
		// reset-layout chip.
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: {
				n1: { class: 'Echo', counter: 0, sink: '', target: '' },
			},
		} );
		expect( queryByText( 'reset-layout' ) ).toBeNull();
		const chip = await findByText( 'reset-graph' );
		act( () => {
			fireEvent.click( chip );
		} );
		// The rebuilt graph re-polls metadata (the canvas re-renders over it).
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: {
				n1: { class: 'Echo', counter: 0, sink: '', target: '' },
			},
		} );
		// Reset Graph marked the layout dirty — Reset Layout now appears.
		expect( queryByText( 'reset-layout' ) ).not.toBeNull();
	} );

	it( 'live drag-rewire surfaces the Reset Graph chip with no user node (bug 1)', async () => {
		// Bug 1: dragging a connection between endpoints on the live canvas issues a
		// connect_node, which the Shell dispatch tap sees → structureDirty → chip.
		// Previously the gate was node-only (hasUserAddedLocalNodes), so a pure
		// rewire produced no chip.
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { findByText, queryByText, getByText } = render(
			<TopologyConsole />
		);
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		// Publish a reserved-only graph so the canvas is ready (layoutReady) WITHOUT
		// surfacing reset-graph — `_output` is a substrate node, not a user node.
		await publishMeta( {
			[ names.OUTPUT ]: {
				class: 'Dumper',
				counter: 0,
				sink: '',
				target: '',
			},
		} );
		expect( queryByText( 'reset-graph' ) ).toBeNull();
		// Drag-rewire on the live canvas (no node added).
		act( () => {
			fireEvent.click( getByText( 'connect-a-b' ) );
		} );
		expect( await findByText( 'reset-graph' ) ).not.toBeNull();
	} );

	it( 'the palette shows JS classes at the local scope (NOT the PHP catalog)', async () => {
		// At cwd '/', make_node runs against the browser's Core, so the palette
		// must list the JS-side CommandInterpreter.includeNodes (Tee, Timer,
		// Node, CommandInterpreter). The PHP `classes.list` catalog (which the
		// console fetches via useClassCatalog) is for workers/topology-editing.
		globalThis.__catalog = {
			classes: [ { shell_name: 'PHP_Only_Class', category: 'PHP' } ],
			formatters: [],
		};
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		const paletteNames = ( lastPaletteProps?.classes || [] ).map(
			( c ) => c.shell_name
		);
		expect( paletteNames ).toEqual(
			expect.arrayContaining( [ 'Tee', 'Timer' ] )
		);
		expect( paletteNames ).not.toContain( 'PHP_Only_Class' );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'the palette shows the PHP catalog when at a worker (or editing a topology)', async () => {
		// At a worker cwd, make_node runs against the PHP worker via SSE, so
		// the PHP catalog is what's accurate. Edit mode is the same — the
		// topology file is a PHP-worker configuration.
		globalThis.__catalog = {
			classes: [ { shell_name: 'PHP_Only_Class', category: 'PHP' } ],
			formatters: [],
		};
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		// Default boot is /demo.p0 (a worker); the palette (in GraphView)
		// renders once the layout graph is ready.
		await publishMeta();
		const paletteNames = ( lastPaletteProps?.classes || [] ).map(
			( c ) => c.shell_name
		);
		expect( paletteNames ).toContain( 'PHP_Only_Class' );
	} );

	it( 'reset-graph control shows only on the local graph with user-added nodes', async () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { queryByText, findByText } = render( <TopologyConsole /> );
		// Boots into a worker view (demo.p0); a worker graph self-heals on
		// respawn, so resetting the local console graph is meaningless → no chip.
		expect( queryByText( 'reset-graph' ) ).toBeNull();
		// cd to the local browser graph; without user-added nodes the chip is
		// also hidden (nothing to reset — only the canonical console graph).
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		expect( queryByText( 'reset-graph' ) ).toBeNull();
		// Add a user node via the metadata payload → chip appears. Use
		// findByText so the metadata->parsed.nodes propagation has time to
		// settle under parallel-coverage CPU pressure.
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: {
				n1: { class: 'Echo', counter: 0, sink: '', target: '' },
			},
		} );
		expect( await findByText( 'reset-graph' ) ).not.toBeNull();
		// The _http broadcast boundary is also a pivoted (worker) view, not the
		// local graph — even though scopeFromCwd buckets it as 'local' — so the
		// chip stays hidden there too.
		act( () => {
			lastReplProps.onSubmit( 'cd /_http/demo.p0' );
		} );
		expect( queryByText( 'reset-graph' ) ).toBeNull();
	} );

	it( 'edit mode: dropNode adds a node + persists its position', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: '',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'drop-echo' ) );
		} );
		const keys = Object.keys( window.localStorage ).filter( ( k ) =>
			k.startsWith( 'newspack-nodes:topology:' )
		);
		expect( keys.length ).toBeGreaterThan( 0 );
		const stored = JSON.parse(
			window.localStorage.getItem( keys[ 0 ] ) || '{}'
		);
		// Position is persisted under the new single-key layout entry.
		expect( Object.keys( stored.positions || {} ).length ).toBeGreaterThan(
			0
		);
	} );

	it( 'edit mode: header Save opens the prompt modal (gated by mode)', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: '',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'save' ) );
		} );
		expect( lastHeaderProps.mode ).toBe( 'edit' );
	} );

	it( 'edit mode: rename node updates the draft + position key', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo n1\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'select-n1' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'rename-n1' ) );
		} );
		expect( lastInspectorProps.selectedId ).toBe( 'renamed' );
	} );

	it( 'edit mode: remove node from inspector', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo n1\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'select-n1' ) );
		} );
		expect( queryByTestId( 'inspector' ) ).not.toBeNull();
		await act( async () => {
			fireEvent.click( getByText( 'remove-n1' ) );
		} );
		expect( queryByTestId( 'inspector' ).dataset.selectedId ).toBe( '' );
	} );

	it( 'edit mode: removing the selected edge clears selectedEdge', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo n1\nmake_node Echo n2\nconnect_node n1 n2\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'select-edge' ) );
		} );
		expect( lastCanvasProps.selectedEdge ).toEqual( {
			from: 'n1',
			to: 'n2',
		} );
	} );

	it( 'edit mode: updateArgs + updateVerbs handlers run without throw', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo n1\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'select-n1' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'update-args' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'update-verbs' ) );
		} );
		expect( lastInspectorProps.selectedId ).toBe( 'n1' );
	} );

	it( 'handleSaveLayout writes positions to layout endpoint', async () => {
		hooks.saveLayout.mockResolvedValueOnce( {
			name: 'demo',
			positions: { n1: [ 100, 200 ] },
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await publishMeta();
		await act( async () => {
			fireEvent.click( getByText( 'move-n1' ) );
		} );
		expect( typeof hooks.saveLayout ).toBe( 'function' );
	} );

	it( 'canvas background click does not dismiss the transcript (no consumed handler)', () => {
		render( <TopologyConsole /> );
		// The repl-dismiss-on-canvas-click was removed; the canvas only deselects
		// or autofits (it never touches the transcript).
		expect( lastCanvasProps.onBackgroundClickConsumed ).toBeUndefined();
		expect( lastCanvasProps.backgroundClickAutofitsOnly ).toBeUndefined();
	} );

	it( 'toast clears after 5 seconds', () => {
		jest.useFakeTimers();
		try {
			const { container, getByText } = render( <TopologyConsole /> );
			fireEvent.click( getByText( 'save' ) );
			act( () => {
				jest.advanceTimersByTime( 5000 );
			} );
			expect( container.querySelector( '.topology-toast' ) ).toBeNull();
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'reply TO=_metadata with parsed nodes seeds rate tracking', async () => {
		render( <TopologyConsole /> );
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: {
				n1: {
					counter: 10,
					class: 'Echo',
					bytes_read: 100,
					bytes_written: 50,
				},
			},
		} );
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: {
				n1: {
					counter: 20,
					class: 'Echo',
					bytes_read: 200,
					bytes_written: 100,
				},
			},
		} );
		expect( lastCanvasProps ).not.toBeNull();
		expect( lastCanvasProps.rateRef.current.size ).toBeGreaterThanOrEqual(
			1
		);
	} );

	it( 'reply TO=_metadata: counter reset across worker respawn clamps to 0', async () => {
		render( <TopologyConsole /> );
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: { n1: { counter: 100, class: 'Echo' } },
		} );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 1100 ) );
		} );
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: { n1: { counter: 5, class: 'Echo' } },
		} );
		const entry = lastCanvasProps.rateRef.current.get( 'n1' );
		expect( entry ).not.toBeUndefined();
		expect( entry.rate ).toBeGreaterThanOrEqual( 0 );
	}, 5000 );

	it( 'topology with multiple partitions: switching partition clamps when invalid', async () => {
		window.NewspackNodesData.topologyWorkers = { demo: 1 };
		window.history.replaceState( {}, '', '/?topology=demo&partition=3' );
		const { getByTestId } = render( <TopologyConsole /> );
		expect( getByTestId( 'header' ) ).not.toBeNull();
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'debug_level 2 path: header injection still renders the arrival', async () => {
		const { container, getByText } = render( <TopologyConsole /> );
		fireEvent.click( getByText( 'submit-multi' ) );
		await fireMsg( { type: TM_BYTESTREAM, value: 'hi' } );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		expect( items.length ).toBeGreaterThan( 0 );
	} );

	it( 'edit mode: Delete key removes the selected node', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo n1\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'select-n1' ) );
		} );
		expect( queryByTestId( 'inspector' ) ).not.toBeNull();
		await act( async () => {
			fireEvent.keyDown( document, { key: 'Delete' } );
		} );
		expect( queryByTestId( 'inspector' ).dataset.selectedId ).toBe( '' );
	} );

	it( 'edit mode: keyboard handler ignored when focus is in an input', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo n1\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'select-n1' ) );
		} );
		const input = document.createElement( 'input' );
		document.body.appendChild( input );
		await act( async () => {
			fireEvent.keyDown( input, { key: 'Delete' } );
		} );
		expect( queryByTestId( 'inspector' ) ).not.toBeNull();
		document.body.removeChild( input );
	} );

	it( 'edit mode: Backspace key removes the selected node', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo n1\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'select-n1' ) );
		} );
		await act( async () => {
			fireEvent.keyDown( document, { key: 'Backspace' } );
		} );
		expect( queryByTestId( 'inspector' ).dataset.selectedId ).toBe( '' );
	} );

	it( 'edit mode: Delete key removes the selected edge', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo n1\nmake_node Echo n2\nconnect_node n1 n2\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'select-edge' ) );
		} );
		await act( async () => {
			fireEvent.keyDown( document, { key: 'Delete' } );
		} );
		expect( lastCanvasProps.selectedEdge ).toBeNull();
	} );

	it( 'handleSaveConfirm calls saveTopology + toasts on success', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: '',
			name: 'demo',
		} );
		hooks.saveTopology.mockResolvedValueOnce( {
			name: 'demo',
			restarted_fleets: [],
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, getByTestId } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'save' ) );
		} );
		expect( getByTestId( 'header' ) ).not.toBeNull();
	} );

	it( 'saving a NEW topology prompts "Activate now?"; confirm dispatches activate', async () => {
		// Catalog knows only `demo`; the prompt mock saves as `newname` — a name
		// NOT in the prior known set, i.e. a freshly-created topology.
		hooks.catalog = { partitions: { demo: 2 }, active: [] };
		hooks.fetchTopology.mockResolvedValueOnce( { tsl: '', name: 'demo' } );
		hooks.saveTopology.mockResolvedValueOnce( {
			name: 'newname',
			restarted_fleets: [],
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'save' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'prompt-ok' ) );
		} );
		// The activate prompt is up (a ConfirmModal titled "Activate now?").
		expect( globalThis.__lastConfirmModal.title ).toMatch( /activate/i );
		await act( async () => {
			fireEvent.click( getByText( 'confirm' ) );
		} );
		expect( globalThis.__activateSend ).toHaveBeenCalledWith( {
			to: 'topologies',
			verb: 'activate',
			args: 'newname',
		} );
	} );

	it( 'dismissing the "Activate now?" prompt dispatches nothing', async () => {
		hooks.catalog = { partitions: { demo: 2 }, active: [] };
		hooks.fetchTopology.mockResolvedValueOnce( { tsl: '', name: 'demo' } );
		hooks.saveTopology.mockResolvedValueOnce( {
			name: 'newname',
			restarted_fleets: [],
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'save' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'prompt-ok' ) );
		} );
		expect( globalThis.__lastConfirmModal.title ).toMatch( /activate/i );
		await act( async () => {
			fireEvent.click( getByText( 'cancel-confirm' ) );
		} );
		expect( globalThis.__activateSend ).not.toHaveBeenCalled();
	} );

	it( 'saving an EXISTING topology shows no activate prompt', async () => {
		// Catalog already knows `newname` — saving over it is an edit, not new.
		hooks.catalog = { partitions: { newname: 1 }, active: [] };
		globalThis.__lastConfirmModal = null;
		hooks.fetchTopology.mockResolvedValueOnce( { tsl: '', name: 'demo' } );
		hooks.saveTopology.mockResolvedValueOnce( {
			name: 'newname',
			restarted_fleets: [],
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'save' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'prompt-ok' ) );
		} );
		expect( globalThis.__lastConfirmModal ).toBeNull();
		expect( globalThis.__activateSend ).not.toHaveBeenCalled();
	} );

	it( 'confirming "Activate now?" toasts the error (not success) when the verb returns TM_ERROR', async () => {
		// The activate verb rejects (e.g. a write-conflict with an already-active
		// topology): the substrate replies TM_COMMAND|TM_RESPONSE|TM_ERROR at HTTP
		// 200. send() resolves that Message regardless of TYPE — only
		// unwrapCommandResponse throws on TM_ERROR. confirmActivate must surface
		// the error toast and NOT falsely claim activation.
		globalThis.__activateSend.mockResolvedValueOnce(
			posMsg( {
				type: TM_COMMAND | TM_RESPONSE | TM_ERROR,
				value: {
					name: 'activate',
					payload: 'conflicts with active demo',
				},
			} )
		);
		hooks.catalog = { partitions: { demo: 2 }, active: [ 'demo' ] };
		hooks.fetchTopology.mockResolvedValueOnce( { tsl: '', name: 'demo' } );
		hooks.saveTopology.mockResolvedValueOnce( {
			name: 'newname',
			restarted_fleets: [],
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, container } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'save' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'prompt-ok' ) );
		} );
		expect( globalThis.__lastConfirmModal.title ).toMatch( /activate/i );
		await act( async () => {
			fireEvent.click( getByText( 'confirm' ) );
		} );
		const errorToast = container.querySelector( '.topology-toast--error' );
		expect( errorToast ).not.toBeNull();
		expect( errorToast.textContent ).toMatch(
			/conflicts with active demo/
		);
		expect(
			container.querySelector( '.topology-toast--success' )
		).toBeNull();
	} );

	it( 'edits num_partitions in the settings panel and serializes it on save', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo e\n',
			name: 'demo',
			source: 'user',
		} );
		hooks.saveTopology.mockResolvedValueOnce( {
			name: 'demo',
			restarted_fleets: [],
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, getByLabelText, getByRole } = render(
			<TopologyConsole />
		);
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		// SETTINGS opens the panel only in edit mode.
		await act( async () => {
			fireEvent.click( getByText( 'settings' ) );
		} );
		expect(
			getByRole( 'dialog', { name: /topology settings/i } )
		).not.toBeNull();
		await act( async () => {
			fireEvent.change( getByLabelText( /partitions/i ), {
				target: { value: '4' },
			} );
		} );
		// Save: name prompt → confirm.
		await act( async () => {
			fireEvent.click( getByText( 'save' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'prompt-ok' ) );
		} );
		const tslArg =
			hooks.saveTopology.mock.calls[ 0 ] &&
			hooks.saveTopology.mock.calls[ 0 ][ 0 ].tsl;
		expect( tslArg ).toContain( 'var num_partitions = 4' );
	} );

	it( 'edit mode: renaming a node preserves the num_partitions frontmatter on save', async () => {
		// Regression: the rename handler rebuilt the draft as { nodes, edges } and
		// dropped frontmatter, so a rename silently unset the partitions setting —
		// a node DROP didn't, because removeNode spreads the whole graph.
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'var num_partitions = 4\nmake_node Echo n1\n',
			name: 'demo',
			source: 'user',
		} );
		hooks.saveTopology.mockResolvedValueOnce( {
			name: 'demo',
			restarted_fleets: [],
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'select-n1' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'rename-n1' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'save' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'prompt-ok' ) );
		} );
		const tslArg =
			hooks.saveTopology.mock.calls[ 0 ] &&
			hooks.saveTopology.mock.calls[ 0 ][ 0 ].tsl;
		expect( tslArg ).toContain( 'var num_partitions = 4' );
	} );

	it( 'closes the settings panel when starting a New topology', async () => {
		const { getByText, getByRole, queryByRole } = render(
			<TopologyConsole />
		);
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'settings' ) );
		} );
		expect(
			getByRole( 'dialog', { name: /topology settings/i } )
		).not.toBeNull();
		// New resets the draft — the panel must close so it reseeds on reopen.
		await act( async () => {
			fireEvent.click( getByText( 'new' ) );
		} );
		expect(
			queryByRole( 'dialog', { name: /topology settings/i } )
		).toBeNull();
	} );

	it( 'handleOpenPick fetches the picked topology + replaces draft', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: '',
			name: 'demo',
		} );
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo loaded\n',
			name: 'another',
			source: 'user',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'open' ) );
		} );
		expect( hooks.fetchTopology ).toHaveBeenCalled();
	} );

	it( 'canEdit is true when the cwd names a worker', async () => {
		// Default mount lands cwd at {reader} (a worker).
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		expect( lastHeaderProps.canEdit ).toBe( true );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'canEdit is false when the cwd is a root path', async () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastHeaderProps.onPathChange( '_http' );
		} );
		expect( lastHeaderProps.canEdit ).toBe( false );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'canDeleteCurrent: returns false when no user-saved topology', async () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		expect( lastHeaderProps.canDelete ).toBe( false );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'edit mode: canDeleteCurrent=true with a user-saved topology', async () => {
		hooks.topologies = [ { name: 'demo', source: 'user' } ];
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: '',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		expect( lastHeaderProps.mode ).toBe( 'edit' );
		hooks.topologies = [];
	} );

	it( 'debug_level 1: number value stringifies', async () => {
		const { getByText, container } = render( <TopologyConsole /> );
		fireEvent.click( getByText( 'submit-multi' ) );
		await fireMsg( { type: TM_BYTESTREAM, value: 42 } );
		expect( container.textContent ).toMatch( /TM_BYTESTREAM from worker/ );
	} );

	it( 'debug_level 1: null/undefined value renders empty', async () => {
		const { getByText, container } = render( <TopologyConsole /> );
		fireEvent.click( getByText( 'submit-multi' ) );
		await fireMsg( { type: TM_BYTESTREAM, value: null } );
		expect( container.textContent ).toMatch( /TM_BYTESTREAM from worker/ );
	} );

	it( 'debug_level 1: object value gets JSON-stringified in header', async () => {
		const { getByText, container } = render( <TopologyConsole /> );
		fireEvent.click( getByText( 'submit-multi' ) );
		await fireMsg( { type: TM_STRUCT, value: { hello: 'world' } } );
		expect( container.textContent ).toMatch( /TM_STRUCT from worker/ );
	} );

	it( 'handleResetLayout in live mode applies the saved layout', async () => {
		hooks.fetchLayout.mockResolvedValueOnce( {
			positions: { n1: [ 100, 200 ] },
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 0 ) );
		} );
		await publishMeta();
		await act( async () => {
			fireEvent.click( getByText( 'move-n1' ) );
		} );
		expect( hooks.fetchLayout ).toHaveBeenCalled();
	} );

	it( 'debug_level 1: object with circular reference falls back to String', async () => {
		const { getByText, container } = render( <TopologyConsole /> );
		fireEvent.click( getByText( 'submit-multi' ) );
		const circular = {};
		circular.self = circular;
		await fireMsg( { type: TM_BYTESTREAM, value: circular } );
		expect( container.textContent ).toMatch( /TM_BYTESTREAM from worker/ );
	} );

	it( 'positionOverrides falls back to empty object on parse error', async () => {
		window.localStorage.setItem(
			'newspack-nodes:topology:undefined.p0:positions',
			'this is not json'
		);
		const { getByTestId } = render( <TopologyConsole /> );
		await publishMeta();
		expect( getByTestId( 'canvas' ) ).not.toBeNull();
	} );

	it( 'viewport falls back to null on parse error', async () => {
		window.localStorage.setItem(
			'newspack-nodes:topology:undefined.p0:viewport',
			'malformed'
		);
		const { getByTestId } = render( <TopologyConsole /> );
		await publishMeta();
		expect( getByTestId( 'canvas' ) ).not.toBeNull();
	} );

	it( 'switching partition to higher than available clamps to 0', async () => {
		window.NewspackNodesData.topologyWorkers = { demo: 2 };
		window.history.replaceState( {}, '', '/?topology=demo&partition=5' );
		const { getByTestId } = render( <TopologyConsole /> );
		expect( getByTestId( 'header' ) ).not.toBeNull();
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'sendLine: a remote command echoes the sent text', async () => {
		const { container, getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'submit' ) );
		} );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const sent = Array.from( items ).find(
			( i ) => i.dataset.kind === 'sent'
		);
		expect( sent ).not.toBeUndefined();
		expect( sent.textContent ).toBe( 'ls' );
	} );

	it( 'sendLine: a typed command flows Shell → interpreter → Router → HttpOut (captured)', async () => {
		globalThis.__httpPosts = [];
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'submit' ) );
		} );
		// `ls` → default TM_COMMAND routed to the worker's RemoteIpc, which POSTs
		// the bare reader as TO.
		const posted = globalThis.__httpPosts.find(
			( m ) => m[ VALUE ] && m[ VALUE ].name === 'ls'
		);
		expect( posted ).not.toBeUndefined();
		expect( posted[ TO ] ).toBe( 'demo.p0' );
		// RemoteIpc wrapped the bare `_output` FROM into the private reply pivot.
		expect( posted[ FROM ] ).toBe(
			`${ names.SSE }:1234/${ names.OUTPUT }`
		);
	} );

	it( 'handleInspectorAction invoke (command) routes a TM_COMMAND to the {node}:config sibling interpreter', async () => {
		// Command verbs live on the node's `{name}:config` CommandInterpreter
		// sibling, not the bare node (a plain Node ignores TM_COMMAND). Both
		// the routed TO and the echoed transcript line must carry `:config`.
		globalThis.__httpPosts = [];
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { container, getByText } = render( <TopologyConsole /> );
		await publishMeta();
		await act( async () => {
			fireEvent.click( getByText( 'select-n1' ) );
		} );
		await act( async () => {
			lastInspectorProps.onAction( 'invoke', 'request-builder', {
				verb: 'GET_LAG',
				kind: 'command',
				positional: '',
				byName: {},
			} );
		} );
		const posted = globalThis.__httpPosts.find(
			( m ) => m[ VALUE ] && m[ VALUE ].name === 'GET_LAG'
		);
		expect( posted ).not.toBeUndefined();
		expect( posted[ TO ] ).toBe( 'demo.p0/request-builder:config' );
		const sent = Array.from(
			container.querySelectorAll( '[data-testid="repl-transcript"] li' )
		).find( ( i ) => i.dataset.kind === 'sent' );
		expect( sent.textContent ).toMatch(
			/command_node request-builder:config GET_LAG/
		);
	} );

	it( 'handleInspectorAction invoke (request) routes a TM_REQUEST string to the bare node (no :config)', async () => {
		// Requests are answered by the node itself, so they target the bare
		// nodeId — never the `:config` sibling.
		globalThis.__httpPosts = [];
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { container, getByText } = render( <TopologyConsole /> );
		await publishMeta();
		await act( async () => {
			fireEvent.click( getByText( 'select-n1' ) );
		} );
		await act( async () => {
			lastInspectorProps.onAction( 'invoke', 'request-builder', {
				verb: 'GET_LAG',
				kind: 'request',
				positional: '',
				byName: {},
			} );
		} );
		const posted = globalThis.__httpPosts.find(
			( m ) => m[ TYPE ] === TM_REQUEST && m[ VALUE ] === 'GET_LAG'
		);
		expect( posted ).not.toBeUndefined();
		expect( posted[ TO ] ).toBe( 'demo.p0/request-builder' );
		const sent = Array.from(
			container.querySelectorAll( '[data-testid="repl-transcript"] li' )
		).find( ( i ) => i.dataset.kind === 'sent' );
		expect( sent.textContent ).toMatch(
			/request_node request-builder GET_LAG/
		);
	} );

	it( 'handleSave: PromptModal mounts in edit mode; confirm triggers saveTopology', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: '',
			name: 'demo',
		} );
		hooks.saveTopology.mockResolvedValueOnce( {
			name: 'newname',
			restarted_fleets: [],
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'save' ) );
		} );
		expect( queryByTestId( 'prompt-modal' ) ).not.toBeNull();
		await act( async () => {
			fireEvent.click( getByText( 'prompt-ok' ) );
		} );
		expect( hooks.saveTopology ).toHaveBeenCalledWith(
			expect.objectContaining( { name: 'newname' } )
		);
	} );

	it( 'handleSave: prompt cancel closes modal without saving', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: '',
			name: 'demo',
		} );
		hooks.saveTopology.mockClear();
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'save' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'prompt-cancel' ) );
		} );
		expect( queryByTestId( 'prompt-modal' ) ).toBeNull();
		expect( hooks.saveTopology ).not.toHaveBeenCalled();
	} );

	it( 'handleSaveConfirm: save error toasts the error message', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: '',
			name: 'demo',
		} );
		hooks.saveTopology.mockRejectedValueOnce( {
			data: { message: 'bad name', line_number: 5 },
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { container, getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'save' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'prompt-ok' ) );
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		const toast = container.querySelector( '.topology-toast--error' );
		expect( toast ).not.toBeNull();
		expect( toast.textContent ).toMatch( /bad name/ );
		expect( toast.textContent ).toMatch( /line 5/ );
	} );

	it( 'handleOpenPick: clicking pick replaces draft + emits success toast', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: '',
			name: 'demo',
		} );
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo x\n',
			name: 'picked',
			source: 'user',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { container, getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'open' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'pick' ) );
		} );
		const toast = container.querySelector( '.topology-toast--success' );
		expect( toast ).not.toBeNull();
		expect( toast.textContent ).toMatch( /picked/ );
	} );

	it( 'handleOpenPick: open error toasts the error', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: '',
			name: 'demo',
		} );
		hooks.fetchTopology.mockRejectedValueOnce( {
			data: { message: 'forbidden' },
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { container, getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'open' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'pick' ) );
		} );
		const toast = container.querySelector( '.topology-toast--error' );
		expect( toast ).not.toBeNull();
		expect( toast.textContent ).toMatch( /forbidden/ );
	} );

	it( 'OpenTopologyModal cancel closes the modal', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: '',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'open' ) );
		} );
		expect( queryByTestId( 'open-modal' ) ).not.toBeNull();
		await act( async () => {
			fireEvent.click( getByText( 'cancel-open' ) );
		} );
		expect( queryByTestId( 'open-modal' ) ).toBeNull();
	} );

	it( 'edit mode reads positions from a per-topology key, NOT the cwd/worker scope key', async () => {
		// The fix for "unactivated topologies stomping each other": edit mode keys
		// the layout by the topology being edited (`edit:{name}`), independent of
		// the cwd. Pre-seed BOTH the worker scope (`demo.p0` — the mock Shell's
		// cwd) and the per-topology edit key with DIFFERENT positions; entering
		// edit on `demo` must rehydrate the edit key, proving it ignores the cwd
		// scope (otherwise two topologies edited from one cwd would collide).
		window.localStorage.setItem(
			'newspack-nodes:topology:demo.p0',
			JSON.stringify( {
				positions: { n1: { x: 700, y: 900 } },
				viewport: null,
				modified: true,
			} )
		);
		window.localStorage.setItem(
			'newspack-nodes:topology:edit:demo',
			JSON.stringify( {
				positions: { n1: { x: 111, y: 222 } },
				viewport: null,
				modified: true,
			} )
		);
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo n1\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		expect( lastCanvasProps.positionOverrides.n1 ).toEqual( {
			x: 111,
			y: 222,
		} );
	} );

	it( 'entering edit on a blank canvas anchors _repl as a Partition (reserved)', async () => {
		// `_repl` is the worker's auto-mounted substrate spine — not in any
		// topology .tsl, but the editor renders it on the canvas so users can
		// draw edges TO it. It's reserved (no rename/delete) and tagged as
		// Partition (the class the worker actually mounts at that name).
		window.history.replaceState( {}, '', '/' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		const repl = lastCanvasProps.parsed.nodes.find(
			( n ) => n.id === '_repl'
		);
		expect( repl ).toBeDefined();
		expect( repl.class ).toBe( 'Partition' );
		expect( repl.reserved ).toBe( true );
	} );

	it( 'entering edit on a loaded topology anchors _repl AND keeps the TSL-declared nodes', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo n1\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		const repl = lastCanvasProps.parsed.nodes.find(
			( n ) => n.id === '_repl'
		);
		expect( repl ).toBeDefined();
		expect( repl.class ).toBe( 'Partition' );
		expect(
			lastCanvasProps.parsed.nodes.find( ( n ) => n.id === 'n1' )
		).toBeDefined();
		// Leaving without edits must NOT prompt the discard modal — _repl is
		// in the baseline too, so its presence isn't a change.
		await act( async () => {
			fireEvent.click( getByText( 'view' ) );
		} );
		expect( queryByTestId( 'confirm-modal' ) ).toBeNull();
		expect( lastHeaderProps.mode ).toBe( 'view' );
	} );

	it( 'edit mode: dirty draft → leaving prompts ConfirmModal; discard exits to view', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo n1\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'drop-echo' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'view' ) );
		} );
		expect( queryByTestId( 'confirm-modal' ) ).not.toBeNull();
		await act( async () => {
			fireEvent.click( getByText( 'confirm' ) );
		} );
		expect( queryByTestId( 'confirm-modal' ) ).toBeNull();
		expect( lastHeaderProps.mode ).toBe( 'view' );
	} );

	it( 'edit mode: dirty draft → ConfirmModal cancel keeps edit mode', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo n1\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'drop-echo' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'view' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'cancel-confirm' ) );
		} );
		expect( queryByTestId( 'confirm-modal' ) ).toBeNull();
		expect( lastHeaderProps.mode ).toBe( 'edit' );
	} );

	it( 'handleDelete: opens a ConfirmModal naming the topology (no immediate delete)', async () => {
		hooks.topologies = [ { name: 'demo', source: 'user' } ];
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: '',
			name: 'demo',
		} );
		hooks.deleteTopology.mockClear();
		try {
			window.history.replaceState( {}, '', '/?topology=demo' );
			const { getByText, queryByTestId } = render( <TopologyConsole /> );
			await act( async () => {
				fireEvent.click( getByText( 'edit' ) );
			} );
			await act( async () => {
				fireEvent.click( getByText( 'delete' ) );
			} );
			// Modal mounts; delete is deferred until the user confirms.
			expect( queryByTestId( 'confirm-modal' ) ).not.toBeNull();
			expect( globalThis.__lastConfirmModal.body ).toContain( 'demo' );
			expect( hooks.deleteTopology ).not.toHaveBeenCalled();
		} finally {
			hooks.topologies = [];
		}
	} );

	it( 'handleDelete: confirming the modal removes via deleteTopology + toasts', async () => {
		hooks.topologies = [ { name: 'demo', source: 'user' } ];
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: '',
			name: 'demo',
		} );
		hooks.deleteTopology.mockResolvedValueOnce( {
			stock_fallback: false,
		} );
		try {
			window.history.replaceState( {}, '', '/?topology=demo' );
			const { container, getByText, queryByTestId } = render(
				<TopologyConsole />
			);
			await act( async () => {
				fireEvent.click( getByText( 'edit' ) );
			} );
			await act( async () => {
				fireEvent.click( getByText( 'delete' ) );
			} );
			await act( async () => {
				fireEvent.click( getByText( 'confirm' ) );
			} );
			expect( hooks.deleteTopology ).toHaveBeenCalledWith( {
				name: 'demo',
			} );
			expect( queryByTestId( 'confirm-modal' ) ).toBeNull();
			const toast = container.querySelector( '.topology-toast--success' );
			expect( toast ).not.toBeNull();
		} finally {
			hooks.topologies = [];
		}
	} );

	it( 'handleDelete: cancelling the modal skips delete + closes the modal', async () => {
		hooks.topologies = [ { name: 'demo', source: 'user' } ];
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: '',
			name: 'demo',
		} );
		hooks.deleteTopology.mockClear();
		try {
			window.history.replaceState( {}, '', '/?topology=demo' );
			const { getByText, queryByTestId } = render( <TopologyConsole /> );
			await act( async () => {
				fireEvent.click( getByText( 'edit' ) );
			} );
			await act( async () => {
				fireEvent.click( getByText( 'delete' ) );
			} );
			await act( async () => {
				fireEvent.click( getByText( 'cancel-confirm' ) );
			} );
			expect( hooks.deleteTopology ).not.toHaveBeenCalled();
			expect( queryByTestId( 'confirm-modal' ) ).toBeNull();
		} finally {
			hooks.topologies = [];
		}
	} );

	it( 'handleDelete: error path toasts the error', async () => {
		hooks.topologies = [ { name: 'demo', source: 'user' } ];
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: '',
			name: 'demo',
		} );
		hooks.deleteTopology.mockRejectedValueOnce( {
			message: 'denied',
		} );
		try {
			window.history.replaceState( {}, '', '/?topology=demo' );
			const { container, getByText } = render( <TopologyConsole /> );
			await act( async () => {
				fireEvent.click( getByText( 'edit' ) );
			} );
			await act( async () => {
				fireEvent.click( getByText( 'delete' ) );
			} );
			await act( async () => {
				fireEvent.click( getByText( 'confirm' ) );
			} );
			const toast = container.querySelector( '.topology-toast--error' );
			expect( toast ).not.toBeNull();
		} finally {
			hooks.topologies = [];
		}
	} );

	it( 'handleRenameNode: rejects empty name', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo n1\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'select-n1' ) );
		} );
		const result = lastInspectorProps.onRenameNode( 'n1', '' );
		expect( result ).toBe( false );
	} );

	it( 'handleRenameNode: rejects same-name', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo n1\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'select-n1' ) );
		} );
		const result = lastInspectorProps.onRenameNode( 'n1', 'n1' );
		expect( result ).toBe( false );
	} );

	it( 'switching worker via onPathChange resets selection + transcript + parsed', async () => {
		window.NewspackNodesData.topologyWorkers = { demo: 2 };
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { container } = render( <TopologyConsole /> );
		await fireMsg( { type: TM_BYTESTREAM, value: 'pre-switch' } );
		expect(
			container.querySelectorAll( '[data-testid="repl-transcript"] li' )
				.length
		).toBeGreaterThan( 0 );
		await act( async () => {
			lastHeaderProps.onPathChange( 'demo.p1' );
		} );
		expect(
			container.querySelectorAll( '[data-testid="repl-transcript"] li' )
				.length
		).toBe( 0 );
		window.history.replaceState( {}, '', '/' );
	} );

	it( 'handleSaveLayout: positions get serialized + sent to saveLayout', async () => {
		hooks.saveLayout.mockResolvedValueOnce( {
			name: 'demo',
			positions: { n1: [ 100, 200 ] },
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByText } = render( <TopologyConsole /> );
		await publishMeta();
		await act( async () => {
			fireEvent.click( getByText( 'move-n1' ) );
		} );
		const saveBtn = queryByText( 'save-layout' );
		expect( saveBtn ).not.toBeNull();
		await act( async () => {
			fireEvent.click( saveBtn );
		} );
		expect( hooks.saveLayout ).toHaveBeenCalledWith(
			expect.objectContaining( {
				name: 'demo',
				positions: { n1: [ 100, 200 ] },
			} )
		);
	} );

	it( 'handleSaveLayout: error path toasts error message', async () => {
		hooks.saveLayout.mockRejectedValueOnce( {
			data: { message: 'forbidden' },
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { container, getByText, queryByText } = render(
			<TopologyConsole />
		);
		await publishMeta();
		await act( async () => {
			fireEvent.click( getByText( 'move-n1' ) );
		} );
		const saveBtn = queryByText( 'save-layout' );
		await act( async () => {
			fireEvent.click( saveBtn );
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		const toast = container.querySelector( '.topology-toast--error' );
		expect( toast ).not.toBeNull();
		expect( toast.textContent ).toMatch( /forbidden/ );
	} );

	it( 'server-saved layout does NOT seed positions at cwd="/" (local Shell ≠ topology worker)', async () => {
		// fetchLayout returns the SERVER-saved layout for the chosen topology
		// — those are the worker's nodes (e.g. `completed:tee`, `jobs:partition`).
		// At cwd="/" the canvas renders the local browser Shell's spine, which
		// is unrelated to the topology. Seeding the server layout here would
		// dump worker positions into the local scope's localStorage entry,
		// which is the bug Chris reported.
		hooks.fetchLayout.mockResolvedValue( {
			positions: {
				'completed:tee': [ 780, 25 ],
				'jobs:partition': [ 1020, 410 ],
				jobrouter: [ 300, -140 ],
			},
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		const stored = JSON.parse(
			window.localStorage.getItem( 'newspack-nodes:topology:local' ) ||
				'null'
		);
		// If the entry exists, it MUST NOT contain the server's worker-shape
		// node ids. (The canvas's own autoLayout seed of any local Shell
		// nodes is fine; those are unrelated.)
		const positions = ( stored && stored.positions ) || {};
		expect( positions ).not.toHaveProperty( 'completed:tee' );
		expect( positions ).not.toHaveProperty( 'jobs:partition' );
		expect( positions ).not.toHaveProperty( 'jobrouter' );
	} );

	it( 'handleResetLayout at a topology worker cwd reverts to the saved layout (re-adopts server, modified=false)', async () => {
		// Server-saved layout applies at WORKER scopes (where the canvas
		// shows the topology's nodes), not at cwd="/" (local Shell). After a
		// reset, useCanvasLayout re-inits and adopts the serverLayout again.
		hooks.fetchLayout.mockResolvedValue( {
			positions: { n1: [ 50, 60 ] },
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByText } = render( <TopologyConsole /> );
		// Pivot to the topology's worker — scope.key = `demo.p0`, which is
		// what the server-saved layout is for.
		act( () => {
			lastReplProps.onSubmit( 'cd /demo.p0' );
		} );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		// Publish the worker's node so the canvas is ready and adopts the layout.
		await publishMeta();
		// User drags a node — positions diverge from saved, Reset Layout appears.
		await act( async () => {
			fireEvent.click( getByText( 'move-n1' ) );
		} );
		const resetBtn = queryByText( 'reset-layout' );
		expect( resetBtn ).not.toBeNull();
		await act( async () => {
			fireEvent.click( resetBtn );
		} );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		const stored = JSON.parse(
			window.localStorage.getItem( 'newspack-nodes:topology:demo.p0' )
		);
		expect( stored.positions ).toEqual( { n1: { x: 50, y: 60 } } );
		expect( stored.modified ).toBe( false );
	} );

	it( 'live mode at a server scope shows reset-layout when the stored layout diverges from the server-saved one', async () => {
		// New model: at a worker scope (server scope), the Reset Layout chip
		// gates on divergence from the server-saved layout. A stored layout that
		// no longer matches the server surfaces the chip so the user can restore.
		window.localStorage.setItem(
			'newspack-nodes:topology:demo.p0',
			JSON.stringify( {
				positions: { n1: { x: 12, y: 34 } },
				viewport: null,
				modified: true,
			} )
		);
		hooks.fetchLayout.mockResolvedValue( {
			positions: { n1: [ 500, 600 ] },
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { queryByText } = render( <TopologyConsole /> );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		await publishMeta();
		// Stored {12,34} ≠ server {500,600} → diverges → chip MUST show.
		expect( queryByText( 'reset-layout' ) ).not.toBeNull();
	} );

	it( 'edit mode hides the reset-layout chip after Reset (the layout is now an untouched autoLayout)', async () => {
		// Edit-mode Reset autoLayouts (serverSeedBlocked). Right after Reset the
		// layout is an untouched auto-fit, so the chip hides (clicking again would
		// re-run the same autoLayout); it returns once the user drags a node.
		hooks.fetchLayout.mockResolvedValue( {
			positions: { n1: [ 500, 600 ], _repl: [ 700, 800 ] },
		} );
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo n1\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		// Drag n1 away so the layout diverges and the chip appears.
		await act( async () => {
			fireEvent.click( getByText( 'move-n1' ) );
		} );
		expect( queryByText( 'reset-layout' ) ).not.toBeNull();
		fireEvent.click( queryByText( 'reset-layout' ) );
		await act( async () => {
			fireEvent.click( getByText( 'confirm' ) );
		} );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		expect( queryByText( 'reset-layout' ) ).toBeNull();
	} );

	it( 'edit mode shows the reset-layout chip as soon as the server-saved layout is seeded (dirty=false)', async () => {
		// In edit mode, "Reset Layout" means "blow away the saved layout and
		// go to autoLayout". It must be available even when dirty=false (just
		// loaded the topology) — otherwise the user has no way to discard the
		// server layout without first dragging a node.
		hooks.fetchLayout.mockResolvedValue( {
			positions: { n1: [ 500, 600 ] },
		} );
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo n1\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		expect( queryByText( 'reset-layout' ) ).not.toBeNull();
	} );

	it( 'handleResetLayout in edit mode autoLayouts (does NOT re-adopt the server-saved layout)', async () => {
		// "The way it's been": live mode loads the saved layout, but edit-mode
		// Reset autoLayouts (serverSeedBlocked blocks the server seed for the rest
		// of the session at this scope). So after Reset, n1 is at its autoLayout
		// position, NOT the server-saved {500,600}.
		hooks.fetchLayout.mockResolvedValue( {
			positions: { n1: [ 500, 600 ] },
		} );
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo n1\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		// Drag n1 away from the server position so Reset Layout has work to do.
		await act( async () => {
			fireEvent.click( getByText( 'move-n1' ) );
		} );
		const resetBtn = queryByText( 'reset-layout' );
		expect( resetBtn ).not.toBeNull();
		await act( async () => {
			fireEvent.click( resetBtn );
		} );
		// Confirm the edit-mode dialog.
		await act( async () => {
			fireEvent.click( getByText( 'confirm' ) );
		} );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		// After edit-mode Reset the layout is autoLayout, NOT the server seed —
		// n1 is NOT at {500,600}, and the map is a fresh (unmodified) auto-fit.
		// Edit mode persists under the per-topology key (`edit:demo`), not the cwd.
		const stored = JSON.parse(
			window.localStorage.getItem(
				'newspack-nodes:topology:edit:demo'
			) || 'null'
		);
		expect( stored ).not.toBeNull();
		expect( stored.positions.n1 ).toBeDefined();
		expect( stored.positions.n1 ).not.toEqual( { x: 500, y: 600 } );
		expect( stored.modified ).toBe( false );
	} );

	it( 'handleResetLayout: edit mode pops the confirm modal', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: '',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByText, queryByTestId } = render(
			<TopologyConsole />
		);
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'move-n1' ) );
		} );
		const resetBtn = queryByText( 'reset-layout' );
		expect( resetBtn ).not.toBeNull();
		await act( async () => {
			fireEvent.click( resetBtn );
		} );
		expect( queryByTestId( 'confirm-modal' ) ).not.toBeNull();
		await act( async () => {
			fireEvent.click( getByText( 'confirm' ) );
		} );
		expect( queryByTestId( 'confirm-modal' ) ).toBeNull();
	} );

	it( 'handleResetLayout: edit-mode reset cancel keeps overrides', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: '',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByText, queryByTestId } = render(
			<TopologyConsole />
		);
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'move-n1' ) );
		} );
		const resetBtn = queryByText( 'reset-layout' );
		await act( async () => {
			fireEvent.click( resetBtn );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'cancel-confirm' ) );
		} );
		expect( queryByTestId( 'confirm-modal' ) ).toBeNull();
	} );

	it( 'savedLayout fetch error: layout state falls back to {positions: null}', async () => {
		hooks.fetchLayout.mockRejectedValueOnce( new Error( 'boom' ) );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByTestId } = render( <TopologyConsole /> );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		await publishMeta();
		expect( getByTestId( 'canvas' ) ).not.toBeNull();
	} );

	it( 'savedLayout fetch resolving to null takes the .then path, not .catch (defensive null handling)', async () => {
		// fetchLayout's hook contract permits `null` (no saved layout yet).
		// The effect's .then handler must treat null cleanly — i.e. extract
		// positions safely — instead of crashing on `resp.positions` and
		// falling through to .catch. The .catch path firing on a successful
		// `null` response generates async setSavedLayout calls outside any
		// test's act() boundary, producing the act() warning swarm.
		//
		// We assert this by handing the effect a Promise whose .then receiver
		// observes whether it was invoked, AND attaching a sentinel .catch
		// onto the same chain to detect synchronous throws inside .then.
		let thenSawNull = false;
		let catchFired = false;
		hooks.fetchLayout.mockReset();
		hooks.fetchLayout.mockImplementation( () => {
			// Return a thenable wrapper so we can observe which branch runs.
			const real = Promise.resolve( null );
			return {
				then( onFulfilled, onRejected ) {
					return real.then( ( v ) => {
						try {
							const r = onFulfilled( v );
							thenSawNull = true;
							return r;
						} catch ( e ) {
							if ( onRejected ) {
								return onRejected( e );
							}
							throw e;
						}
					}, onRejected );
				},
				catch( onRejected ) {
					return real
						.then( ( v ) => v )
						.catch( ( e ) => {
							catchFired = true;
							return onRejected( e );
						} );
				},
			};
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 0 ) );
			await new Promise( ( r ) => setTimeout( r, 0 ) );
		} );
		expect( thenSawNull ).toBe( true );
		expect( catchFired ).toBe( false );
	} );

	it( 'layoutsEqualSaved: positionOverrides matches saved layout exactly', async () => {
		hooks.fetchLayout.mockResolvedValueOnce( {
			positions: { n1: [ 100, 200 ] },
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByText } = render( <TopologyConsole /> );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		expect( queryByText( 'save-layout' ) ).toBeNull();
		expect( getByText( 'submit' ) ).not.toBeNull();
	} );

	it( 'layoutDivergesFromSaved ignores a stored position for a node no longer in the graph (no false divergence)', async () => {
		// A deleted node leaves a stale entry in the stored layout map. The
		// divergence check must consider only ids in the LIVE graph — a stored
		// `ghost` that matches nothing on the canvas must NOT surface the chips.
		window.localStorage.setItem(
			'newspack-nodes:topology:demo.p0',
			JSON.stringify( {
				positions: {
					n1: { x: 50, y: 60 },
					ghost: { x: 999, y: 999 },
				},
				viewport: null,
				modified: true,
			} )
		);
		// Server has only the live node n1, at the same position.
		hooks.fetchLayout.mockResolvedValue( {
			positions: { n1: [ 50, 60 ] },
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { queryByText } = render( <TopologyConsole /> );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		// Live graph is just n1; the stale `ghost` override must be ignored.
		await publishMeta();
		// n1 matches saved exactly and ghost is filtered → no divergence chips.
		expect( queryByText( 'save-layout' ) ).toBeNull();
		expect( queryByText( 'reset-layout' ) ).toBeNull();
	} );

	it( 'handleSaveLayout excludes a stored position for a node no longer in the graph', async () => {
		// The save payload must serialize only live-graph ids — a deleted node's
		// stale stored position must not leak back to the server.
		window.localStorage.setItem(
			'newspack-nodes:topology:demo.p0',
			JSON.stringify( {
				positions: {
					n1: { x: 50, y: 60 },
					ghost: { x: 999, y: 999 },
				},
				viewport: null,
				modified: true,
			} )
		);
		hooks.fetchLayout.mockResolvedValue( {
			positions: { n1: [ 50, 60 ] },
		} );
		hooks.saveLayout.mockResolvedValueOnce( {
			name: 'demo',
			positions: { n1: [ 100, 200 ] },
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByText } = render( <TopologyConsole /> );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		await publishMeta();
		// Drag the live node so the layout diverges and the save chip appears.
		await act( async () => {
			fireEvent.click( getByText( 'move-n1' ) );
		} );
		const saveBtn = queryByText( 'save-layout' );
		expect( saveBtn ).not.toBeNull();
		await act( async () => {
			fireEvent.click( saveBtn );
		} );
		expect( hooks.saveLayout ).toHaveBeenCalledTimes( 1 );
		const payload = hooks.saveLayout.mock.calls[ 0 ][ 0 ];
		expect( payload.positions ).toHaveProperty( 'n1' );
		expect( payload.positions ).not.toHaveProperty( 'ghost' );
	} );

	it( 'local scope, empty storage: one autoLayout over the COMPLETE graph (isolated node on the right)', async () => {
		// Mirrors the overlay regression: s->t connected; iso isolated.
		// autoLayout puts s at col0, t + iso at maxDepth (right column). The
		// old seed model dropped iso into the LEFT column via placeNewNode.
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: {
				s: { class: 'Echo', counter: 0, sink: '', target: 't' },
				t: { class: 'Echo', counter: 0, sink: '', target: '' },
				iso: { class: 'Echo', counter: 0, sink: '', target: '' },
			},
		} );
		const stored = JSON.parse(
			window.localStorage.getItem( 'newspack-nodes:topology:local' )
		);
		expect( stored.positions.iso.x ).toBe( stored.positions.t.x );
		expect( stored.positions.iso.x ).toBeGreaterThan(
			stored.positions.s.x
		);
		expect( stored.modified ).toBe( false );
	} );

	it( 'worker scope: adopts the server-saved layout instead of autoLayout', async () => {
		// At a worker cwd whose label matches the topology, the canvas adopts
		// the server-saved positions at init (never runs autoLayout there).
		hooks.fetchLayout.mockResolvedValueOnce( {
			positions: { n1: [ 700, 800 ] },
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		// Publish the worker's node so the graph is ready for the one-shot init.
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: {
				n1: { class: 'Echo', counter: 0, sink: '', target: '' },
			},
		} );
		expect( lastCanvasProps.positionOverrides.n1 ).toEqual( {
			x: 700,
			y: 800,
		} );
		const stored = JSON.parse(
			window.localStorage.getItem( 'newspack-nodes:topology:demo.p0' )
		);
		expect( stored.positions.n1 ).toEqual( { x: 700, y: 800 } );
		expect( stored.modified ).toBe( false );
	} );

	describe( 'skin theme', () => {
		const rootClass = ( container ) =>
			container.querySelector( '.topology-app' ).className;

		it( 'defaults to theme-newspack when localStorage is empty', () => {
			const { container } = render( <TopologyConsole /> );
			expect( rootClass( container ) ).toContain( 'theme-newspack' );
		} );

		it( 'applies a valid stored skin on mount', () => {
			window.localStorage.setItem( 'newspack-nodes:theme', 'blueprint' );
			const { container } = render( <TopologyConsole /> );
			expect( rootClass( container ) ).toContain( 'theme-blueprint' );
		} );

		it( 'falls back to theme-newspack for an unknown stored skin', () => {
			window.localStorage.setItem( 'newspack-nodes:theme', 'bogus' );
			const { container } = render( <TopologyConsole /> );
			expect( rootClass( container ) ).toContain( 'theme-newspack' );
			expect( rootClass( container ) ).not.toContain( 'theme-bogus' );
		} );

		it( 'no longer threads skin props to the header (skins moved to the REPL)', () => {
			render( <TopologyConsole /> );
			expect( lastHeaderProps.onThemeChange ).toBeUndefined();
			expect( lastHeaderProps.themes ).toBeUndefined();
		} );

		it( 'set_skin REPL builtin updates the root class and persists', () => {
			const { container } = render( <TopologyConsole /> );
			act( () => {
				// Spaced label form resolves to the `crt` slug.
				lastReplProps.onSubmit( 'set_skin CRT Phosphor' );
			} );
			expect( rootClass( container ) ).toContain( 'theme-crt' );
			expect(
				window.localStorage.getItem( 'newspack-nodes:theme' )
			).toBe( 'crt' );
		} );
	} );
} );

describe( 'initialTopologyFromUrl (deep-link validation)', () => {
	afterEach( () => {
		window.history.replaceState( {}, '', '/' );
	} );

	it( 'honors a deep link from the module-load SEED even when a sibling hub bundle later clobbers window.NewspackNodesData', () => {
		jest.isolateModules( () => {
			// Seed the snapshot BEFORE the module imports so SEED_WORKERS
			// captures it (mirrors production: the console bundle's localize is
			// current when its own script executes).
			window.NewspackNodesData = {
				topologyWorkers: { alpha: 1, demo: 2 },
				activeTopologies: [],
			};
			// eslint-disable-next-line global-require
			const mod = require( '../TopologyConsole' );
			window.history.replaceState( {}, '', '/?topology=demo' );
			// A sibling hub bundle re-localized NewspackNodesData WITHOUT
			// topologyWorkers — the real clobber. The SEED must still resolve
			// the deep link rather than fall back to the first topology.
			window.NewspackNodesData = { tree: 'event-dashboards' };
			expect( mod.initialTopologyFromUrl( 'alpha' ) ).toBe( 'demo' );
		} );
	} );

	it( 'falls back when ?topology= is not a known topology', () => {
		window.history.replaceState( {}, '', '/?topology=ghost' );
		expect( initialTopologyFromUrl( 'fallback-topology' ) ).toBe(
			'fallback-topology'
		);
	} );
} );
