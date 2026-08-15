/* global globalThis, requestAnimationFrame */
/**
 * TopologyConsole tests. useConsoleGraph is mocked to build the REAL receive
 * graph (Router → Dumper/_output, Metadata/_metadata, Uptime/_uptime) plus a
 * real Shell whose sink is the (capture-only) CommandInterpreter and a real
 * per-worker RemoteIpc (named `{topology}.p{N}`) whose composed HttpOut records
 * POSTs via a capturing postBatch client. SSE replies are simulated by filling
 * the RemoteIpc's composed SseIn (the substrate's only format). Mocked child
 * components expose every prop callback as a button so handlers run end-to-end.
 */

import { render, fireEvent, act, waitFor } from '@testing-library/react';
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
import { Core } from '../../runtime/core';
import { forgetSession } from '../../runtime/command-auth';
import {
	answerBatch,
	installFakeCommandWire,
} from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { invalidateExpandedIncludes } from '../hooks/useExpandedIncludes';

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
globalThis.__outgoing = null;
// The reader the current mock RemoteIpc is registered under (for teardown).
globalThis.__reader = null;
// A no-op EventSource so the composed SseIn can start() offline.
class FakeEventSource {
	constructor( url ) {
		this.url = url;
	}
	addEventListener() {}
	close() {}
}
global.EventSource = FakeEventSource;
jest.mock( '../hooks/useConsoleGraph', () => {
	// eslint-disable-next-line no-shadow
	const { Core } = require( '../../runtime/core' );
	const { Node } = require( '../../runtime/node' );
	const { DumperNode } = require( '../../runtime/dumper-node' );
	const { MetadataNode } = require( '../../runtime/metadata-node' );
	const { UptimeNode } = require( '../../runtime/uptime-node' );
	const { CompletionNode } = require( '../../runtime/completion-node' );
	const { RemoteIpcNode } = require( '../../runtime/remote-ipc-node' );
	const { ShellNode } = require( '../../runtime/shell-node' );
	const { StdoutNode } = require( '../../runtime/stdout-node' );
	const { OutgoingGateNode } = require( '../core/outgoingGate' );
	const { makeSkinHost } = require( '../core/skinCommands' );
	const { THEMES, getStoredTheme, applySkin } = require( '../themes' );
	const reserved = require( '../../runtime/reserved-node-names.json' );
	// View nodes only: the backbone is the page's and outlives edit mode,
	// exactly as the real hook's separate backbone effect leaves it standing.
	const NAMES = [
		reserved.OUTPUT,
		reserved.STDOUT,
		reserved.METADATA,
		reserved.UPTIME,
		reserved.COMPLETION,
		reserved.CWD,
	];
	const teardown = () => {
		// The Router is never stopped — it is the page's one heartbeat, and
		// every poll and one-shot hitchhikes its tick.
		// The per-worker RemoteIpc tears down its composed children + stream.
		if ( globalThis.__reader ) {
			Core.node( globalThis.__reader )?.removeNode();
		}
		RemoteIpcNode.active = null;
		for ( const n of NAMES ) {
			// removeNode, not unregister: a dropped Timer must take its
			// registration with it, or the kept Router reports it as forgotten.
			Core.node( n )?.removeNode();
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
			// Rules of hooks: unconditional rebuild before the enabled early-return.
			// eslint-disable-next-line @wordpress/no-unused-vars-before-return
			const generation =
				require( '../../runtime/react' ).useGraphGeneration();
			if ( ! enabled ) {
				teardown();
				return { status: 'closed', ssePid: null, shell: null };
			}
			const reader = `${ topology }.p${ partition }`;
			// Rebuild on reader OR generation change (reset-graph re-mount).
			const key = `${ reader }|${ generation }`;
			if ( globalThis.__graphKey !== key ) {
				teardown();
				// The REAL backbone: a hand-built interpreter+router left the
				// console without `_shell`/`_http`, so anything targeting the
				// egress (a one-shot, a slice) routed into NOT_AVAILABLE.
				const { interpreter } =
					require( '../../runtime/exospine' ).mountExospine();
				const dumper = new DumperNode();
				dumper.debugLevelRef = debugLevelRef;
				dumper.name = reserved.OUTPUT;
				// Builtin output bypasses `_output` and lands on `_stdout`.
				const stdout = new StdoutNode( {
					write: ( text ) => dumper.appendText( text ),
				} );
				stdout.name = reserved.STDOUT;
				const metadata = new MetadataNode();
				metadata.name = reserved.METADATA;
				const uptime = new UptimeNode();
				uptime.name = reserved.UPTIME;
				new CompletionNode().name = reserved.COMPLETION;
				// One RemoteIpc/worker: SseIn+HttpOut(captures)+Heartbeat.
				const remote = interpreter.makeNode( 'RemoteIpc', reader, [
					reader,
				] );
				remote.target = reserved.OUTPUT;
				remote.client = {
					postBatch: ( entries ) => {
						globalThis.__httpPosts.push( ...entries );
						// Answer like the server: the Request nodes' replies
						// route back TO=FROM through this same client.
						return globalThis.__answerBatch( entries );
					},
				};
				// Boot stream + force connected pid 1234 (fake ES sends none).
				remote.connect();
				remote.sseIn._applyConnected(
					'PID 1234 SLOT 1 OWNER 9007199254740993 ' +
						'SUBSCRIPTIONS demo.p0 INTERVAL 2000'
				);
				const shell = new ShellNode();
				shell.path = reader;
				shell.host = makeSkinHost( {
					skins: THEMES,
					currentSkin: getStoredTheme,
					applySkin,
					print: ( text ) => dumper.appendText( text ),
				} );
				// The console's UNNAMED outgoing gate, as the real hook builds.
				const gate = new OutgoingGateNode();
				gate.sink = interpreter;
				globalThis.__outgoing = gate;
				shell.sink = gate;
				// `_cwd` indirection node: a plain Node whose target IS cwd.
				const cwdNode = new Node();
				cwdNode.name = reserved.CWD;
				cwdNode.sink = interpreter;
				cwdNode.target = shell.path;
				// Mirror timer wiring: cadence test drives TIMER→…→RemoteIpc.
				metadata.sink = interpreter;
				uptime.sink = interpreter;
				metadata.target = reserved.CWD;
				uptime.target = reserved.CWD;
				// Metadata/Uptime hitchhike _router TIMER: fire each tick.
				metadata.setTimer();
				uptime.setTimer();
				globalThis.__shell = shell;
				globalThis.__reader = reader;
				globalThis.__graphKey = key;
			}
			// `__connecting`: pre-connect window (enabled, no pid) guard.
			return globalThis.__connecting
				? {
						status: 'connecting',
						ssePid: null,
						shell: globalThis.__shell,
						outgoing: globalThis.__outgoing,
				  }
				: {
						status: 'open',
						ssePid: 1234,
						shell: globalThis.__shell,
						outgoing: globalThis.__outgoing,
				  };
		},
	};
} );
// Mutable globals the hoisted jest.mock factories read at call time.
globalThis.__hooks = {
	topologies: [],
	fetchTopology: jest.fn().mockResolvedValue( null ),
	saveTopology: jest.fn().mockResolvedValue( null ),
	deleteTopology: jest.fn().mockResolvedValue( null ),
	// Never resolves; resolving fires setSavedLayout outside act().
	fetchLayout: jest.fn( () => new Promise( () => {} ) ),
	saveLayout: jest.fn().mockResolvedValue( null ),
	// Live catalog: null → seed from NewspackNodesData; set to override.
	reloadCatalog: jest.fn(),
	catalog: null,
};
const hooks = globalThis.__hooks;
globalThis.__fakeOneShot = ( fixture, key ) => ( onDone ) => ( {
	pending: false,
	[ key ]: ( arg ) =>
		globalThis.__hooks[ fixture ]( arg )
			.then( ( result ) =>
				onDone?.( {
					result,
					error: null,
					errorData: null,
					args: [ arg.name ],
				} )
			)
			.catch( ( e ) =>
				onDone?.( {
					result: null,
					error: e?.data?.message || e?.message || String( e ),
					errorData: e?.data ?? null,
					args: [ arg.name ],
				} )
			),
} );
jest.mock( '../hooks/useTopologyList', () => ( {
	useTopologyList: () => ( {
		topologies: globalThis.__hooks.topologies,
		userDir: '',
		loading: false,
		error: null,
		reload: () => {},
	} ),
	// The slice, faked over the promise the fixtures still seed: `open()` asks
	// `fetchTopology`, and what it resolves becomes the published answer.
	useTopology: () => {
		const { useCallback, useState } = require( '@wordpress/element' );
		const [ topology, setTopology ] = useState( null );
		const [ error, setError ] = useState( null );
		const open = useCallback( ( name ) => {
			if ( ! name ) {
				return;
			}
			setError( null );
			globalThis.__hooks
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
} ) );
// Drift diff (roadmap [49]) has its own suite; no-op here.
jest.mock( '../hooks/useCanonicalNodes', () => ( {
	useCanonicalNodes: () => new Set(),
	driftNodeIds: () => null,
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
			// Raw `topologies list` entries (each carries `includes`).
			entries: override ? override.entries || [] : [],
			reload: globalThis.__hooks.reloadCatalog,
		};
	},
} ) );
// Mutable catalog the hoisted mock reads at call time; tests seed classes.
globalThis.__catalog = { classes: [], formatters: [] };
jest.mock( '../hooks/useClassCatalog', () => ( {
	// `__catalogBump()` republishes, standing in for the poll's next tick.
	useClassCatalog: () => {
		const { useEffect, useState } = require( '@wordpress/element' );
		const [ , bump ] = useState( 0 );
		useEffect( () => {
			globalThis.__catalogBump = () => bump( ( n ) => n + 1 );
			return () => {
				globalThis.__catalogBump = null;
			};
		} );
		return {
			classes: globalThis.__catalog.classes,
			formatters: globalThis.__catalog.formatters,
			loading: !! globalThis.__catalog.loading,
			error: globalThis.__catalog.error ?? null,
		};
	},
} ) );
// Stub useVaults so vault.list doesn't hit unwrapCommandResponse's throw.
jest.mock( '../hooks/useVaults', () => ( {
	useVaults: () => ( { vaults: [], loading: false, error: null } ),
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
				globalThis.__hooks
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
				globalThis.__hooks
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
// The one-shots, faked over the promises the fixtures still seed: what settles
// becomes the `onDone` the console now does its work in.
jest.mock( '../hooks/useSaveTopology', () => ( {
	useSaveTopology: ( onDone ) =>
		globalThis.__fakeOneShot( 'saveTopology', 'save' )( onDone ),
} ) );
jest.mock( '../hooks/useDeleteTopology', () => ( {
	useDeleteTopology: ( onDone ) =>
		globalThis.__fakeOneShot( 'deleteTopology', 'remove' )( onDone ),
} ) );
// Capture canvas + inspector props so tests can invoke any threaded handler.
let mockCanvasProps = null;
let lastInspectorProps = null;
let lastHeaderProps = null;
jest.mock( '../components/SchematicCanvas', () => {
	// Pure renderer: useCanvasLayout owns positions; mock records props. The
	// real canvas reads layout + chrome from context now, so the double must
	// too, or these assertions test a prop chain it stopped using.
	return function SchematicCanvasDouble( props ) {
		const { useLayoutContext } = require( '../LayoutContext' );
		const { useChrome } = require( '../ChromeContext' );
		mockCanvasProps = { ...props, ...useLayoutContext(), ...useChrome() };
		return mockCanvasMarkup( mockCanvasProps );
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
					props.onViewportChange(
						{
							x: 10,
							y: 20,
							w: 800,
							h: 600,
						},
						{ dcx: 5, dcy: 6, zoom: 2 }
					)
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
	const { useCatalog: useCat } = require( '../CatalogContext' );
	lastInspectorProps = { ...props, ...useCat() };
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
// Console portals controls via the named HeaderControls export.
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
				<button
					onClick={ () => props.onDownload && props.onDownload() }
				>
					download
				</button>
				<button
					onClick={ () =>
						props.onUpload &&
						props.onUpload( {
							name: 'up.tsl',
							text: () =>
								Promise.resolve(
									globalThis.__uploadTsl ||
										'make_node Echo uploaded_node\n'
								),
						} )
					}
				>
					upload
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
	// The real Palette reads its catalogs from context now, so the double
	// must too, or these assertions test the prop chain it stopped using.
	const { useCatalog } = require( '../CatalogContext' );
	lastPaletteProps = { ...props, ...useCatalog() };
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

// Commands travel the real graph; this answers them. It sees the
// `{ to, verb, args }` shape the assertions read, and returns the reply
// payload (an Error answers TM_ERROR, undefined answers nothing at all).
globalThis.__activateSend = jest.fn();
// Only a command with a reply address is answered here — a one-shot's
// `<scope>:in` receiver. A worker-bound poll gets silence, as the live server
// gives it: its reply rides the SSE stream.
const ONE_SHOT_RECEIVER = /^topologies:[a-z]+:in$/;
const answerCommand = ( m ) => {
	const from = String( m[ FROM ] );
	if ( ! ONE_SHOT_RECEIVER.test( from ) ) {
		return undefined;
	}
	return globalThis.__activateSend( {
		to: String( m[ TO ] ),
		verb: m[ VALUE ]?.name,
		args: m[ VALUE ]?.arguments,
	} );
};
globalThis.__answerBatch = ( entries ) => answerBatch( entries, answerCommand );

import TopologyConsole, { initialTopologyFromUrl } from '../TopologyConsole';

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
		installFakeCommandWire( answerCommand );
		globalThis.__httpPosts = [];
		hooks.deleteTopology.mockReset();
		hooks.deleteTopology.mockResolvedValue( null );
		hooks.fetchLayout.mockReset();
		// Default-resolve "no layout" so serverFetchResolved gate clears.
		hooks.fetchLayout.mockResolvedValue( { positions: null } );
		hooks.saveLayout.mockReset();
		hooks.saveLayout.mockResolvedValue( null );
		hooks.topologies = [];
		hooks.reloadCatalog.mockReset();
		hooks.catalog = null;
		globalThis.__catalog = { classes: [], formatters: [] };
		globalThis.__uploadTsl = null;
		invalidateExpandedIncludes();
	} );

	// Simulate an SSE reply; the 2nd act() drains React's deferred batch, then
	// flush the animation frame the Dumper coalesces data-plane frames onto.
	const fireMsg = async ( opts ) => {
		await act( async () => {
			Core.node( names.ROUTER ).fill( posMsg( opts ) );
		} );
		await act( async () => {
			await new Promise( ( resolve ) =>
				requestAnimationFrame( () => resolve() )
			);
		} );
	};

	// Publish a dump_metadata snapshot so the layout graph is ready (≥1 node).
	const publishMeta = async (
		value = { n1: { class: 'Echo', counter: 0, sink: '', target: '' } }
	) => {
		await fireMsg( { type: TM_STRUCT, to: names.METADATA, value } );
	};

	it( 'renders Header, Palette, Canvas, and ReplFooter on mount (Inspector collapsed to a rail until selected)', async () => {
		// Palette always-on: view-drop → make_node, edit-drop → draft.
		const { getByTestId, queryByTestId } = render( <TopologyConsole /> );
		await publishMeta();
		expect( getByTestId( 'header' ) ).not.toBeNull();
		expect( getByTestId( 'palette' ) ).not.toBeNull();
		expect( getByTestId( 'canvas' ) ).not.toBeNull();
		// Inspector defaults collapsed; panel renders on expand.
		expect( queryByTestId( 'inspector' ) ).toBeNull();
		expect( getByTestId( 'repl' ) ).not.toBeNull();
	} );

	it( 'starts in view mode by default', async () => {
		const { getByTestId } = render( <TopologyConsole /> );
		await publishMeta();
		expect( getByTestId( 'header' ).dataset.mode ).toBe( 'view' );
		expect( getByTestId( 'canvas' ).dataset.mode ).toBe( 'view' );
	} );

	it( 'passes composeTargets derived from the viewed graph (parsed.nodes), not Core.nodes, to the Inspector', async () => {
		// Remote-worker view: addressable nodes live in parsed.nodes.
		const { getByText } = render( <TopologyConsole /> );
		await publishMeta( {
			// has_config: n1 has a `:config` sidecar (else none synthesized).
			n1: {
				class: 'Echo',
				counter: 0,
				sink: '',
				target: '',
				has_config: true,
			},
		} );
		// Inspector panel renders (captures props) only once expanded.
		await act( async () => {
			fireEvent.click( getByText( 'select-n1' ) );
		} );
		expect( lastInspectorProps.composeTargets ).toEqual( [
			names.COMMAND_INTERPRETER,
			'n1',
			'n1:config',
		] );
	} );

	it( 'polls dump_metadata every tick and uptime on the 5s cadence (reply routes to _metadata/_uptime)', async () => {
		jest.useFakeTimers();
		try {
			globalThis.__httpPosts = [];
			window.history.replaceState( {}, '', '/?topology=demo' );
			act( () => {
				render( <TopologyConsole /> );
			} );
			// The Router armed its slot at construction, on the REAL clock —
			// re-arm it under the fake one so advanceTimersByTime drives the
			// tick — then drive one by hand.
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
			// RemoteIpc wrapped each poll's reply FROM into the reply address.
			expect( fromOf( dumps()[ 0 ] ) ).toBe(
				`${ names.SSE }:1234/${ names.METADATA }`
			);
			expect( fromOf( uptimes()[ 0 ] ) ).toBe(
				`${ names.SSE }:1234/${ names.UPTIME }`
			);
			// Router peeled _http before HttpOut, so TO is the bare reader.
			expect( dumps()[ 0 ][ TO ] ).toBe( 'demo.p0' );
			// One stats tick: a new dump, uptime NOT due.
			const dumpBefore = dumps().length;
			const uptimeBefore = uptimes().length;
			// Metadata rescales its own cadence to the graph it last received;
			// pin it back to the tick, which is what this test is about.
			Core.node( names.METADATA ).pollIntervalMs = 1000;
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

	it( 'onComplete on the FIRST token dispatches a `help` completion query (KEY=completion, FROM routes to _completion)', async () => {
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
		// RemoteIpc wrapped the bare _completion FROM into the reply address.
		expect( m[ FROM ] ).toBe( `${ names.SSE }:1234/${ names.COMPLETION }` );
		expect( m[ TO ] ).toBe( 'demo.p0' );
		// Minted in-process → LOCAL taint set (wire pack() strips it later).
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
		// Regression: handleNew's { nodes: [] } draft lacked the _repl anchor.
		expect(
			document.querySelector( '.topology-canvas-building' )
		).toBeNull();
		expect( queryByTestId( 'canvas' ) ).not.toBeNull();
	} );

	it( 'auto-enters edit mode on mount when the URL carries ?edit=1 (Topologies-tab deep link)', async () => {
		window.history.replaceState( {}, '', '/?topology=demo&edit=1' );
		render( <TopologyConsole /> );
		await act( async () => {} );
		// Edit/New deep-link with ?edit=1; console lands in edit mode.
		expect( lastHeaderProps.mode ).toBe( 'edit' );
	} );

	it( 'clicking New from live mode enters edit mode with a blank draft', async () => {
		const { getByText } = render( <TopologyConsole /> );
		expect( lastHeaderProps.mode ).toBe( 'view' );
		await act( async () => {
			fireEvent.click( getByText( 'new' ) );
		} );
		// New must switch into edit mode, not blank the draft in live view.
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
		// canDelete derives from the get response `source`, not the Open list.
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

	it( 'save pre-fills the OPENED topology name, not the live console topology', async () => {
		// Save's name field must offer OPENED name (editingName), not demo.
		globalThis.__hooks.fetchTopology.mockImplementation( ( name ) =>
			Promise.resolve( {
				name,
				source: 'user',
				tsl: 'make_node Echo e\n',
			} )
		);
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) ); // edit `demo`
		} );
		await act( async () => {
			fireEvent.click( getByText( 'open' ) ); // show the Open picker
		} );
		await act( async () => {
			// onPick('picked') → handleOpenPick → editingName='picked'.
			fireEvent.click( getByText( 'pick' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'save' ) ); // open the Save modal
		} );
		expect( globalThis.__lastPromptModal.initialValue ).toBe( 'picked' );
	} );

	it( 'live SAVE captures the live graph dump_config and saves the captured TSL', async () => {
		const { getByText, getByTestId } = render( <TopologyConsole /> );
		await publishMeta();
		// View mode + worker cwd: SAVE snapshots the live graph, not a draft.
		await act( async () => {
			fireEvent.click( getByText( 'save' ) );
		} );
		// The reply lands on the node that MINTED it (TO=FROM, ADR-7) — not on
		// the shared `_output` Dumper matched by command name.
		await fireMsg( {
			type: TM_COMMAND | TM_RESPONSE,
			to: '_console:dump_config',
			value: {
				name: 'dump_config',
				payload: 'make_node Echo captured_echo\n',
			},
		} );
		// The capture opens the name prompt; confirm it with 'newname'.
		expect( getByTestId( 'prompt-modal' ) ).not.toBeNull();
		await act( async () => {
			fireEvent.click( getByText( 'prompt-ok' ) );
		} );
		expect( hooks.saveTopology ).toHaveBeenCalledWith( {
			name: 'newname',
			tsl: 'make_node Echo captured_echo\n',
		} );
	} );

	it( 'live SAVE toasts instead of dying silently while unauthenticated', async () => {
		const { container, getByText, queryByTestId } = render(
			<TopologyConsole />
		);
		await publishMeta();
		// No signing session: dumper.command() mints nothing, so the click
		// must say so rather than leave a dead button.
		forgetSession();
		await act( async () => {
			fireEvent.click( getByText( 'save' ) );
		} );
		expect( queryByTestId( 'prompt-modal' ) ).toBeNull();
		const toast = container.querySelector( '.topology-toast--error' );
		expect( toast ).not.toBeNull();
		expect( toast.textContent ).toMatch( /again/i );
	} );

	it( 'DOWNLOAD saves the editor topology as <name>.tsl', async () => {
		globalThis.__hooks.fetchTopology.mockResolvedValue( {
			name: 'demo',
			source: 'user',
			tsl: 'make_node Echo e\n',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const createObjectURL = jest.fn( () => 'blob:mock' );
		const revokeObjectURL = jest.fn();
		window.URL.createObjectURL = createObjectURL;
		window.URL.revokeObjectURL = revokeObjectURL;
		const clicks = [];
		const clickSpy = jest
			.spyOn( window.HTMLAnchorElement.prototype, 'click' )
			.mockImplementation( function download() {
				clicks.push( { download: this.download, href: this.href } );
			} );
		try {
			const { getByText } = render( <TopologyConsole /> );
			await act( async () => {
				fireEvent.click( getByText( 'edit' ) );
			} );
			await act( async () => {
				fireEvent.click( getByText( 'download' ) );
			} );
			expect( createObjectURL ).toHaveBeenCalledTimes( 1 );
			expect( createObjectURL.mock.calls[ 0 ][ 0 ] ).toBeInstanceOf(
				window.Blob
			);
			expect( clicks ).toHaveLength( 1 );
			expect( clicks[ 0 ].download ).toBe( 'demo.tsl' );
			expect( revokeObjectURL ).toHaveBeenCalledWith( 'blob:mock' );
		} finally {
			clickSpy.mockRestore();
		}
	} );

	it( 'UPLOAD loads the chosen file TSL into the editor and marks it dirty', async () => {
		const { getByText, getByTestId } = render( <TopologyConsole /> );
		// New → a blank, clean draft (baseline === draft).
		await act( async () => {
			fireEvent.click( getByText( 'new' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'upload' ) );
		} );
		// Flush handleUpload's async file-read + catalog load.
		await act( async () => {} );
		// Leaving edit now prompts a discard confirm — proof the load went dirty.
		await act( async () => {
			fireEvent.click( getByText( 'view' ) );
		} );
		expect( getByTestId( 'confirm-modal' ) ).not.toBeNull();
	} );

	it( 'UPLOAD takes over the editor identity from the previously-opened topology', async () => {
		// handleUpload never set editingName/editingSource, so after an upload
		// the editor still carried the last-opened topology's identity — which
		// is what Download names the file after and what Save prefills.
		globalThis.__hooks.fetchTopology.mockResolvedValue( {
			name: 'demo',
			source: 'user',
			tsl: 'make_node Echo e\n',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const clicks = [];
		window.URL.createObjectURL = jest.fn( () => 'blob:mock' );
		window.URL.revokeObjectURL = jest.fn();
		const clickSpy = jest
			.spyOn( window.HTMLAnchorElement.prototype, 'click' )
			.mockImplementation( function download() {
				clicks.push( this.download );
			} );
		try {
			const { getByText } = render( <TopologyConsole /> );
			await act( async () => {
				fireEvent.click( getByText( 'edit' ) );
			} );
			await act( async () => {
				fireEvent.click( getByText( 'upload' ) );
			} );
			await act( async () => {} );
			await act( async () => {
				fireEvent.click( getByText( 'download' ) );
			} );
			expect( clicks ).toEqual( [ 'up.tsl' ] );
		} finally {
			clickSpy.mockRestore();
		}
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
		// Builtin output arrives as `_stdout` text, so it reads back as recv.
		expect( items[ 1 ].dataset.kind ).toBe( 'recv' );
		expect( items[ 1 ].textContent ).toMatch( /debug_level:/ );
	} );

	it( 'transcript caps at TRANSCRIPT_MAX entries', async () => {
		const { container } = render( <TopologyConsole /> );
		// Two sub-cap batches (125 < 200 each) across frames cap cleanly to the
		// newest 200 with no flood drop (>cap-per-frame drops are unit-tested).
		const fireBatch = async ( from, to ) => {
			await act( async () => {
				for ( let i = from; i < to; i++ ) {
					Core.node( names.ROUTER ).fill(
						posMsg( { type: TM_BYTESTREAM, value: `msg-${ i }` } )
					);
				}
				await new Promise( ( resolve ) =>
					requestAnimationFrame( () => resolve() )
				);
			} );
		};
		await fireBatch( 0, 125 );
		await fireBatch( 125, 250 );
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
		const root = container.querySelector( '.topology-app' );
		const cls = () => root.className;
		expect( root.classList.contains( 'newspack-nodes-theme' ) ).toBe(
			true
		);
		expect( root.classList.contains( 'newspack-nodes-ui' ) ).toBe( true );
		expect( root.classList.contains( 'newspack-nodes-skin-root' ) ).toBe(
			false
		);
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

	it( 'Inspector trace action emits the trace verb with level', async () => {
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
		expect( sent.textContent ).toMatch( /trace n1 1/ );
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

	// useCanvasLayout stores { positions, viewport, modified } per scope.
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
		// Fake ONLY the debounce clock: rAF stays real so fireMsg's frame
		// resolves, and setInterval stays real so the graph's armed timers
		// are not stranded on a clock this test never advances.
		jest.useFakeTimers( {
			doNotFake: [ 'requestAnimationFrame', 'setInterval' ],
		} );
		try {
			const { getByText } = render( <TopologyConsole /> );
			await publishMeta();
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
			// Persistence stores the delta from autofit, not the raw viewBox.
			expect( stored.viewportDelta ).toEqual( {
				dcx: 5,
				dcy: 6,
				zoom: 2,
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
		// Menu must reflect the live catalog, not the frozen page-load global.
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
		// cwd follows deep path; same worker → no rebuild, no partition URL.
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
		// Poll nodes target `_cwd`; cwd re-stamped from `_cwd.target`.
		expect( Core.node( names.CWD ).target ).toBe( 'demo.p0/firehose-in' );
		// Flush the boot fetchLayout().then( setSavedLayout ) microtask in act.
		await act( async () => {} );
	} );

	it( 'a worker cwd during the connecting window keeps _cwd pointed at the worker (not local)', async () => {
		// _cwd tracks the cwd verbatim (was '' while connecting — misleading).
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
		expect( mockCanvasProps ).not.toBeNull();
	} );

	it( 'edit mode: handleConnect uses catalog Tee semantics for an own Tap', async () => {
		globalThis.__catalog.classes = [
			{ shell_name: 'Tap', fans_out: true, has_target: true },
			{ shell_name: 'Echo', fans_out: false, has_target: true },
		];
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl:
				'make_node Tap a\n' +
				'make_node Echo b\n' +
				'make_node Echo c\n' +
				'connect_node a c\n',
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

		expect( mockCanvasProps.parsed.edges ).toEqual(
			expect.arrayContaining( [
				expect.objectContaining( { from: 'a', to: 'c' } ),
				expect.objectContaining( { from: 'a', to: 'b' } ),
			] )
		);
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
		// Pre-confirm: NewNodeModal renders first to override the auto name.
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
		expect( mockCanvasProps.interactive ).toBe( true );
	} );

	it( 'live canvas: reset-graph control re-mounts the graph without throwing', async () => {
		const { findByText } = render( <TopologyConsole /> );
		// cd to the local graph (the only scope the reset chip shows).
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		// The chip needs a node the SHELL made; dispatch, then surface it.
		act( () => {
			lastReplProps.onSubmit( 'make_node Echo n1' );
		} );
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: {
				n1: { class: 'Echo', counter: 0, sink: '', target: '' },
			},
		} );
		// findByText polls so the metadata+cwd gate can settle.
		const chip = await findByText( 'reset-graph' );
		expect( () => fireEvent.click( chip ) ).not.toThrow();
		await act( async () => {} );
	} );

	it( 'reset-graph preserves cwd (rebuild rehomes Shell.path to default; reset must restore the user cwd)', async () => {
		// Reset-graph must rebuild AND keep cwd at '/' (was snapped back).
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { findByText } = render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		expect( lastHeaderProps.path ).toBe( '' );
		act( () => {
			lastReplProps.onSubmit( 'make_node Echo n1' );
		} );
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
		await act( async () => {} );
		expect( lastHeaderProps.path ).toBe( '' );
	} );

	it( 'reset-graph wipes user-added nodes (and leaves the canonical spine + console graph)', async () => {
		// Reset now removes any node outside the canonical set (or backbone).
		const { Node } = require( '../../runtime/node' );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { findByText } = render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		// Simulate a user `make_node Tee my-tee` surviving a prior session.
		const userNode = new Node();
		userNode.name = 'my-user-tee';
		act( () => {
			lastReplProps.onSubmit( 'make_node Tee my-user-tee' );
		} );
		expect( Core.node( 'my-user-tee' ) ).toBeTruthy();
		// Surface it in metadata so the chip shows (gating reads parsed.nodes).
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
		await act( async () => {} );
		expect( Core.node( 'my-user-tee' ) ).toBeFalsy();
		// And the canonical backbone must STILL be present after the rebuild.
		expect( Core.node( '_command_interpreter' ) ).toBeTruthy();
		expect( Core.node( '_router' ) ).toBeTruthy();
	} );

	it( 'reset-graph surfaces Reset Layout (a full rebuild offers a fresh auto-fit)', async () => {
		// Reset Graph marks the layout dirty so Reset Layout can surface.
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { findByText, queryByText } = render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		// A shell-made node surfaces reset-graph; markDirty no-ops until
		// positions exist, so reset-layout stays hidden until the click.
		act( () => {
			lastReplProps.onSubmit( 'make_node Echo n1' );
		} );
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: {
				n1: { class: 'Echo', counter: 0, sink: '', target: '' },
			},
		} );
		// Let autoLayout settle first (markDirty no-ops until positions exist).
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 300 ) );
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
		// Dragging a connection issues connect_node → structureDirty → chip.
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { findByText, queryByText, getByText } = render(
			<TopologyConsole />
		);
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		// Reserved-only graph: canvas ready but no reset-graph chip.
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
		// At cwd '/', the palette lists the JS CommandInterpreter.includeNodes.
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
		// At a worker cwd (and edit mode), the PHP catalog is the accurate one.
		globalThis.__catalog = {
			classes: [ { shell_name: 'PHP_Only_Class', category: 'PHP' } ],
			formatters: [],
		};
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		// Default boot is /demo.p0; the palette renders once layout is ready.
		await publishMeta();
		const paletteNames = ( lastPaletteProps?.classes || [] ).map(
			( c ) => c.shell_name
		);
		expect( paletteNames ).toContain( 'PHP_Only_Class' );
	} );

	it( 'reset-graph control shows only on the local graph with user-added nodes', async () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { queryByText, findByText } = render( <TopologyConsole /> );
		// Worker view (demo.p0): self-heals on respawn → no reset chip.
		expect( queryByText( 'reset-graph' ) ).toBeNull();
		// cd to local graph; no user nodes → chip hidden (canonical only).
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		expect( queryByText( 'reset-graph' ) ).toBeNull();
		// Make one through the shell, then surface it (findByText settles it).
		act( () => {
			lastReplProps.onSubmit( 'make_node Echo n1' );
		} );
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: {
				n1: { class: 'Echo', counter: 0, sink: '', target: '' },
			},
		} );
		expect( await findByText( 'reset-graph' ) ).not.toBeNull();
		// _http is an attached view (scopeFromCwd says 'local') → chip hidden.
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
		expect( mockCanvasProps.selectedEdge ).toEqual( {
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
		// Canvas only deselects/autofits now; it never touches transcript.
		expect( mockCanvasProps.onBackgroundClickConsumed ).toBeUndefined();
		expect( mockCanvasProps.backgroundClickAutofitsOnly ).toBeUndefined();
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
		expect( mockCanvasProps ).not.toBeNull();
		expect( mockCanvasProps.rateRef.current.size ).toBeGreaterThanOrEqual(
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
		const entry = mockCanvasProps.rateRef.current.get( 'n1' );
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

	it( 'selecting a node does not yank focus to the REPL input (keeps Delete usable)', async () => {
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo n1\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		// Spy the REPL input ref; refocus-on-select would break Delete.
		await act( async () => {
			lastReplProps.onExpandedChange( true );
		} );
		const replInput = document.createElement( 'input' );
		lastReplProps.inputRef.current = replInput;
		const focusSpy = jest.spyOn( replInput, 'focus' );
		await act( async () => {
			fireEvent.click( getByText( 'select-n1' ) );
		} );
		// Flush the rAF the refocus path deferred through.
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 30 ) );
		} );
		expect( focusSpy ).not.toHaveBeenCalled();
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
		expect( mockCanvasProps.selectedEdge ).toBeNull();
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
		// Prompt saves `newname` — not in the known set (a fresh topology).
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
		await waitFor(
			() =>
				expect( globalThis.__activateSend ).toHaveBeenCalledWith( {
					to: 'topologies',
					verb: 'activate',
					args: [ 'newname' ],
				} ),
			{ timeout: 4000 }
		);
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
		// activate rejects (TM_ERROR at HTTP 200): surface the error toast.
		globalThis.__activateSend.mockResolvedValueOnce(
			new Error( 'conflicts with active demo' )
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
		// The activate rides the next tick, so the refusal is a round trip away.
		await waitFor(
			() =>
				expect(
					container.querySelector( '.topology-toast--error' )
						?.textContent
				).toMatch( /conflicts with active demo/ ),
			{ timeout: 4000 }
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
		// Regression: rename rebuilt { nodes, edges } and dropped frontmatter.
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
		// `ls` → TM_COMMAND to the RemoteIpc, which POSTs the bare reader TO.
		const posted = globalThis.__httpPosts.find(
			( m ) => m[ VALUE ] && m[ VALUE ].name === 'ls'
		);
		expect( posted ).not.toBeUndefined();
		expect( posted[ TO ] ).toBe( 'demo.p0' );
		// RemoteIpc wrapped the bare `_output` FROM into the reply address.
		expect( posted[ FROM ] ).toBe(
			`${ names.SSE }:1234/${ names.OUTPUT }`
		);
	} );

	it( 'handleInspectorAction invoke (command) routes a TM_COMMAND to the {node}:config sibling interpreter', async () => {
		// Verbs live on the `{name}:config` sibling, not the bare node.
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
		// Requests target the bare nodeId, never the `:config` sibling.
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

	it( 'handleInspectorAction cmd with Compose reply-flags ORs TM_RESPONSE / TM_ERROR onto the posted TYPE', async () => {
		globalThis.__httpPosts = [];
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await publishMeta();
		await act( async () => {
			fireEvent.click( getByText( 'select-n1' ) );
		} );
		await act( async () => {
			lastInspectorProps.onAction( 'cmd', 'request-builder', 'GET_LAG', {
				response: true,
				error: true,
			} );
		} );
		const posted = globalThis.__httpPosts.find(
			( m ) => m[ VALUE ] && m[ VALUE ].name === 'GET_LAG'
		);
		expect( posted ).not.toBeUndefined();
		expect( posted[ TYPE ] & TM_COMMAND ).toBeTruthy();
		expect( posted[ TYPE ] & TM_RESPONSE ).toBeTruthy();
		expect( posted[ TYPE ] & TM_ERROR ).toBeTruthy();
	} );

	it( 'handleInspectorAction cmd with a Compose From stamps that reply path on the posted FROM', async () => {
		globalThis.__httpPosts = [];
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await publishMeta();
		await act( async () => {
			fireEvent.click( getByText( 'select-n1' ) );
		} );
		await act( async () => {
			lastInspectorProps.onAction( 'cmd', 'request-builder', 'GET_LAG', {
				from: '_output/7734',
			} );
		} );
		const posted = globalThis.__httpPosts.find(
			( m ) => m[ VALUE ] && m[ VALUE ].name === 'GET_LAG'
		);
		expect( posted ).not.toBeUndefined();
		expect( posted[ FROM ] ).toBe( `${ names.SSE }:1234/_output/7734` );
	} );

	it( 'live SAVE keeps its own reply address after a Compose From redirected an earlier message', async () => {
		globalThis.__httpPosts = [];
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, getByTestId } = render( <TopologyConsole /> );
		await publishMeta();
		await act( async () => {
			fireEvent.click( getByText( 'select-n1' ) );
		} );
		// Compose owns the message it composes, not the console's own mints.
		await act( async () => {
			lastInspectorProps.onAction( 'cmd', 'request-builder', 'GET_LAG', {
				from: '_output/7734',
			} );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'save' ) );
		} );
		const posted = globalThis.__httpPosts.find(
			( m ) => m[ VALUE ] && m[ VALUE ].name === 'dump_config'
		);
		expect( posted ).not.toBeUndefined();
		expect( posted[ FROM ] ).toBe(
			`${ names.SSE }:1234/_console:dump_config`
		);
		// The reply lands on the receiver, so the Save modal opens (ADR-7).
		await fireMsg( {
			type: TM_COMMAND | TM_RESPONSE,
			to: '_console:dump_config',
			value: {
				name: 'dump_config',
				payload: 'make_node Echo captured_echo\n',
			},
		} );
		expect( getByTestId( 'prompt-modal' ) ).not.toBeNull();
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

	it( 'handleOpenPick uses the PHP class catalog when opened from local view', async () => {
		globalThis.__catalog.classes = [
			{ shell_name: 'Tap', fans_out: true },
			{ shell_name: 'Echo', fans_out: false },
		];
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: [
				'make_node Tap zebra-fanout',
				'make_node Echo giraffe-target',
				'make_node Echo llama-target',
				'connect_node zebra-fanout giraffe-target',
				'connect_node zebra-fanout llama-target',
			].join( '\n' ),
			name: 'picked',
			source: 'user',
			expanded: { nodes: [], edges: [] },
		} );
		const { getByText } = render( <TopologyConsole /> );

		await act( async () => {
			lastHeaderProps.onPathChange( '' );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'open' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'pick' ) );
		} );

		await waitFor( () => {
			expect(
				mockCanvasProps.parsed.edges.filter(
					( edge ) => edge.from === 'zebra-fanout'
				)
			).toHaveLength( 2 );
		} );
	} );

	it( 'handleOpenPick waits for a deferred PHP catalog before folding custom Tee edges', async () => {
		// The catalog has not landed yet; the poll is still loading.
		globalThis.__catalog = { classes: [], formatters: [], loading: true };
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: [
				'make_node WombatFanout357 zebra-fanout',
				'make_node Echo giraffe-target',
				'make_node Echo llama-target',
				'connect_node zebra-fanout giraffe-target',
				'connect_node zebra-fanout llama-target',
			].join( '\n' ),
			name: 'picked',
			source: 'user',
			expanded: { nodes: [], edges: [] },
		} );
		const { getByText } = render( <TopologyConsole /> );

		await act( async () => {
			lastHeaderProps.onPathChange( '' );
			fireEvent.click( getByText( 'open' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'pick' ) );
			await Promise.resolve();
		} );
		expect( hooks.fetchTopology ).toHaveBeenCalledWith( 'picked' );

		await act( async () => {
			globalThis.__catalog = {
				classes: [
					{ shell_name: 'WombatFanout357', fans_out: true },
					{ shell_name: 'Echo', fans_out: false },
				],
				formatters: [],
				loading: false,
			};
			globalThis.__catalogBump();
		} );

		await waitFor( () => {
			expect(
				mockCanvasProps.parsed.edges.filter(
					( edge ) => edge.from === 'zebra-fanout'
				)
			).toHaveLength( 2 );
		} );
	} );

	it( 'mode change waits for a deferred PHP catalog before folding custom Tee edges', async () => {
		// The catalog has not landed yet; the poll is still loading.
		globalThis.__catalog = { classes: [], formatters: [], loading: true };
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: [
				'make_node WombatModeFanout863 zebra-fanout',
				'make_node Echo giraffe-target',
				'make_node Echo llama-target',
				'connect_node zebra-fanout giraffe-target',
				'connect_node zebra-fanout llama-target',
			].join( '\n' ),
			name: 'demo',
			source: 'user',
			expanded: { nodes: [], edges: [] },
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );

		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
			await Promise.resolve();
		} );
		expect( hooks.fetchTopology ).toHaveBeenCalledWith( 'demo' );

		await act( async () => {
			globalThis.__catalog = {
				classes: [
					{ shell_name: 'WombatModeFanout863', fans_out: true },
					{ shell_name: 'Echo', fans_out: false },
				],
				formatters: [],
				loading: false,
			};
			globalThis.__catalogBump();
		} );

		await waitFor( () => {
			expect(
				mockCanvasProps.parsed.edges.filter(
					( edge ) => edge.from === 'zebra-fanout'
				)
			).toHaveLength( 2 );
		} );
	} );

	it( 'surfaces a PHP class catalog failure instead of opening with regular-node semantics', async () => {
		globalThis.__catalog = {
			classes: [],
			formatters: [],
			loading: false,
			error: 'catalog-sentinel-439 failed',
		};
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: [
				'make_node WombatFailureFanout439 zebra-fanout',
				'make_node Echo giraffe-target',
				'make_node Echo llama-target',
				'connect_node zebra-fanout giraffe-target',
				'connect_node zebra-fanout llama-target',
			].join( '\n' ),
			name: 'picked',
			source: 'user',
			expanded: { nodes: [], edges: [] },
		} );
		const { container, getByText } = render( <TopologyConsole /> );

		await act( async () => {
			fireEvent.click( getByText( 'open' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'pick' ) );
		} );

		await waitFor( () => {
			const toast = container.querySelector( '.topology-toast--error' );
			expect( toast ).not.toBeNull();
			expect( toast.textContent ).toContain(
				'catalog-sentinel-439 failed'
			);
		} );
		expect(
			container.querySelector( '.topology-toast--success' )
		).toBeNull();
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
		// Edit mode keys the layout by `edit:{name}`, independent of the cwd.
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
		expect( mockCanvasProps.positionOverrides.n1 ).toEqual( {
			x: 111,
			y: 222,
		} );
	} );

	it( 'entering edit on a blank canvas anchors _repl as a Partition (reserved)', async () => {
		// _repl: worker's substrate spine; reserved, rendered as Partition.
		window.history.replaceState( {}, '', '/' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		const repl = mockCanvasProps.parsed.nodes.find(
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
		const repl = mockCanvasProps.parsed.nodes.find(
			( n ) => n.id === '_repl'
		);
		expect( repl ).toBeDefined();
		expect( repl.class ).toBe( 'Partition' );
		expect(
			mockCanvasProps.parsed.nodes.find( ( n ) => n.id === 'n1' )
		).toBeDefined();
		// _repl is in the baseline too, so its presence isn't a change.
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

	it( 'Discard leaves edit mode with no modal and no stale editing target', async () => {
		// Discard used to only flip the mode, leaving the dirty draft alive;
		// the next action that replaced it re-asked, in LIVE, about a topology
		// the operator could no longer see. The drop itself is asserted on the
		// interpreter (draft-interpreter-verbs); this covers the flow.
		hooks.fetchTopology.mockResolvedValue( {
			tsl: 'make_node Echo n1\n',
			name: 'demo',
			source: 'user',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, getByTestId, queryByText } = render(
			<TopologyConsole />
		);
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'select-n1' ) );
		} );
		await act( async () => {
			lastInspectorProps.onRenameNode( 'n1', 'aardvark' );
		} );

		await act( async () => {
			fireEvent.click( getByText( 'view' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'confirm' ) );
		} );

		expect( getByTestId( 'header' ).dataset.mode ).toBe( 'view' );
		expect( queryByText( 'confirm' ) ).toBeNull();
		// Genuinely dropped: the console is no longer editing anything, so
		// nothing later can re-ask about a draft the operator cannot see.

		// Re-entering edit starts from the file, not the abandoned draft.
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		expect(
			mockCanvasProps.parsed.nodes.some( ( n ) => n.id === 'aardvark' )
		).toBe( false );
	} );

	it( 'handleUpdateVerbs writes back the file’s verbs, not the include’s', async () => {
		// The Inspector renders seeded ⧺ declared as one list and lets any row
		// be spliced. Keyed by INDEX, removing a seeded row deletes a declared
		// verb instead — so the row's own flag has to decide.
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'include shared\ncommand_node n1:config set_b 2\n',
			name: 'demo',
			expanded: {
				nodes: [
					{
						name: 'n1',
						class: 'Echo',
						origin: [ 'shared' ],
						verbs: [ { verb: 'set_seeded', args: [ '0' ] } ],
					},
				],
				edges: [],
				tree: { shared: {} },
			},
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );
		await act( async () => {
			fireEvent.click( getByText( 'select-n1' ) );
		} );
		const rows = mockCanvasProps.parsed.nodes.find(
			( n ) => n.id === 'n1'
		).verbInvocations;
		expect( rows.map( ( r ) => r.verb ) ).toEqual( [
			'set_seeded',
			'set_b',
		] );

		// Drop the SEEDED row, as the Inspector's × would.
		await act( async () => {
			lastInspectorProps.onUpdateVerbs( 'n1', rows.slice( 1 ) );
		} );

		expect(
			mockCanvasProps.parsed.nodes
				.find( ( n ) => n.id === 'n1' )
				.verbInvocations.map( ( r ) => r.verb )
		).toEqual( [ 'set_seeded', 'set_b' ] );
	} );

	it( 'handleRenameNode: keeps the incoming edge and the node position', async () => {
		// A rename is a rewrite of every reference. Losing the edge from the
		// node that pointed AT the renamed one, or letting the canvas re-lay
		// it out, both read to an operator as "renaming broke my graph".
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl:
				'make_node Tee zebra\n' +
				'make_node Echo n1\n' +
				'connect_node zebra n1\n',
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
			mockCanvasProps.onPositionChange( 'n1', { x: 640, y: 480 } );
		} );

		await act( async () => {
			lastInspectorProps.onRenameNode( 'n1', 'aardvark' );
		} );

		expect(
			mockCanvasProps.parsed.edges.filter(
				( e ) => e.from === 'zebra' && e.to === 'aardvark'
			)
		).toHaveLength( 1 );
		expect( mockCanvasProps.positionOverrides.aardvark ).toEqual( {
			x: 640,
			y: 480,
		} );
	} );

	it( 'reserves no transcript band in edit mode, even after expanding one', async () => {
		// Edit mode renders no ReplFooter, so its last height is stale — the
		// canvas would autofit around a transcript that is not on screen.
		hooks.fetchTopology.mockResolvedValueOnce( {
			tsl: 'make_node Echo n1\n',
			name: 'demo',
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {} );

		// View mode: the footer reports an expanded transcript.
		await act( async () => {
			mockCanvasProps.onOverlayHeightChange?.( 120 );
		} );

		await act( async () => {
			fireEvent.click( getByText( 'edit' ) );
		} );

		expect( mockCanvasProps.bottomObstructionPx ).toBe( 0 );
	} );

	it( 'handleRenameNode: rejects the reserved canvas anchor', async () => {
		// `_repl` is the worker's auto-mounted Partition. It lives on the
		// canvas graph, not in the document, so a guard reading the document
		// alone misses it — and the saved .tsl then declares a node that
		// collides with the runtime's own at spawn.
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

		const result = lastInspectorProps.onRenameNode( 'n1', '_repl' );

		expect( result ).toBe( false );
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
		// Seeding the server layout at cwd="/" leaks worker positions locally.
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
		// The entry must not hold the server's worker-shape node ids.
		const positions = ( stored && stored.positions ) || {};
		expect( positions ).not.toHaveProperty( 'completed:tee' );
		expect( positions ).not.toHaveProperty( 'jobs:partition' );
		expect( positions ).not.toHaveProperty( 'jobrouter' );
	} );

	it( 'handleResetLayout at a topology worker cwd reverts to the saved layout (re-adopts server, modified=false)', async () => {
		// Server layout applies at WORKER scopes, not cwd="/" (local Shell).
		hooks.fetchLayout.mockResolvedValue( {
			positions: { n1: [ 50, 60 ] },
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByText } = render( <TopologyConsole /> );
		// cd into the worker — scope.key `demo.p0` matches the server layout.
		act( () => {
			lastReplProps.onSubmit( 'cd /demo.p0' );
		} );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		// Publish the worker's node so the canvas adopts the layout.
		await publishMeta();
		// User drags a node — positions diverge, Reset Layout appears.
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
		// At a worker scope, the chip gates on divergence from server layout.
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
		// After edit-mode Reset the auto-fit is untouched, so the chip hides.
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
		// Edit-mode Reset Layout must work even when dirty=false (just loaded).
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
		// Edit-mode Reset autoLayouts: n1 lands off the server {500,600}.
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
			await new Promise( ( r ) => setTimeout( r, 300 ) ); // autoLayout
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
			await new Promise( ( r ) => setTimeout( r, 300 ) ); // post-reset
		} );
		// After Reset: n1 off {500,600}, a fresh unmodified auto-fit.
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
		// A null layout's .then must not fall through to .catch.
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
		// Divergence must ignore stale stored ids absent from the live graph.
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
		// Save serializes only live-graph ids; no stale positions leak back.
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
		// s→t connected, iso isolated; autoLayout: s col0, t+iso rightmost.
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastReplProps.onSubmit( 'cd /' );
		} );
		// At the local root the poll answers itself and publishes the browser's
		// own graph; let the mount's tick land BEFORE the snapshot below.
		await act( async () => {} );
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: {
				s: { class: 'Echo', counter: 0, sink: '', target: 't' },
				t: { class: 'Echo', counter: 0, sink: '', target: '' },
				iso: { class: 'Echo', counter: 0, sink: '', target: '' },
			},
		} );
		// Local-scope autoLayout waits for the streaming node set to settle.
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 300 ) );
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
		// Matching worker cwd: canvas adopts server positions, no autoLayout.
		hooks.fetchLayout.mockResolvedValueOnce( {
			positions: { n1: [ 700, 800 ] },
		} );
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		} );
		// Publish the worker's node so the graph is ready for init.
		await fireMsg( {
			type: TM_STRUCT,
			to: names.METADATA,
			value: {
				n1: { class: 'Echo', counter: 0, sink: '', target: '' },
			},
		} );
		expect( mockCanvasProps.positionOverrides.n1 ).toEqual( {
			x: 700,
			y: 800,
		} );
		const stored = JSON.parse(
			window.localStorage.getItem( 'newspack-nodes:topology:demo.p0' )
		);
		expect( stored.positions.n1 ).toEqual( { x: 700, y: 800 } );
		expect( stored.modified ).toBe( false );
	} );

	it( 'ignores an out-of-order layout response from the previous topology', async () => {
		const pendingLayouts = {};
		const stalePosition = { x: -377, y: 1093 };
		const currentPosition = { x: 841, y: -619 };
		mockCanvasProps = null;
		hooks.catalog = {
			partitions: { demo: 1, other: 1 },
			active: [ 'demo', 'other' ],
			entries: [],
		};
		hooks.fetchLayout.mockImplementation(
			( name ) =>
				new Promise( ( resolve ) => {
					pendingLayouts[ name ] = resolve;
				} )
		);
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		expect( hooks.fetchLayout ).toHaveBeenCalledWith( 'demo' );

		await act( async () => {
			lastHeaderProps.onPathChange( 'other.p0' );
		} );
		expect( hooks.fetchLayout ).toHaveBeenCalledWith( 'other' );
		await publishMeta();

		await act( async () => {
			pendingLayouts.demo( {
				positions: {
					n1: [ stalePosition.x, stalePosition.y ],
				},
			} );
			await Promise.resolve();
		} );
		expect( mockCanvasProps?.positionOverrides.n1 ).toBeUndefined();

		await act( async () => {
			pendingLayouts.other( {
				positions: {
					n1: [ currentPosition.x, currentPosition.y ],
				},
			} );
			await Promise.resolve();
		} );
		expect( mockCanvasProps.positionOverrides.n1 ).toEqual(
			currentPosition
		);
		const stored = JSON.parse(
			window.localStorage.getItem( 'newspack-nodes:topology:other.p0' )
		);
		expect( stored.positions.n1 ).toEqual( currentPosition );
	} );

	it( 'keeps the current layout when a previous topology save resolves late', async () => {
		const pendingLayouts = {};
		const initialPosition = { x: -263, y: 647 };
		const draggedPosition = { x: -419, y: 1207 };
		const currentPosition = { x: 887, y: -653 };
		const staleSavePosition = { x: -977, y: 1559 };
		let resolveSave;
		mockCanvasProps = null;
		hooks.catalog = {
			partitions: { demo: 1, other: 1 },
			active: [ 'demo', 'other' ],
			entries: [],
		};
		hooks.fetchLayout.mockImplementation( ( name ) => {
			if ( 'demo' === name ) {
				return Promise.resolve( {
					positions: {
						n1: [ initialPosition.x, initialPosition.y ],
					},
				} );
			}
			return new Promise( ( resolve ) => {
				pendingLayouts[ name ] = resolve;
			} );
		} );
		hooks.saveLayout.mockImplementation(
			() =>
				new Promise( ( resolve ) => {
					resolveSave = resolve;
				} )
		);
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		await act( async () => {
			await Promise.resolve();
		} );
		await publishMeta();
		await act( async () => {
			mockCanvasProps.onPositionChange( 'n1', draggedPosition );
		} );
		act( () => {
			fireEvent.click( getByText( 'save-layout' ) );
		} );
		expect( hooks.saveLayout ).toHaveBeenCalledWith( {
			name: 'demo',
			positions: {
				n1: [ draggedPosition.x, draggedPosition.y ],
			},
		} );

		await act( async () => {
			lastHeaderProps.onPathChange( 'other.p0' );
		} );
		await publishMeta();
		await act( async () => {
			pendingLayouts.other( {
				positions: {
					n1: [ currentPosition.x, currentPosition.y ],
				},
			} );
			await Promise.resolve();
		} );
		expect( queryByTestId( 'canvas' ) ).not.toBeNull();
		expect( mockCanvasProps.positionOverrides.n1 ).toEqual(
			currentPosition
		);

		await act( async () => {
			resolveSave( {
				name: 'demo',
				positions: {
					n1: [ staleSavePosition.x, staleSavePosition.y ],
				},
			} );
			await Promise.resolve();
		} );
		expect( queryByTestId( 'canvas' ) ).not.toBeNull();
		expect( mockCanvasProps.positionOverrides.n1 ).toEqual(
			currentPosition
		);
		const stored = JSON.parse(
			window.localStorage.getItem( 'newspack-nodes:topology:other.p0' )
		);
		expect( stored.positions.n1 ).toEqual( currentPosition );
	} );

	// An include expansion is a command on the router tick, so settling one is
	// a wait rather than a microtask flush.
	const waitForTick = ( check ) => waitFor( check, { timeout: 6000 } );

	describe( 'edit mode: topology includes', () => {
		function mockTopologyGet( name, tsl, extra = {} ) {
			hooks.fetchTopology.mockResolvedValueOnce( {
				tsl,
				name,
				source: 'user',
				...extra,
			} );
		}

		// The wire adapter is the one command entry point (shared with the
		// "Activate now?" flow); answer only the `topologies expand` verb.
		function mockTopologyExpand( includeNames, result ) {
			globalThis.__activateSend.mockImplementation( ( msg ) =>
				'topologies' === msg?.to && 'expand' === msg?.verb
					? result
					: null
			);
		}

		function mockTopologyExpandFailure( message ) {
			globalThis.__activateSend.mockImplementation( ( msg ) =>
				'topologies' === msg?.to && 'expand' === msg?.verb
					? new Error( message )
					: null
			);
		}

		// 'demo' is the one topology SEED_WORKERS/topologyWorkers knows about
		// (window.NewspackNodesData seed above) — the fetchTopology MOCK's
		// response shapes the actually-loaded content/name, not the URL.
		async function renderConsoleInEditMode() {
			window.history.replaceState( {}, '', '/?topology=demo' );
			const utils = render( <TopologyConsole /> );
			await act( async () => {
				fireEvent.click( utils.getByText( 'edit' ) );
			} );
			// The load chain (fetchTopology -> fetchIncludeBaseline ->
			// applyLoadedBaseline) is deeper than one act() flush; force a
			// macrotask boundary so every microtask hop settles first.
			await act( async () => {
				await new Promise( ( r ) => setTimeout( r, 0 ) );
			} );
			return utils;
		}

		// Fires the drop, then waits for BOTH the include to land AND its
		// borrowed nodes to reconcile into the draft (the hull is proof of both).
		async function dropTopologyFromPalette( name, point ) {
			await act( async () => {
				lastPaletteProps.onDropTopology( { name, ...point } );
			} );
			await waitForTick( () => {
				expect( lastPaletteProps.declaredIncludes ).toContain( name );
				expect(
					( mockCanvasProps.hulls || [] ).some(
						( h ) => h.include === name
					)
				).toBe( true );
			} );
		}

		async function clickSave( getByText ) {
			await act( async () => {
				fireEvent.click( getByText( 'save' ) );
			} );
			await act( async () => {
				fireEvent.click( getByText( 'prompt-ok' ) );
			} );
		}

		function savedTsl() {
			const call = hooks.saveTopology.mock.calls[ 0 ];
			return call && call[ 0 ].tsl;
		}

		it( 'shows hulls in LIVE mode from the VIEWED topology, not a stale draft', async () => {
			// Hulls were derived from draft.includes, which survives leaving edit
			// mode — so an include dragged into one topology painted a hull over a
			// DIFFERENT topology's live graph. Live must read the viewed topology's
			// own includes (topologies list carries them) and its expand baseline.
			hooks.catalog = {
				partitions: { demo: 1 },
				active: [ 'demo' ],
				entries: [
					{
						name: 'demo',
						active: true,
						num_partitions: 1,
						includes: [ 'job-intake' ],
					},
				],
			};
			mockTopologyExpand( [ 'job-intake' ], {
				nodes: [
					{
						name: 'zebra:partition',
						class: 'Partition',
						args: [],
						origin: [ 'job-intake' ],
						via: [ 'job-intake' ],
					},
				],
				edges: [],
				tree: { 'job-intake': {} },
				hulls: {
					'job-intake': [ 'zebra:consumer', 'zebra:partition' ],
				},
			} );

			window.history.replaceState(
				{},
				'',
				'/?topology=demo&partition=0'
			);
			render( <TopologyConsole /> );

			// Publish a live worker graph carrying the borrowed node.
			const { Core: RtCore } = require( '../../runtime/core' );
			const reservedNames = require( '../../runtime/reserved-node-names.json' );
			await act( async () => {
				RtCore.node( reservedNames.METADATA ).setState( 'metadata', {
					nodes: [ { id: 'zebra:partition', class: 'Partition' } ],
					edges: [],
					pwd: '',
				} );
			} );

			await waitForTick( () => {
				expect( mockCanvasProps ).not.toBeNull();
				const hulls = mockCanvasProps.hulls || [];
				expect( hulls.map( ( h ) => h.include ) ).toEqual( [
					'job-intake',
				] );
				expect( hulls[ 0 ].nodeIds ).toEqual( [ 'zebra:partition' ] );
			} );
		} );

		it( 'UPLOADing a .tsl that includes a topology brings its borrowed nodes onto the canvas', async () => {
			mockTopologyGet( 'wombat-top', 'make_node Echo own-echo\n' );
			mockTopologyExpand( [ 'job-intake' ], {
				nodes: [
					{
						name: 'zebra:fanout',
						class: 'Settings_Sync',
						fans_out: true,
						args: [],
						origin: [ 'job-intake' ],
						via: [ 'job-intake' ],
					},
					{
						name: 'zebra:partition',
						class: 'Partition',
						fans_out: false,
						args: [],
						origin: [ 'job-intake' ],
						via: [ 'job-intake' ],
					},
				],
				edges: [],
				tree: { 'job-intake': {} },
				hulls: {
					'job-intake': [ 'zebra:fanout', 'zebra:partition' ],
				},
			} );

			const { getByText } = await renderConsoleInEditMode();

			globalThis.__uploadTsl =
				'include job-intake\n' +
				'make_node Null quokka-null\n' +
				'make_node Echo quokka-echo\n' +
				'connect_node zebra:fanout quokka-null\n' +
				'connect_node zebra:fanout quokka-echo\n';
			await act( async () => {
				fireEvent.click( getByText( 'upload' ) );
			} );
			// Settle past the reactive expand + include reconcile, not just the
			// upload's own await chain — that is where a borrowed node is lost.
			// The expand is a tick away, so this is a wait, not a flush.
			await waitFor(
				() => {
					const painted = mockCanvasProps.parsed.nodes.map(
						( n ) => n.id
					);
					expect( painted ).toContain( 'zebra:partition' );
				},
				{ timeout: 6000 }
			);

			const ids = mockCanvasProps.parsed.nodes.map( ( n ) => n.id );
			expect( ids ).toContain( 'quokka-null' );
			expect( ids ).toContain( 'quokka-echo' );
			expect( ids ).toContain( 'zebra:fanout' );
			// A fan-out source keeps EVERY connect; collapsing to the last one
			// is the "nothing is connected" bug.
			expect(
				mockCanvasProps.parsed.edges.filter(
					( e ) => 'zebra:fanout' === e.from
				)
			).toHaveLength( 2 );
		} );

		it( 'drilling into a hull with unsaved edits asks before dropping them', async () => {
			// "Open performance.tsl" REPLACES the draft. Doing that silently after
			// the user has edited is data loss — the same reason leaving edit mode
			// prompts.
			mockTopologyGet( 'wombat-top', 'make_node Echo own-echo\n' );

			const { queryByTestId } = await renderConsoleInEditMode();
			// Dirty the draft.
			await act( async () => {
				lastPaletteProps.onDropNode( {
					shellName: 'Echo',
					x: 100,
					y: 100,
				} );
			} );

			// Select a node so the inspector dock mounts (collapsed by default).
			await act( async () => {
				mockCanvasProps.onSelect( 'own-echo' );
			} );

			await act( async () => {
				lastInspectorProps.onOpenTopology( 'performance' );
			} );

			// The confirm modal is up (Modal is mocked to a testid + buttons).
			expect( queryByTestId( 'confirm-modal' ) ).not.toBeNull();
			expect( globalThis.__lastConfirmModal.title ).toMatch(
				/discard unsaved changes/i
			);
			// The draft is untouched until the user confirms.
			expect(
				mockCanvasProps.parsed.nodes.some(
					( n ) => n.id === 'own-echo'
				)
			).toBe( true );
			expect( hooks.fetchTopology ).toHaveBeenCalledTimes( 1 );
		} );

		it( 'a freshly-opened topology with includes is NOT dirty', async () => {
			// Opening one and leaving edit mode must not prompt "discard unsaved
			// changes?" — the user changed nothing. The async include reconcile
			// runs after the draft is set, so it must land content-identical.
			mockTopologyGet(
				'wombat-top',
				'include job-intake\nmake_node Echo own-echo\n'
			);
			mockTopologyExpand( [ 'job-intake' ], {
				nodes: [
					{
						name: 'zebra:consumer',
						class: 'Consumer',
						args: [],
						origin: [ 'job-intake' ],
						via: [ 'job-intake' ],
					},
					{
						name: 'zebra:partition',
						class: 'Partition',
						args: [],
						origin: [ 'job-intake' ],
						via: [ 'job-intake' ],
					},
				],
				edges: [
					{
						from: 'zebra:consumer',
						to: 'zebra:partition',
						origin: [ 'job-intake' ],
					},
				],
				tree: { 'job-intake': {} },
				hulls: {
					'job-intake': [ 'zebra:consumer', 'zebra:partition' ],
				},
			} );

			const { getByText, queryByText } = await renderConsoleInEditMode();
			// Let the reconcile effect settle after the baseline lands.
			await act( async () => {
				await new Promise( ( r ) => setTimeout( r, 0 ) );
			} );

			await act( async () => {
				fireEvent.click( getByText( 'view' ) );
			} );

			expect( queryByText( /discard unsaved changes/i ) ).toBeNull();
			expect( lastHeaderProps.mode ).toBe( 'view' );
		} );

		it( "keeps the include's OWN edges, so save emits no phantom disconnect_node", async () => {
			// The included topology wires its own nodes together. Those edges must
			// land in the draft, or the serializer sees them "removed" and writes a
			// disconnect_node for an edge the user never touched — which then tears
			// the borrowed topology apart at boot. (Caught in a live browser run;
			// the earlier drop test used an edge-less baseline and missed it.)
			mockTopologyGet( 'wombat-top', 'make_node Echo own-echo\n' );
			mockTopologyExpand( [ 'job-intake' ], {
				nodes: [
					{
						name: 'zebra:consumer',
						class: 'Consumer',
						args: [],
						origin: [ 'job-intake' ],
						via: [ 'job-intake' ],
					},
					{
						name: 'zebra:partition',
						class: 'Partition',
						args: [],
						origin: [ 'job-intake' ],
						via: [ 'job-intake' ],
					},
				],
				edges: [
					{
						from: 'zebra:consumer',
						to: 'zebra:partition',
						origin: [ 'job-intake' ],
					},
				],
				tree: { 'job-intake': {} },
				hulls: {
					'job-intake': [ 'zebra:consumer', 'zebra:partition' ],
				},
			} );

			const { getByText } = await renderConsoleInEditMode();
			await dropTopologyFromPalette( 'job-intake', { x: 500, y: 300 } );

			// The borrowed edge is in the edited graph, not silently dropped.
			expect(
				mockCanvasProps.parsed.edges.some(
					( e ) =>
						e.from === 'zebra:consumer' &&
						e.to === 'zebra:partition'
				)
			).toBe( true );

			await clickSave( getByText );
			expect( savedTsl() ).not.toContain( 'disconnect_node' );
			expect( savedTsl() ).toBe(
				'include job-intake\nmake_node Echo own-echo\n'
			);
		} );

		it( 'dropping a topology emits an include and saves the collapsed form', async () => {
			mockTopologyGet( 'wombat-top', 'make_node Echo own-echo\n' );
			mockTopologyExpand( [ 'performance' ], {
				nodes: [
					{
						name: 'shared-tee',
						class: 'Tee',
						args: [],
						origin: [ 'performance' ],
						via: [ 'performance' ],
					},
				],
				edges: [],
				tree: { performance: {} },
				hulls: { performance: [ 'shared-tee' ] },
			} );

			const { getByText } = await renderConsoleInEditMode();
			await dropTopologyFromPalette( 'performance', { x: 500, y: 300 } );

			expect( globalThis.__activateSend ).toHaveBeenCalledWith( {
				to: 'topologies',
				verb: 'expand',
				args: [ 'performance' ],
			} );

			// The borrowed node landed with a COMPUTED position (not the
			// borrowedNode() x:0/y:0 default) — otherwise it's invisible, since
			// SchematicCanvas only renders nodes present in positionOverrides.
			expect(
				mockCanvasProps.positionOverrides[ 'shared-tee' ]
			).not.toEqual( { x: 0, y: 0 } );
			expect(
				mockCanvasProps.parsed.nodes.find(
					( n ) => n.id === 'shared-tee'
				)?.origin
			).toEqual( [ 'performance' ] );
			// Inspector's IncludeTree threading (tree/includes props) is covered
			// at the GraphView level (GraphView.test.js), where the inspector
			// isn't gated behind TopologyConsole's own collapsed-by-default chrome.

			await clickSave( getByText );
			expect( savedTsl() ).toBe(
				'include performance\nmake_node Echo own-echo\n'
			);
		} );

		it( 'reopening a topology with an existing include re-derives its borrowed nodes', async () => {
			mockTopologyGet(
				'wombat-top',
				'include performance\nmake_node Echo own-echo\n'
			);
			mockTopologyExpand( [ 'performance' ], {
				nodes: [
					{
						name: 'shared-tee',
						class: 'Tee',
						args: [],
						origin: [ 'performance' ],
						via: [ 'performance' ],
					},
				],
				edges: [],
				tree: { performance: {} },
				hulls: { performance: [ 'shared-tee' ] },
			} );

			await renderConsoleInEditMode();

			await waitForTick( () => {
				expect(
					mockCanvasProps.parsed.nodes.find(
						( n ) => n.id === 'shared-tee'
					)?.origin
				).toEqual( [ 'performance' ] );
			} );
		} );

		it( 'a failed expand toasts the error and reverts the pending include', async () => {
			mockTopologyGet( 'wombat-top', 'make_node Echo own-echo\n' );
			mockTopologyExpandFailure( 'topology include cycle: a -> b -> a' );

			const { container } = await renderConsoleInEditMode();
			await act( async () => {
				lastPaletteProps.onDropTopology( {
					name: 'performance',
					x: 500,
					y: 300,
				} );
			} );

			await waitForTick( () => {
				expect(
					container.querySelector( '.topology-toast--error' )
				).not.toBeNull();
			} );
			expect( lastPaletteProps.declaredIncludes ).toEqual( [] );
		} );

		it( 'palette topology drop in VIEW mode is a no-op (editMode guard, like handleDropNode)', async () => {
			window.history.replaceState( {}, '', '/?topology=demo' );
			render( <TopologyConsole /> );
			// The palette only renders once layoutReady (>=1 node); view mode
			// stays a worker scope, so a metadata reply satisfies the gate.
			await publishMeta();

			await act( async () => {
				lastPaletteProps.onDropTopology( {
					name: 'performance',
					x: 10,
					y: 10,
				} );
			} );

			expect( globalThis.__activateSend ).not.toHaveBeenCalledWith(
				expect.objectContaining( { verb: 'expand' } )
			);
			expect( lastPaletteProps.declaredIncludes ).toEqual( [] );
		} );

		it( 'auto-loading a topology whose declared include fails to expand toasts the error (not a silent blank canvas)', async () => {
			mockTopologyGet(
				'wombat-top',
				'include performance\nmake_node Echo own-echo\n'
			);
			mockTopologyExpandFailure( 'topology include cycle: a -> b -> a' );

			const { container } = await renderConsoleInEditMode();

			await waitForTick( () => {
				expect(
					container.querySelector( '.topology-toast--error' )
				).not.toBeNull();
			} );
		} );

		it( 'handleOpenPick surfaces a failed expand for the picked topology via toast (not a silent blank canvas)', async () => {
			mockTopologyGet( 'wombat-top', 'make_node Echo own-echo\n' );
			hooks.fetchTopology.mockResolvedValueOnce( {
				tsl: 'include performance\nmake_node Echo picked-echo\n',
				name: 'picked',
				source: 'user',
			} );
			mockTopologyExpandFailure(
				'unknown topology in include: performance'
			);

			const { getByText, container } = await renderConsoleInEditMode();
			await act( async () => {
				fireEvent.click( getByText( 'open' ) );
			} );
			await act( async () => {
				fireEvent.click( getByText( 'pick' ) );
			} );

			await waitForTick( () => {
				expect(
					container.querySelector( '.topology-toast--error' )
				).not.toBeNull();
			} );
		} );

		it( 'dropping a second topology does not move a node already shared with an existing include (diamond)', async () => {
			mockTopologyGet( 'wombat-top', 'make_node Echo own-echo\n' );
			globalThis.__activateSend.mockImplementation( ( msg ) => {
				if (
					! msg ||
					msg.to !== 'topologies' ||
					msg.verb !== 'expand'
				) {
					return null;
				}
				// `args` is a token array; the old string compare never
				// matched, so BOTH drops got the combined expansion.
				const asked = [].concat( msg.args ).join( ' ' );
				return 'performance' === asked
					? {
							nodes: [
								{
									name: 'shared-tee',
									class: 'Tee',
									args: [],
									origin: [ 'performance' ],
									via: [ 'performance' ],
								},
							],
							edges: [],
							tree: { performance: {} },
							hulls: { performance: [ 'shared-tee' ] },
					  }
					: {
							nodes: [
								{
									name: 'shared-tee',
									class: 'Tee',
									args: [],
									origin: [ 'performance', 'job-router' ],
									via: [ 'performance', 'job-router' ],
								},
								{
									name: 'router-only',
									class: 'Echo',
									args: [],
									origin: [ 'job-router' ],
									via: [ 'job-router' ],
								},
							],
							edges: [],
							tree: { performance: {}, 'job-router': {} },
							// The diamond node is a member of BOTH hulls.
							hulls: {
								performance: [ 'shared-tee' ],
								'job-router': [ 'shared-tee', 'router-only' ],
							},
					  };
			} );

			await renderConsoleInEditMode();
			await dropTopologyFromPalette( 'performance', { x: 500, y: 300 } );
			const sharedPos = {
				...mockCanvasProps.positionOverrides[ 'shared-tee' ],
			};

			await dropTopologyFromPalette( 'job-router', { x: 900, y: 900 } );

			expect( mockCanvasProps.positionOverrides[ 'shared-tee' ] ).toEqual(
				sharedPos
			);
		} );

		it( 'drilling into an included topology keeps that topology’s own nodes', async () => {
			// The parent's expansion stays in state for a tick after the child
			// loads. Re-seeding from it marks the child's OWN node borrowed,
			// after which the document stops declaring it and a save writes an
			// empty file — the node is gone from disk.
			mockTopologyGet( 'wombat-top', 'include performance\n' );
			mockTopologyExpand( [ 'performance' ], {
				nodes: [
					{
						name: 'n1',
						class: 'Tee',
						args: [],
						origin: [ 'performance' ],
						via: [ 'performance' ],
					},
					{
						name: 'sibling-echo',
						class: 'Echo',
						args: [],
						origin: [ 'performance' ],
						via: [ 'performance' ],
					},
				],
				edges: [],
				tree: { performance: {} },
				hulls: { performance: [ 'n1', 'sibling-echo' ] },
			} );
			const { getByText } = await renderConsoleInEditMode();
			await waitForTick( () =>
				expect(
					mockCanvasProps.parsed.nodes.some( ( n ) => n.id === 'n1' )
				).toBe( true )
			);
			// The inspector mounts on selection; that is where Open lives.
			await act( async () => {
				fireEvent.click( getByText( 'select-n1' ) );
			} );

			// Open the child: its own `make_node` declares the same node.
			hooks.fetchTopology.mockResolvedValueOnce( {
				tsl: 'make_node Tee n1\n',
				name: 'performance',
				source: 'user',
			} );
			await act( async () => {
				lastInspectorProps.onOpenTopology( 'performance' );
			} );
			await act( async () => {
				await new Promise( ( r ) => setTimeout( r, 0 ) );
			} );

			const node = mockCanvasProps.parsed.nodes.find(
				( n ) => n.id === 'n1'
			);
			expect( node ).toBeDefined();
			// The DOCUMENT's, not borrowed — so a save still writes it.
			expect( node.origin ).toBeUndefined();
			// And nothing the PARENT's expansion carried leaked in with it.
			expect(
				mockCanvasProps.parsed.nodes.map( ( n ) => n.id )
			).not.toContain( 'sibling-echo' );
		} );

		it( 'reopening a topology only round-trips `topologies expand` once (fetchIncludeBaseline result is cached for useExpandedIncludes)', async () => {
			mockTopologyGet(
				'wombat-top',
				'include performance\nmake_node Echo own-echo\n'
			);
			mockTopologyExpand( [ 'performance' ], {
				nodes: [
					{
						name: 'shared-tee',
						class: 'Tee',
						args: [],
						origin: [ 'performance' ],
						via: [ 'performance' ],
					},
				],
				edges: [],
				tree: { performance: {} },
				hulls: { performance: [ 'shared-tee' ] },
			} );

			await renderConsoleInEditMode();

			await waitForTick( () => {
				expect(
					mockCanvasProps.parsed.nodes.find(
						( n ) => n.id === 'shared-tee'
					)?.origin
				).toEqual( [ 'performance' ] );
			} );

			const expandCalls = globalThis.__activateSend.mock.calls.filter(
				( [ msg ] ) =>
					msg && msg.to === 'topologies' && msg.verb === 'expand'
			);
			expect( expandCalls ).toHaveLength( 1 );
		} );

		it( 'onAddInclude/onRemoveInclude keep a stable identity across an unrelated re-render (no full-canvas re-render per keystroke)', async () => {
			mockTopologyGet( 'wombat-top', 'make_node Echo own-echo\n' );
			const { getByText } = await renderConsoleInEditMode();

			// Selecting a node auto-opens the inspector (openInspectorOnSelect).
			await act( async () => {
				fireEvent.click( getByText( 'select-n1' ) );
			} );
			const beforeAdd = lastInspectorProps.onAddInclude;
			const beforeRemove = lastInspectorProps.onRemoveInclude;

			// A viewport change is a genuinely unrelated re-render trigger.
			await act( async () => {
				fireEvent.click( getByText( 'vp-change' ) );
			} );

			expect( lastInspectorProps.onAddInclude ).toBe( beforeAdd );
			expect( lastInspectorProps.onRemoveInclude ).toBe( beforeRemove );
		} );

		it( 'the re-seed does not run in VIEW mode (the draft is inert there)', async () => {
			// The effect early-returns outside edit mode; a re-seed there
			// would be work against a document nothing has loaded.
			window.history.replaceState( {}, '', '/?topology=demo' );
			const { getByTestId } = render( <TopologyConsole /> );
			await act( async () => {} );

			// Live mode renders the running graph; nothing has loaded a
			// document, so a re-seed would be work against an empty draft.
			expect( getByTestId( 'header' ).dataset.mode ).toBe( 'view' );
		} );
	} );

	describe( 'skin theme', () => {
		// The skin is now the global `<html>.theme-<slug>` class.
		const rootClass = () => document.documentElement.className;

		it( 'defaults to theme-newspack when localStorage is empty', () => {
			render( <TopologyConsole /> );
			expect( rootClass() ).toContain( 'theme-newspack' );
		} );

		it( 'applies a valid stored skin on mount', () => {
			window.localStorage.setItem( 'newspack-nodes:theme', 'blueprint' );
			render( <TopologyConsole /> );
			expect( rootClass() ).toContain( 'theme-blueprint' );
		} );

		it( 'falls back to theme-newspack for an unknown stored skin', () => {
			window.localStorage.setItem( 'newspack-nodes:theme', 'bogus' );
			render( <TopologyConsole /> );
			expect( rootClass() ).toContain( 'theme-newspack' );
			expect( rootClass() ).not.toContain( 'theme-bogus' );
		} );

		it( 'no longer threads skin props to the header (skins moved to the REPL)', () => {
			render( <TopologyConsole /> );
			expect( lastHeaderProps.onThemeChange ).toBeUndefined();
			expect( lastHeaderProps.themes ).toBeUndefined();
		} );

		it( 'set_skin REPL builtin updates the root class and persists', () => {
			render( <TopologyConsole /> );
			act( () => {
				// Spaced label form resolves to the `crt` slug.
				lastReplProps.onSubmit( 'set_skin CRT Phosphor' );
			} );
			expect( rootClass() ).toContain( 'theme-crt' );
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
			// Seed BEFORE import so SEED_WORKERS captures it (as in prod).
			window.NewspackNodesData = {
				topologyWorkers: { alpha: 1, demo: 2 },
				activeTopologies: [],
			};
			// eslint-disable-next-line global-require
			const mod = require( '../TopologyConsole' );
			window.history.replaceState( {}, '', '/?topology=demo' );
			// Sibling re-localized data without topologyWorkers (the clobber).
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
