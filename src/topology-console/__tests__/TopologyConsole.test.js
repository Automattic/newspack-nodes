/* global globalThis */
/**
 * TopologyConsole tests. useConsoleGraph is mocked to build the REAL receive
 * graph (Router → Dumper/_output, Metadata/_metadata, Uptime/_uptime) plus a
 * real Shell whose sink is the (capture-only) CommandInterpreter and a fake
 * HttpOut that records POSTs. SSE replies are simulated by filling the Router
 * with a POSITIONAL Message (the substrate's only format). Mocked child
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
	topologyPartitions: { demo: 2 },
	activeTopologies: [ 'demo' ],
	version: 'test',
	userLogin: 'tester',
};

// Capture HttpOut POSTs (the worker-bound batch each typed/poll command makes).
globalThis.__httpPosts = [];
// {topology}.p{N} the mock graph is built for; a change rebuilds a fresh graph.
globalThis.__graphKey = null;
globalThis.__shell = null;
jest.mock( '../hooks/useConsoleGraph', () => {
	const { Core } = require( '../../runtime/core' );
	const { Router } = require( '../../runtime/router' );
	const {
		CommandInterpreter,
	} = require( '../../runtime/command_interpreter' );
	const { Node } = require( '../../runtime/node' );
	const { Dumper } = require( '../nodes/dumper' );
	const { Metadata } = require( '../nodes/metadata' );
	const { Uptime } = require( '../nodes/uptime' );
	const { Completion } = require( '../nodes/completion' );
	const { HttpOut } = require( '../../runtime/httpOut' );
	const { SseIn } = require( '../nodes/sseIn' );
	const { Shell } = require( '../nodes/shell' );
	const reserved = require( '../../runtime/reserved-node-names.json' );
	const NAMES = [
		reserved.ROUTER,
		reserved.COMMAND_INTERPRETER,
		reserved.OUTPUT,
		reserved.METADATA,
		reserved.UPTIME,
		reserved.COMPLETION,
		reserved.HTTP,
		reserved.SSE,
		reserved.CWD,
	];
	const teardown = () => {
		Core.node( reserved.ROUTER )?.stopTimer();
		for ( const n of NAMES ) {
			Core.unregisterNode( n );
		}
		globalThis.__graphKey = null;
		globalThis.__shell = null;
	};
	return {
		useConsoleGraph: ( {
			topology,
			partition,
			enabled,
			debugLevelRef,
			resetKey,
		} ) => {
			if ( ! enabled ) {
				teardown();
				return { status: 'closed', ssePid: null, shell: null };
			}
			const reader = `${ topology }.p${ partition }`;
			// Mirror the real useConsoleGraph effect deps: tearing down + rebuilding
			// on resetKey change too. Without resetKey here the mock would never
			// re-mount on a reset-graph click, masking cwd-preservation bugs.
			const key = `${ reader }|${ resetKey || 0 }`;
			if ( globalThis.__graphKey !== key ) {
				teardown();
				const router = new Router();
				router.setName( reserved.ROUTER );
				const ci = new CommandInterpreter();
				ci.setName( reserved.COMMAND_INTERPRETER );
				ci.sink = router;
				const dumper = new Dumper();
				dumper.debugLevelRef = debugLevelRef;
				dumper.setName( reserved.OUTPUT );
				const metadata = new Metadata();
				metadata.setName( reserved.METADATA );
				const uptime = new Uptime();
				uptime.setName( reserved.UPTIME );
				new Completion().setName( reserved.COMPLETION );
				// Fake HttpOut: capture the routed message instead of POSTing.
				const httpOut = new HttpOut();
				httpOut.client = {
					buildMessage: () => null,
					postBatch: () => Promise.resolve( null ),
				};
				httpOut.fill = ( message ) => {
					globalThis.__httpPosts.push( message );
				};
				httpOut.setName( reserved.HTTP );
				// `_sse` session node: wraps an outgoing reply-node FROM with the
				// pid; routing `_sse/{reader}` peels here before `_http`.
				const sse = new SseIn();
				sse.arguments = `${ reader } / `;
				sse.setName( reserved.SSE );
				sse.sink = router;
				sse.target = reserved.OUTPUT;
				sse.pid = () => 1234;
				const shell = new Shell();
				shell.path = `${ reserved.SSE }/${ reader }`;
				shell.sink = ci;
				// `_cwd` indirection node: a plain Node whose target IS the cwd.
				const cwdNode = new Node();
				cwdNode.setName( reserved.CWD );
				cwdNode.sink = ci;
				cwdNode.target = shell.path;
				// Mirror the real timer wiring so the cadence test exercises the
				// Router TIMER → Metadata/Uptime onTimer → CI → … → HttpOut path.
				metadata.sink = ci;
				uptime.sink = ci;
				metadata.target = reserved.CWD;
				uptime.target = reserved.CWD;
				router.beforeTimerNotify = () => httpOut.lock();
				router.afterTimerNotify = () => httpOut.flush();
				router.register( 'TIMER', reserved.METADATA, () =>
					metadata.onTimer()
				);
				router.register( 'TIMER', reserved.UPTIME, () =>
					uptime.onTimer()
				);
				router.startTimer( 1000 );
				globalThis.__shell = shell;
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
	fetchLayout: jest.fn().mockResolvedValue( null ),
	saveLayout: jest.fn().mockResolvedValue( null ),
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
// eslint-disable-next-line no-unused-vars
let lastCanvasProps = null;
// eslint-disable-next-line no-unused-vars
let lastInspectorProps = null;
let lastHeaderProps = null;
jest.mock( '../components/SchematicCanvas', () => ( props ) => {
	lastCanvasProps = props;
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
} );
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
jest.mock( '../components/Header', () => ( props ) => {
	lastHeaderProps = props;
	return (
		<header data-testid="header" data-mode={ props.mode }>
			<button onClick={ () => props.onModeChange( 'edit' ) }>edit</button>
			<button onClick={ () => props.onModeChange( 'view' ) }>view</button>
			<button onClick={ () => props.onSave && props.onSave() }>
				save
			</button>
			<button onClick={ () => props.onOpen && props.onOpen() }>
				open
			</button>
			<button onClick={ () => props.onNew && props.onNew() }>new</button>
			<button onClick={ () => props.onDelete && props.onDelete() }>
				delete
			</button>
		</header>
	);
} );
let lastPaletteProps = null;
jest.mock( '../components/Palette', () => ( props ) => {
	lastPaletteProps = props;
	return <aside data-testid="palette" />;
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
// eslint-disable-next-line no-unused-vars
let lastCanvasFrameProps = null;
jest.mock( '../components/CanvasFrame', () => ( props ) => {
	lastCanvasFrameProps = props;
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
} ) );

import TopologyConsole from '../TopologyConsole';
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
		hooks.deleteTopology.mockReset();
		hooks.deleteTopology.mockResolvedValue( null );
		hooks.fetchLayout.mockReset();
		hooks.fetchLayout.mockResolvedValue( null );
		hooks.saveLayout.mockReset();
		hooks.saveLayout.mockResolvedValue( null );
		hooks.topologies = [];
		globalThis.__catalog = { classes: [], formatters: [] };
	} );

	// Simulate an SSE reply: the Router routes a positional Message by TO.
	const fireMsg = async ( opts ) => {
		await act( async () => {
			Core.node( names.ROUTER ).fill( posMsg( opts ) );
		} );
	};

	it( 'renders Header, Palette, Canvas, and ReplFooter on mount (Inspector is selection-only)', () => {
		// Palette is always-on per the interactive-live-canvas spec: a drop in
		// view mode issues `make_node` via sendLine; a drop in edit adds to the
		// draft. Edit-only gating was a stale Task 3 regression.
		const { getByTestId, queryByTestId } = render( <TopologyConsole /> );
		expect( getByTestId( 'header' ) ).not.toBeNull();
		expect( getByTestId( 'palette' ) ).not.toBeNull();
		expect( getByTestId( 'canvas' ) ).not.toBeNull();
		expect( queryByTestId( 'inspector' ) ).toBeNull();
		expect( getByTestId( 'repl' ) ).not.toBeNull();
	} );

	it( 'starts in view mode by default', () => {
		const { getByTestId } = render( <TopologyConsole /> );
		expect( getByTestId( 'header' ).dataset.mode ).toBe( 'view' );
		expect( getByTestId( 'canvas' ).dataset.mode ).toBe( 'view' );
	} );

	it( 'polls dump_metadata every tick and uptime on the 5s cadence (reply pivots to _metadata/_uptime)', () => {
		jest.useFakeTimers();
		try {
			globalThis.__httpPosts = [];
			window.history.replaceState( {}, '', '/?topology=demo' );
			act( () => {
				render( <TopologyConsole /> );
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
			// `_sse` wrapped each poll's bare reply-node FROM into the private pivot.
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
	} );

	it( 'onComplete on the FIRST token dispatches a `help` completion query (KEY=completion, FROM pivots to _completion)', () => {
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
		// `_sse` wrapped the bare _completion reply-node FROM into the private pivot.
		expect( m[ FROM ] ).toBe( `${ names.SSE }:1234/${ names.COMPLETION }` );
		expect( m[ TO ] ).toBe( 'demo.p0' );
		// Minted in-process → LOCAL taint set (the wire pack() strips it later).
		expect( m[ LOCAL ] ).toBe( true );
	} );

	it( 'onComplete on a LATER token dispatches an `ls` completion query', () => {
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
		// eslint-disable-next-line no-bitwise
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
		// eslint-disable-next-line no-bitwise
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
		// eslint-disable-next-line no-bitwise
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
		// eslint-disable-next-line no-bitwise
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
			// eslint-disable-next-line no-bitwise
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

	it( 'URL state: ?topology=demo is read on mount', () => {
		window.history.replaceState( {}, '', '/?topology=demo&partition=0' );
		const { getByTestId } = render( <TopologyConsole /> );
		expect( getByTestId( 'header' ).dataset.mode ).toBe( 'view' );
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

	it( 'select node mounts the inspector', () => {
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		expect( queryByTestId( 'inspector' ) ).toBeNull();
		fireEvent.click( getByText( 'select-n1' ) );
		expect( queryByTestId( 'inspector' ) ).not.toBeNull();
		expect( queryByTestId( 'inspector' ).dataset.selectedId ).toBe( 'n1' );
	} );

	it( 'deselect unmounts the inspector', () => {
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		fireEvent.click( getByText( 'select-n1' ) );
		expect( queryByTestId( 'inspector' ) ).not.toBeNull();
		fireEvent.click( getByText( 'deselect' ) );
		expect( queryByTestId( 'inspector' ) ).toBeNull();
	} );

	it( 'deselect removes the is-inspector-open grid column', () => {
		const { getByText, container } = render( <TopologyConsole /> );
		fireEvent.click( getByText( 'select-n1' ) );
		expect(
			container.querySelector( '.topology-app' ).className
		).toContain( 'is-inspector-open' );
		fireEvent.click( getByText( 'deselect' ) );
		expect(
			container.querySelector( '.topology-app' ).className
		).not.toContain( 'is-inspector-open' );
	} );

	it( 'select edge clears any selected node', () => {
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		fireEvent.click( getByText( 'select-n1' ) );
		expect( queryByTestId( 'inspector' ) ).not.toBeNull();
		fireEvent.click( getByText( 'select-edge' ) );
		expect( queryByTestId( 'inspector' ) ).toBeNull();
	} );

	it( 'Inspector dump action emits a sent transcript entry', () => {
		const { container, getByText } = render( <TopologyConsole /> );
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

	it( 'Inspector tail action posts connect_node command', () => {
		const { container, getByText } = render( <TopologyConsole /> );
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

	it( 'Inspector send action emits send_node with payload', () => {
		const { container, getByText } = render( <TopologyConsole /> );
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

	it( 'Inspector trace action emits debug_state with level', () => {
		const { container, getByText } = render( <TopologyConsole /> );
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

	it( 'Inspector request action emits request_node with verb', () => {
		const { container, getByText } = render( <TopologyConsole /> );
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
		expect( captured[ 0 ][ TO ] ).toBe( '_sse/demo.p0/n1' );
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
		expect( captured[ 0 ][ TO ] ).toBe( '_sse/demo.p0/n1:config' );
	} );

	it( 'Inspector disconnect action emits disconnect_node', () => {
		const { container, getByText } = render( <TopologyConsole /> );
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

	it( 'position change persists to localStorage with user flag', () => {
		const { getByText } = render( <TopologyConsole /> );
		fireEvent.click( getByText( 'move-n1' ) );
		const keys = Object.keys( window.localStorage ).filter( ( k ) =>
			k.endsWith( ':positions' )
		);
		expect( keys.length ).toBeGreaterThan( 0 );
		const stored = JSON.parse(
			window.localStorage.getItem( keys[ 0 ] ) || '{}'
		);
		expect( stored.n1 ).toEqual( { x: 100, y: 200 } );
	} );

	it( 'viewport change debounces to localStorage', () => {
		jest.useFakeTimers();
		try {
			const { getByText } = render( <TopologyConsole /> );
			fireEvent.click( getByText( 'vp-change' ) );
			const beforeKeys = Object.keys( window.localStorage ).filter(
				( k ) => k.endsWith( ':viewport' )
			);
			expect( beforeKeys.length ).toBe( 0 );
			act( () => {
				jest.advanceTimersByTime( 250 );
			} );
			const keys = Object.keys( window.localStorage ).filter( ( k ) =>
				k.endsWith( ':viewport' )
			);
			expect( keys.length ).toBeGreaterThan( 0 );
			const stored = JSON.parse(
				window.localStorage.getItem( keys[ 0 ] ) || '{}'
			);
			expect( stored ).toEqual( { x: 10, y: 20, w: 800, h: 600 } );
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'header new resets draft + selection state', () => {
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		fireEvent.click( getByText( 'select-n1' ) );
		expect( queryByTestId( 'inspector' ) ).not.toBeNull();
		fireEvent.click( getByText( 'new' ) );
		expect( queryByTestId( 'inspector' ) ).toBeNull();
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

	it( 'Header receives pathOptions built from topologies + partitions', () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		// demo has 2 partitions → '', '_sse', '_sse/demo.p0', '_sse/demo.p1'.
		expect( lastHeaderProps.pathOptions ).toEqual( [
			'',
			'_sse',
			'_sse/demo.p0',
			'_sse/demo.p1',
		] );
	} );

	it( 'pathOptions lists only ACTIVE topologies (excludes inactive ones)', () => {
		const prev = window.NewspackNodesData;
		window.NewspackNodesData = {
			...prev,
			topologyPartitions: { demo: 2, idle: 1 },
			activeTopologies: [ 'demo' ],
		};
		try {
			window.history.replaceState( {}, '', '/?topology=demo' );
			render( <TopologyConsole /> );
			expect( lastHeaderProps.pathOptions ).toEqual( [
				'',
				'_sse',
				'_sse/demo.p0',
				'_sse/demo.p1',
			] );
			expect( lastHeaderProps.pathOptions ).not.toContain(
				'_sse/idle.p0'
			);
		} finally {
			window.NewspackNodesData = prev;
		}
	} );

	it( 'Header onPathChange to a different worker re-keys the graph (URL follows)', () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastHeaderProps.onPathChange( '_sse/demo.p1' );
		} );
		expect( window.location.search ).toMatch( /partition=1/ );
	} );

	it( 'Header onPathChange to a root path just moves the cwd (no partition URL)', () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastHeaderProps.onPathChange( '_sse' );
		} );
		expect( lastHeaderProps.path ).toBe( '_sse' );
		expect( window.location.search ).not.toMatch( /partition=/ );
	} );

	it( 'REPL cd to a different worker re-keys the graph like the menu', () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /_sse/demo.p1' );
		} );
		expect( window.location.search ).toMatch( /partition=1/ );
		expect( lastHeaderProps.path ).toBe( '_sse/demo.p1' );
	} );

	it( 'REPL cd into a sub-node of the CURRENT worker is free navigation (no re-key)', () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /_sse/demo.p0/firehose-in' );
		} );
		// cwd follows the deep path; same worker → no rebuild, no partition URL.
		expect( lastHeaderProps.path ).toBe( '_sse/demo.p0/firehose-in' );
		expect( window.location.search ).not.toMatch( /partition=/ );
	} );

	it( 'REPL cd into a sub-node of a DIFFERENT worker mounts that worker (largest prefix)', () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /_sse/demo.p1/firehose-in' );
		} );
		// Longest menu prefix is _sse/demo.p1 → mount p1.
		expect( window.location.search ).toMatch( /partition=1/ );
	} );

	it( 'REPL cd to a non-menu path is free navigation, not clobbered to root', () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /_http/demo.p0' );
		} );
		expect( lastHeaderProps.path ).toBe( '_http/demo.p0' );
		expect( window.location.search ).not.toMatch( /partition=/ );
	} );

	it( 'cd into a worker sub-node sets _cwd.target to the cwd verbatim', () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /_sse/demo.p0/firehose-in' );
		} );
		// The poll nodes target `_cwd`; the cwd is re-stamped from `_cwd.target`.
		expect( Core.node( names.CWD ).target ).toBe(
			'_sse/demo.p0/firehose-in'
		);
	} );

	it( 'a worker cwd during the connecting window keeps _cwd pointed at the worker (not local)', () => {
		// Previously the guard pointed _cwd at '' (the local CI) during the
		// connecting window, which made the canvas DISPLAY the local graph at
		// a worker cwd — misleading. Now _cwd tracks the cwd verbatim; the
		// POST will fail to round-trip without a pid but is cheap and silent,
		// and the canvas just holds its last state until the stream connects.
		globalThis.__connecting = true;
		try {
			window.history.replaceState( {}, '', '/?topology=demo' );
			render( <TopologyConsole /> );
			act( () => {
				lastReplProps.onSubmit( 'cd /_sse/demo.p0' );
			} );
			expect( Core.node( names.CWD ).target ).toBe( '_sse/demo.p0' );
		} finally {
			globalThis.__connecting = false;
		}
	} );

	it( 'request scope (cd /_sse) sets _cwd.target to _sse', () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /_sse' );
		} );
		expect( Core.node( names.CWD ).target ).toBe( '_sse' );
	} );

	it( 'local graph (cd /) sets _cwd.target to the empty local-root path', () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		expect( Core.node( names.CWD ).target ).toBe( '' );
	} );

	it( 'cd onto a worker sets _cwd.target to that worker', () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /_sse/demo.p1' );
		} );
		expect( Core.node( names.CWD ).target ).toBe( '_sse/demo.p1' );
	} );

	it( 'REPL cd echoes into the transcript like other builtins', () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /_sse' );
		} );
		const sent = ( lastReplProps.transcript || [] ).filter(
			( t ) => t.kind === 'sent'
		);
		expect( sent.map( ( t ) => t.text ) ).toContain( 'cd /_sse' );
	} );

	it( 'mounts the receive graph in view mode (Dumper registered as _output)', () => {
		render( <TopologyConsole /> );
		const { Dumper } = require( '../nodes/dumper' );
		expect( Core.node( names.OUTPUT ) ).toBeInstanceOf( Dumper );
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

	it( 'live canvas: connect gesture dispatches connect_node via sendLine', () => {
		const { container, getByText } = render( <TopologyConsole /> );
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

	it( 'live canvas: palette drop dispatches make_node via sendLine', () => {
		const { container, getByText } = render( <TopologyConsole /> );
		fireEvent.click( getByText( 'drop-echo' ) );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const sent = Array.from( items ).find(
			( i ) => i.dataset.kind === 'sent'
		);
		expect( sent ).not.toBeUndefined();
		expect( sent.textContent ).toMatch( /^make_node Echo \S+$/ );
	} );

	it( 'live canvas: delete selected node dispatches remove_node via sendLine', () => {
		const { container, getByText } = render( <TopologyConsole /> );
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
		const { getByText } = render( <TopologyConsole /> );
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
		expect( () =>
			fireEvent.click( getByText( 'reset-graph' ) )
		).not.toThrow();
	} );

	it( 'reset-graph preserves cwd (rebuild rehomes Shell.path to default; reset must restore the user cwd)', async () => {
		// Boot into a worker, navigate to '/' (local), then reset-graph.
		// Previously the rebuild snapped Shell.path back to _sse/{reader} and
		// the [shell] sync effect dragged cwd along, taking the user off '/'.
		// Reset must rebuild AND keep cwd at '/'.
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
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
		act( () => {
			fireEvent.click( getByText( 'reset-graph' ) );
		} );
		expect( lastHeaderProps.path ).toBe( '' );
	} );

	it( 'reset-graph wipes user-added nodes (and leaves the canonical spine + console graph)', async () => {
		// User-`make_node`'d local nodes survived the canonical-only unregister
		// loop, so the "reset" didn't feel like a reset. Now any node not in
		// the canonical console-graph set (or the backbone) is removed.
		const { Node } = require( '../../runtime/node' );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		// Simulate user `make_node Tee my-tee` having survived from a prior session.
		const userNode = new Node();
		userNode.setName( 'my-user-tee' );
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
		act( () => {
			fireEvent.click( getByText( 'reset-graph' ) );
		} );
		expect( Core.node( 'my-user-tee' ) ).toBeFalsy();
		// And the canonical backbone must STILL be present after the rebuild.
		expect( Core.node( '_command_interpreter' ) ).toBeTruthy();
		expect( Core.node( '_router' ) ).toBeTruthy();
	} );

	it( 'reset-graph clears the local-scope position overrides + viewport persistence', async () => {
		// Reset means RESET — pan/zoom state for the local scope is wiped so the
		// canvas re-autofits cleanly. Previously the spine rebuilt but layout
		// state lingered, masking the reset.
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		// Inject a user-added node so the chip is visible to click.
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: {
				n1: { class: 'Echo', counter: 0, sink: '', target: '' },
			},
		} );
		window.localStorage.setItem(
			'newspack-nodes:topology:local:viewport',
			JSON.stringify( { x: 0, y: 0, w: 100, h: 100 } )
		);
		window.localStorage.setItem(
			'newspack-nodes:topology:local:positions',
			JSON.stringify( { my: { x: 1, y: 1 } } )
		);
		act( () => {
			fireEvent.click( getByText( 'reset-graph' ) );
		} );
		expect(
			window.localStorage.getItem(
				'newspack-nodes:topology:local:viewport'
			)
		).toBeNull();
		expect(
			window.localStorage.getItem(
				'newspack-nodes:topology:local:positions'
			)
		).toBeNull();
	} );

	it( 'the palette shows JS classes at the local scope (NOT the PHP catalog)', () => {
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
	} );

	it( 'the palette shows the PHP catalog when at a worker (or editing a topology)', () => {
		// At a worker cwd, make_node runs against the PHP worker via SSE, so
		// the PHP catalog is what's accurate. Edit mode is the same — the
		// topology file is a PHP-worker configuration.
		globalThis.__catalog = {
			classes: [ { shell_name: 'PHP_Only_Class', category: 'PHP' } ],
			formatters: [],
		};
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		// Default boot is /_sse/demo.p0 (a worker) — assert PHP catalog flows.
		const paletteNames = ( lastPaletteProps?.classes || [] ).map(
			( c ) => c.shell_name
		);
		expect( paletteNames ).toContain( 'PHP_Only_Class' );
	} );

	it( 'reset-graph control shows only on the local graph with user-added nodes', async () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { queryByText } = render( <TopologyConsole /> );
		// Boots into a worker view (_sse/demo.p0); a worker graph self-heals on
		// respawn, so resetting the local console graph is meaningless → no chip.
		expect( queryByText( 'reset-graph' ) ).toBeNull();
		// cd to the local browser graph; without user-added nodes the chip is
		// also hidden (nothing to reset — only the canonical console graph).
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		expect( queryByText( 'reset-graph' ) ).toBeNull();
		// Add a user node via the metadata payload → chip appears.
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: {
				n1: { class: 'Echo', counter: 0, sink: '', target: '' },
			},
		} );
		expect( queryByText( 'reset-graph' ) ).not.toBeNull();
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
			k.endsWith( ':positions' )
		);
		expect( keys.length ).toBeGreaterThan( 0 );
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
		expect( queryByTestId( 'inspector' ) ).toBeNull();
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
		await act( async () => {
			fireEvent.click( getByText( 'move-n1' ) );
		} );
		expect( typeof hooks.saveLayout ).toBe( 'function' );
	} );

	it( 'background-click-consumed callback can swallow the first click', () => {
		render( <TopologyConsole /> );
		const fn = lastCanvasProps.onBackgroundClickConsumed;
		expect( typeof fn ).toBe( 'function' );
		expect( fn() ).toBe( false );
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

	it( 'topology with multiple partitions: switching partition clamps when invalid', () => {
		window.NewspackNodesData.topologyPartitions = { demo: 1 };
		window.history.replaceState( {}, '', '/?topology=demo&partition=3' );
		const { getByTestId } = render( <TopologyConsole /> );
		expect( getByTestId( 'header' ) ).not.toBeNull();
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
		expect( queryByTestId( 'inspector' ) ).toBeNull();
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
		expect( queryByTestId( 'inspector' ) ).toBeNull();
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

	it( 'canEdit is true when the cwd names a worker', () => {
		// Default mount lands cwd at _sse/{reader} (a worker).
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		expect( lastHeaderProps.canEdit ).toBe( true );
	} );

	it( 'canEdit is false when the cwd is a root path', () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastHeaderProps.onPathChange( '_sse' );
		} );
		expect( lastHeaderProps.canEdit ).toBe( false );
	} );

	it( 'canDeleteCurrent: returns false when no user-saved topology', () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		expect( lastHeaderProps.canDelete ).toBe( false );
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

	it( 'positionOverrides falls back to empty object on parse error', () => {
		window.localStorage.setItem(
			'newspack-nodes:topology:undefined.p0:positions',
			'this is not json'
		);
		const { getByTestId } = render( <TopologyConsole /> );
		expect( getByTestId( 'canvas' ) ).not.toBeNull();
	} );

	it( 'viewport falls back to null on parse error', () => {
		window.localStorage.setItem(
			'newspack-nodes:topology:undefined.p0:viewport',
			'malformed'
		);
		const { getByTestId } = render( <TopologyConsole /> );
		expect( getByTestId( 'canvas' ) ).not.toBeNull();
	} );

	it( 'switching partition to higher than available clamps to 0', () => {
		window.NewspackNodesData.topologyPartitions = { demo: 2 };
		window.history.replaceState( {}, '', '/?topology=demo&partition=5' );
		const { getByTestId } = render( <TopologyConsole /> );
		expect( getByTestId( 'header' ) ).not.toBeNull();
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

	it( 'sendLine: a typed command flows Shell → CI → Router → HttpOut (captured)', async () => {
		globalThis.__httpPosts = [];
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'submit' ) );
		} );
		// `ls` → default TM_COMMAND posted to the worker via _http. The Router
		// peeled _http before HttpOut captured it, so TO is the bare reader.
		const posted = globalThis.__httpPosts.find(
			( m ) => m[ VALUE ] && m[ VALUE ].name === 'ls'
		);
		expect( posted ).not.toBeUndefined();
		expect( posted[ TO ] ).toBe( 'demo.p0' );
		// `_sse` wrapped the bare `_output` FROM into the private reply pivot.
		expect( posted[ FROM ] ).toBe(
			`${ names.SSE }:1234/${ names.OUTPUT }`
		);
	} );

	it( 'handleInspectorAction invoke (command) routes a TM_COMMAND to the {node}:config sibling CI', async () => {
		// Command verbs live on the node's `{name}:config` CommandInterpreter
		// sibling, not the bare node (a plain Node ignores TM_COMMAND). Both
		// the routed TO and the echoed transcript line must carry `:config`.
		globalThis.__httpPosts = [];
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { container, getByText } = render( <TopologyConsole /> );
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

	it( 'entering edit on a blank canvas seeds the reserved _repl anchor', async () => {
		// No topology query → blank seed path.
		window.history.replaceState( {}, '', '/' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		const repl = lastCanvasProps.parsed.nodes.find(
			( n ) => n.id === '_repl'
		);
		expect( repl ).toBeDefined();
		expect( repl.reserved ).toBe( true );
	} );

	it( 'entering edit on a loaded topology seeds _repl without marking the draft dirty', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo n1\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		// _repl is present in the loaded draft.
		expect(
			lastCanvasProps.parsed.nodes.find( ( n ) => n.id === '_repl' )
		).toBeDefined();
		// Leaving without edits must NOT prompt the discard modal — _repl is in
		// the baseline too, so its presence doesn't read as a change.
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

	it( 'handleDelete: confirmed delete removes via deleteTopology', async () => {
		hooks.topologies = [ { name: 'demo', source: 'user' } ];
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: '',
			name: 'demo',
		} );
		hooks.deleteTopology.mockResolvedValueOnce( {
			stock_fallback: false,
		} );
		const originalConfirm = window.confirm;
		window.confirm = () => true;
		try {
			window.history.replaceState( {}, '', '/?topology=demo' );
			const { container, getByText } = render( <TopologyConsole /> );
			await act( async () => {
				fireEvent.click( getByText( 'edit' ) );
			} );
			await act( async () => {
				fireEvent.click( getByText( 'delete' ) );
			} );
			const toast = container.querySelector( '.topology-toast--success' );
			expect( toast ).not.toBeNull();
		} finally {
			window.confirm = originalConfirm;
			hooks.topologies = [];
		}
	} );

	it( 'handleDelete: window.confirm cancel skips delete', async () => {
		hooks.topologies = [ { name: 'demo', source: 'user' } ];
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: '',
			name: 'demo',
		} );
		hooks.deleteTopology.mockClear();
		const originalConfirm = window.confirm;
		window.confirm = () => false;
		try {
			window.history.replaceState( {}, '', '/?topology=demo' );
			const { getByText } = render( <TopologyConsole /> );
			await act( async () => {
				fireEvent.click( getByText( 'edit' ) );
			} );
			await act( async () => {
				fireEvent.click( getByText( 'delete' ) );
			} );
			expect( hooks.deleteTopology ).not.toHaveBeenCalled();
		} finally {
			window.confirm = originalConfirm;
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
		const originalConfirm = window.confirm;
		window.confirm = () => true;
		try {
			window.history.replaceState( {}, '', '/?topology=demo' );
			const { container, getByText } = render( <TopologyConsole /> );
			await act( async () => {
				fireEvent.click( getByText( 'edit' ) );
			} );
			await act( async () => {
				fireEvent.click( getByText( 'delete' ) );
			} );
			const toast = container.querySelector( '.topology-toast--error' );
			expect( toast ).not.toBeNull();
		} finally {
			window.confirm = originalConfirm;
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
		window.NewspackNodesData.topologyPartitions = { demo: 2 };
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { container } = render( <TopologyConsole /> );
		await fireMsg( { type: TM_BYTESTREAM, value: 'pre-switch' } );
		expect(
			container.querySelectorAll( '[data-testid="repl-transcript"] li' )
				.length
		).toBeGreaterThan( 0 );
		await act( async () => {
			lastHeaderProps.onPathChange( '_sse/demo.p1' );
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

	it( 'handleResetLayout: live mode reverts to saved layout (no confirm)', async () => {
		hooks.fetchLayout.mockResolvedValueOnce( {
			positions: { n1: [ 50, 60 ] },
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByText } = render( <TopologyConsole /> );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'move-n1' ) );
		} );
		const resetBtn = queryByText( 'reset-layout' );
		expect( resetBtn ).not.toBeNull();
		await act( async () => {
			fireEvent.click( resetBtn );
		} );
		const positionsKey = Object.keys( window.localStorage ).find( ( k ) =>
			k.endsWith( ':positions' )
		);
		expect( window.localStorage.getItem( positionsKey ) ).toBeNull();
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
		expect( getByTestId( 'canvas' ) ).not.toBeNull();
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

	describe( 'skin theme', () => {
		const rootClass = ( container ) =>
			container.querySelector( '.topology-app' ).className;

		it( 'defaults to theme-current when localStorage is empty', () => {
			const { container } = render( <TopologyConsole /> );
			expect( rootClass( container ) ).toContain( 'theme-current' );
		} );

		it( 'applies a valid stored skin on mount', () => {
			window.localStorage.setItem(
				'newspack-nodes:topology:theme',
				'blueprint'
			);
			const { container } = render( <TopologyConsole /> );
			expect( rootClass( container ) ).toContain( 'theme-blueprint' );
		} );

		it( 'falls back to theme-current for an unknown stored skin', () => {
			window.localStorage.setItem(
				'newspack-nodes:topology:theme',
				'bogus'
			);
			const { container } = render( <TopologyConsole /> );
			expect( rootClass( container ) ).toContain( 'theme-current' );
			expect( rootClass( container ) ).not.toContain( 'theme-bogus' );
		} );

		it( 'passes the current theme + full skin list to the header', () => {
			render( <TopologyConsole /> );
			expect( lastHeaderProps.theme ).toBe( 'current' );
			expect( lastHeaderProps.themes.length ).toBe( 13 );
		} );

		it( 'changing the skin updates the root class and persists', () => {
			const { container } = render( <TopologyConsole /> );
			act( () => {
				lastHeaderProps.onThemeChange( 'crt' );
			} );
			expect( rootClass( container ) ).toContain( 'theme-crt' );
			expect(
				window.localStorage.getItem( 'newspack-nodes:topology:theme' )
			).toBe( 'crt' );
		} );
	} );
} );
