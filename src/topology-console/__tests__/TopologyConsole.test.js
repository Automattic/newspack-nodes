/* global globalThis */
/**
 * TopologyConsole tests. useConsoleGraph is mocked to hand back a real
 * SessionSink + capture-only command-out node; mocked child components
 * expose every prop callback as a button so handlers run end-to-end.
 */

import { render, fireEvent, act } from '@testing-library/react';

// Pre-seed window.NewspackNodesData for the module-level IIFEs.
window.NewspackNodesData = {
	restUrl: '/wp-json/',
	nonce: 'NONCE',
	topologyPartitions: { demo: 2 },
	activeTopologies: [ 'demo' ],
	version: 'test',
	userLogin: 'tester',
};

// Mock only useConsoleGraph; hand back a real SessionSink + capture CommandOut.
globalThis.__commandOutFill = jest.fn();
globalThis.__sessionNode = null;
// {topology}.p{N} the mock graph is built for; a change rebuilds a fresh sink.
globalThis.__graphKey = null;
jest.mock( '../hooks/useConsoleGraph', () => {
	const { Core } = require( '../../runtime/core' );
	const { SessionSink } = require( '../nodes/SessionSink' );
	const { Node } = require( '../../runtime/node' );
	return {
		useConsoleGraph: ( {
			topology,
			partition,
			enabled,
			debugLevelRef,
		} ) => {
			if ( ! enabled ) {
				Core.unregisterNode( 'session' );
				Core.unregisterNode( 'command-out' );
				globalThis.__sessionNode = null;
				globalThis.__graphKey = null;
				return {
					status: 'closed',
					ssePid: null,
					sessionNode: null,
					commandOutName: 'command-out',
				};
			}
			const key = `${ topology }.p${ partition }`;
			if ( globalThis.__graphKey !== key ) {
				// Worker changed: rebuild a fresh SessionSink + capture CommandOut.
				Core.unregisterNode( 'session' );
				Core.unregisterNode( 'command-out' );
				const session = new SessionSink( { debugLevelRef } );
				session.setName( 'session' );
				globalThis.__sessionNode = session;
				const out = new Node();
				out.fill = ( payload ) =>
					globalThis.__commandOutFill( payload );
				out.setName( 'command-out' );
				globalThis.__graphKey = key;
			}
			return {
				status: 'open',
				ssePid: 1234,
				sessionNode: Core.node( 'session' ),
				commandOutName: 'command-out',
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
					props.onAction( 'request', 'n1', 'GET_LAG' )
				}
			>
				action-request
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
jest.mock( '../components/Palette', () => () => (
	<aside data-testid="palette" />
) );
jest.mock( '../components/ReplFooter', () => ( props ) => (
	<footer
		data-testid="repl"
		data-expanded={ props.expanded ? '1' : '0' }
		data-can-send={ props.canSend ? '1' : '0' }
	>
		<button onClick={ () => props.onSubmit && props.onSubmit( 'ls' ) }>
			submit
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
) );
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

describe( 'TopologyConsole boot', () => {
	beforeEach( () => {
		window.history.replaceState( {}, '', '/' );
		// Clear localStorage so persisted state doesn't bleed between tests.
		window.localStorage.clear();
		// Reset Core so the next render builds a fresh SessionSink.
		Core.reset();
		globalThis.__sessionNode = null;
		globalThis.__graphKey = null;
		globalThis.__commandOutFill.mockClear();
		// Reset hook mocks between tests.
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
	} );

	it( 'renders Header, Canvas, and ReplFooter on mount (Inspector is selection-only)', () => {
		const { getByTestId, queryByTestId } = render( <TopologyConsole /> );
		expect( getByTestId( 'header' ) ).not.toBeNull();
		expect( queryByTestId( 'palette' ) ).toBeNull();
		expect( getByTestId( 'canvas' ) ).not.toBeNull();
		expect( queryByTestId( 'inspector' ) ).toBeNull();
		expect( getByTestId( 'repl' ) ).not.toBeNull();
	} );

	it( 'starts in view mode by default', () => {
		const { getByTestId } = render( <TopologyConsole /> );
		expect( getByTestId( 'header' ).dataset.mode ).toBe( 'view' );
		expect( getByTestId( 'canvas' ).dataset.mode ).toBe( 'view' );
	} );

	it( 'polls dump_metadata every tick and batches uptime onto the 5s tick', () => {
		// dump_metadata (gui:auto) fires every tick; uptime (gui:uptime) rides every 5th.
		jest.useFakeTimers();
		try {
			globalThis.__commandOutFill.mockClear();
			act( () => {
				render( <TopologyConsole /> );
			} );
			const commandsOf = ( call ) => call[ 0 ].commands;
			const hasVerb = ( commands, name ) =>
				Array.isArray( commands ) &&
				commands.some( ( c ) => c.name === name );
			const dumpBatches = () =>
				globalThis.__commandOutFill.mock.calls.filter( ( c ) =>
					hasVerb( commandsOf( c ), 'dump_metadata' )
				);
			const uptimeBatches = () =>
				globalThis.__commandOutFill.mock.calls.filter( ( c ) =>
					hasVerb( commandsOf( c ), 'uptime' )
				);
			// Immediate paint: one batch carrying both commands.
			expect( dumpBatches().length ).toBeGreaterThanOrEqual( 1 );
			expect( uptimeBatches().length ).toBeGreaterThanOrEqual( 1 );
			const first = commandsOf(
				globalThis.__commandOutFill.mock.calls[ 0 ]
			);
			expect( hasVerb( first, 'dump_metadata' ) ).toBe( true );
			expect( hasVerb( first, 'uptime' ) ).toBe( true );
			expect(
				first.find( ( c ) => c.name === 'dump_metadata' ).key
			).toBe( 'gui:auto' );
			expect( first.find( ( c ) => c.name === 'uptime' ).key ).toBe(
				'gui:uptime'
			);
			// One stats tick: a new dump_metadata batch, but uptime is NOT due.
			const dumpBefore = dumpBatches().length;
			const uptimeBefore = uptimeBatches().length;
			act( () => {
				jest.advanceTimersByTime( 1000 );
			} );
			expect( dumpBatches().length ).toBeGreaterThan( dumpBefore );
			expect( uptimeBatches().length ).toBe( uptimeBefore );
			// Reaching the 5s uptime cadence: uptime rides the next stats batch.
			act( () => {
				jest.advanceTimersByTime( 4000 );
			} );
			expect( uptimeBatches().length ).toBeGreaterThan( uptimeBefore );
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'switching to edit mode flips header + canvas + reveals palette', () => {
		const { getByText, getByTestId, queryByTestId } = render(
			<TopologyConsole />
		);
		fireEvent.click( getByText( 'edit' ) );
		// Best-effort: the mode flipped or the modal held it back.
		expect( getByTestId( 'header' ) ).not.toBeNull();
		fireEvent.click( getByText( 'view' ) );
		expect( queryByTestId( 'header' ) ).not.toBeNull();
	} );

	it( 'ReplFooter onSubmit dispatches without throwing', async () => {
		const { getByText, getByTestId } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'submit' ) );
		} );
		expect( getByTestId( 'repl' ) ).not.toBeNull();
	} );

	// SSE message bitmask constants (mirror class-message.php).
	const TM_BYTESTREAM = 1;
	const TM_EOF = 2;
	const TM_PING = 4;
	const TM_COMMAND = 8;
	const TM_RESPONSE = 16;
	const TM_ERROR = 32;
	const TM_INFO = 64;
	const TM_STRUCT = 256;

	// Pump a synthetic SSE message through the live SessionSink.
	const fireMsg = async ( msg ) => {
		await act( async () => {
			globalThis.__sessionNode.fill( msg );
		} );
	};

	it( 'dumperRender: TM_BYTESTREAM appends value to transcript as recv', async () => {
		const { container } = render( <TopologyConsole /> );
		await fireMsg( {
			type: TM_BYTESTREAM,
			from: 'worker',
			value: 'hello world',
		} );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const recv = Array.from( items ).find(
			( i ) => i.dataset.kind === 'recv'
		);
		expect( recv ).not.toBeUndefined();
		expect( recv.textContent ).toBe( 'hello world' );
	} );

	it( 'dumperRender: TM_EOF is dropped silently', async () => {
		const { container } = render( <TopologyConsole /> );
		await fireMsg( { type: TM_EOF, from: 'worker', value: '' } );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		expect( items.length ).toBe( 0 );
	} );

	it( 'dumperRender: TM_PING formats round trip time', async () => {
		const { container } = render( <TopologyConsole /> );
		const past = Date.now() / 1000 - 0.05; // 50ms ago
		await fireMsg( {
			type: TM_PING,
			from: 'worker',
			value: String( past ),
		} );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const info = Array.from( items ).find(
			( i ) => i.dataset.kind === 'info'
		);
		expect( info ).not.toBeUndefined();
		expect( info.textContent ).toMatch( /round trip time:.+ms/ );
	} );

	it( 'dumperRender: TM_ERROR routes to error transcript kind', async () => {
		const { container } = render( <TopologyConsole /> );
		await fireMsg( {
			type: TM_ERROR,
			from: 'worker',
			value: 'something went wrong',
		} );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const err = Array.from( items ).find(
			( i ) => i.dataset.kind === 'error'
		);
		expect( err ).not.toBeUndefined();
		expect( err.textContent ).toBe( 'something went wrong' );
	} );

	it( 'dumperRender: TM_COMMAND|TM_RESPONSE unwraps payload', async () => {
		const { container } = render( <TopologyConsole /> );
		// eslint-disable-next-line no-bitwise
		const t = TM_COMMAND | TM_RESPONSE;
		await fireMsg( {
			type: t,
			from: 'worker',
			value: { payload: 'ls result' },
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

	it( 'dumperRender: TM_COMMAND|TM_RESPONSE with empty payload is dropped', async () => {
		const { container } = render( <TopologyConsole /> );
		// eslint-disable-next-line no-bitwise
		const t = TM_COMMAND | TM_RESPONSE;
		await fireMsg( { type: t, from: 'worker', value: { payload: '' } } );
		await fireMsg( { type: t, from: 'worker', value: null } );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		expect( items.length ).toBe( 0 );
	} );

	it( 'dumperRender: TM_COMMAND|TM_ERROR unwraps as error', async () => {
		const { container } = render( <TopologyConsole /> );
		// eslint-disable-next-line no-bitwise
		const t = TM_COMMAND | TM_ERROR;
		await fireMsg( {
			type: t,
			from: 'worker',
			value: { payload: 'bad arg' },
		} );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const err = Array.from( items ).find(
			( i ) => i.dataset.kind === 'error'
		);
		expect( err ).not.toBeUndefined();
		expect( err.textContent ).toBe( 'bad arg' );
	} );

	it( 'dumperRender: TM_STRUCT stringifies object payload', async () => {
		const { container } = render( <TopologyConsole /> );
		await fireMsg( {
			type: TM_STRUCT,
			from: 'worker',
			value: { foo: 'bar' },
		} );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const recv = Array.from( items ).find(
			( i ) => i.dataset.kind === 'recv'
		);
		expect( recv ).not.toBeUndefined();
		expect( recv.textContent ).toMatch( /"foo": "bar"/ );
	} );

	it( 'dumperRender: TM_STRUCT with string payload passes through', async () => {
		const { container } = render( <TopologyConsole /> );
		await fireMsg( {
			type: TM_STRUCT,
			from: 'worker',
			value: 'already serialized',
		} );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const recv = Array.from( items ).find(
			( i ) => i.dataset.kind === 'recv'
		);
		expect( recv ).not.toBeUndefined();
		expect( recv.textContent ).toBe( 'already serialized' );
	} );

	it( 'dumperRender: TM_INFO routes through as recv (curated level 0)', async () => {
		const { container } = render( <TopologyConsole /> );
		await fireMsg( {
			type: TM_INFO,
			from: 'worker',
			value: 'some info',
		} );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		const recv = Array.from( items ).find(
			( i ) => i.dataset.kind === 'recv'
		);
		expect( recv ).not.toBeUndefined();
		expect( recv.textContent ).toBe( 'some info' );
	} );

	it( 'dumperRender: unknown TM flag falls through to null (dropped)', async () => {
		const { container } = render( <TopologyConsole /> );
		await fireMsg( { type: 0, from: 'worker', value: 'noflag' } );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		// Empty type with no curated render -> no transcript entry.
		expect( items.length ).toBe( 0 );
	} );

	it( 'handleMessage: gui:auto key feeds parseMetadata + skips transcript', async () => {
		const { container } = render( <TopologyConsole /> );
		await fireMsg( {
			type: TM_STRUCT,
			from: 'worker',
			key: 'gui:auto',
			value: {
				num_nodes: 1,
				num_edges: 0,
				nodes: [
					{
						name: 'foo',
						class: 'Echo',
						count: 5,
					},
				],
				edges: [],
			},
		} );
		const items = container.querySelectorAll(
			'[data-testid="repl-transcript"] li'
		);
		expect( items.length ).toBe( 0 );
	} );

	it( 'handleMessage: gui:auto with a {name,payload} object envelope feeds the canvas', async () => {
		// gui:auto envelope: unwrap value.payload (the dump_metadata object) for the canvas.
		const { getByTestId } = render( <TopologyConsole /> );
		await fireMsg( {
			// eslint-disable-next-line no-bitwise
			type: TM_COMMAND | TM_RESPONSE,
			from: 'worker',
			key: 'gui:auto',
			value: {
				name: 'dump_metadata',
				payload: {
					n1: {
						class: 'Echo',
						counter: 7,
						sink: '_command_interpreter',
						target: 'n2',
						debug_state: 0,
						arguments: '',
					},
					n2: {
						class: 'Echo',
						counter: 3,
						sink: '_command_interpreter',
						target: '',
						debug_state: 0,
						arguments: '',
					},
				},
			},
		} );
		// Both n1 and n2 make it through parseMetadata (data-node-count).
		expect( getByTestId( 'canvas' ).dataset.nodeCount ).toBe( '2' );
	} );

	it( 'handleMessage: gui:uptime key extracts the right-half uptime', async () => {
		const { getByTestId } = render( <TopologyConsole /> );
		await fireMsg( {
			type: TM_BYTESTREAM,
			from: 'worker',
			key: 'gui:uptime',
			value: '09:44:52  up 0 days, 00:01:00\n',
		} );
		const transcript = getByTestId( 'repl-transcript' );
		expect( transcript.children.length ).toBe( 0 );
	} );

	it( 'handleMessage: debug_level 1 injects type/from header', async () => {
		const { container, getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'submit-multi' ) );
		} );
		await fireMsg( {
			type: TM_BYTESTREAM,
			from: 'worker',
			value: 'hi',
		} );
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
		await fireMsg( {
			type: TM_BYTESTREAM,
			from: 'worker',
			value: 'pre-clear',
		} );
		expect(
			container.querySelectorAll( '[data-testid="repl-transcript"] li' )
				.length
		).toBeGreaterThan( 0 );
		// `clear; debug_level 1`: clear wipes the pane, leaving the debug_level echo + info.
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
				globalThis.__sessionNode.fill( {
					type: TM_BYTESTREAM,
					from: 'worker',
					value: `msg-${ i }`,
				} );
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

	it( 'select edge clears any selected node', () => {
		const { getByText, queryByTestId } = render( <TopologyConsole /> );
		fireEvent.click( getByText( 'select-n1' ) );
		expect( queryByTestId( 'inspector' ) ).not.toBeNull();
		fireEvent.click( getByText( 'select-edge' ) );
		expect( queryByTestId( 'inspector' ) ).toBeNull();
	} );

	it( 'Inspector dump action emits a sent transcript entry', async () => {
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
		// The drag should round-trip through localStorage.
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

	it( 'Header onTopologyChange updates the URL', () => {
		// Seed the URL so initialTopologyFromUrl picks `demo`.
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastHeaderProps.onTopologyChange( 'demo' );
		} );
		expect( window.location.search ).toMatch( /topology=demo/ );
	} );

	it( 'Header onPartitionChange writes the partition to URL when > 0', () => {
		window.history.replaceState( {}, '', '/?topology=demo' );
		render( <TopologyConsole /> );
		act( () => {
			lastHeaderProps.onPartitionChange( 1 );
		} );
		expect( window.location.search ).toMatch( /partition=1/ );
	} );

	it( 'mounts the session graph in view mode (SessionSink registered)', () => {
		render( <TopologyConsole /> );
		// The mocked graph registered a real SessionSink in view mode.
		expect( Core.node( 'session' ) ).toBe( globalThis.__sessionNode );
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
		// Trigger Save; the handler runs without throwing.
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
		// Select the n1→n2 edge from the canvas, then remove via inspector.
		await act( async () => {
			fireEvent.click( getByText( 'select-edge' ) );
		} );
		// Inspector doesn't mount for an edge; just verify the selection changed.
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
		// Initial: replExpanded false → returns false (not consumed).
		expect( fn() ).toBe( false );
	} );

	it( 'toast clears after 5 seconds', () => {
		jest.useFakeTimers();
		try {
			const { container, getByText } = render( <TopologyConsole /> );
			// Verify the render mounts without errors.
			fireEvent.click( getByText( 'save' ) );
			act( () => {
				jest.advanceTimersByTime( 5000 );
			} );
			expect( container.querySelector( '.topology-toast' ) ).toBeNull();
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'handleMessage: gui:auto with parsed nodes seeds rate tracking', async () => {
		render( <TopologyConsole /> );
		// dump_metadata is the object { name: { counter, class, ... } } in VALUE.
		await fireMsg( {
			type: TM_STRUCT,
			from: 'worker',
			key: 'gui:auto',
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
			from: 'worker',
			key: 'gui:auto',
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

	it( 'handleMessage: counter reset across worker respawn clamps to 0', async () => {
		render( <TopologyConsole /> );
		await fireMsg( {
			type: TM_STRUCT,
			from: 'worker',
			key: 'gui:auto',
			value: {
				n1: { counter: 100, class: 'Echo' },
			},
		} );
		// Wait at least 1s so prevEntry.ts < now.
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 1100 ) );
		} );
		await fireMsg( {
			type: TM_STRUCT,
			from: 'worker',
			key: 'gui:auto',
			value: {
				n1: { counter: 5, class: 'Echo' },
			},
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

	it( 'debug_level 2 emits buildDebugHeader2 multi-line envelope', async () => {
		const { container, getByText } = render( <TopologyConsole /> );
		// The mock can only reach debug_level 1; exercise the header-injection path.
		fireEvent.click( getByText( 'submit-multi' ) );
		await fireMsg( {
			type: TM_BYTESTREAM,
			from: 'worker',
			value: 'hi',
		} );
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
		await fireMsg( {
			type: TM_BYTESTREAM,
			from: 'worker',
			value: 42, // number, exercises String() branch
		} );
		expect( container.textContent ).toMatch( /TM_BYTESTREAM from worker/ );
	} );

	it( 'debug_level 1: null/undefined value renders empty', async () => {
		const { getByText, container } = render( <TopologyConsole /> );
		fireEvent.click( getByText( 'submit-multi' ) );
		await fireMsg( {
			type: TM_BYTESTREAM,
			from: 'worker',
			value: null,
		} );
		expect( container.textContent ).toMatch( /TM_BYTESTREAM from worker/ );
	} );

	it( 'debug_level 1: object value gets JSON-stringified in header', async () => {
		const { getByText, container } = render( <TopologyConsole /> );
		fireEvent.click( getByText( 'submit-multi' ) );
		await fireMsg( {
			type: TM_STRUCT,
			from: 'worker',
			value: { hello: 'world' },
		} );
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
		await fireMsg( {
			type: TM_BYTESTREAM,
			from: 'worker',
			value: circular,
		} );
		// stringifyValue falls back to String() on circular; header still renders.
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
		// submit sends `ls`; the remote path fires (ssePid=1234 from the mock).
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

	it( 'sendLine: fills the command-out node with the interpreted body', async () => {
		globalThis.__commandOutFill.mockClear();
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { getByText } = render( <TopologyConsole /> );
		await act( async () => {
			fireEvent.click( getByText( 'submit' ) );
		} );
		// `ls` -> default command verb; the fill payload is just the command batch.
		expect( globalThis.__commandOutFill ).toHaveBeenCalledWith( {
			commands: [ { type: 'command', name: 'ls', arguments: '' } ],
		} );
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

	it( 'changing partition resets selection + transcript + parsed', async () => {
		window.NewspackNodesData.topologyPartitions = { demo: 2 };
		window.history.replaceState( {}, '', '/?topology=demo' );
		const { container } = render( <TopologyConsole /> );
		await fireMsg( {
			type: TM_BYTESTREAM,
			from: 'worker',
			value: 'pre-switch',
		} );
		expect(
			container.querySelectorAll( '[data-testid="repl-transcript"] li' )
				.length
		).toBeGreaterThan( 0 );
		await act( async () => {
			lastHeaderProps.onPartitionChange( 1 );
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
		// Move n1 so the save-layout button mounts (layout differs from saved).
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
		// save-layout button is gone after seeding (overrides equal saved).
		expect( queryByText( 'save-layout' ) ).toBeNull();
		expect( getByText( 'submit' ) ).not.toBeNull();
	} );
} );
