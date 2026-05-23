/**
 * TopologyConsole — top-level shell.
 */

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';

import CanvasFrame from './components/CanvasFrame';
import Header from './components/Header';
import Inspector from './components/Inspector';
import { ConfirmModal, PromptModal } from './components/Modal';
import Palette from './components/Palette';
import ReplFooter from './components/ReplFooter';
import SchematicCanvas from './components/SchematicCanvas';

import OpenTopologyModal from './components/OpenTopologyModal';

import { useClassCatalog } from './hooks/useClassCatalog';
import { useLayout } from './hooks/useLayout';
import { useSaveTopology } from './hooks/useSaveTopology';
import { useDeleteTopology } from './hooks/useDeleteTopology';
import { useTopology, useTopologyList } from './hooks/useTopologyList';
import { useConsoleGraph } from './hooks/useConsoleGraph';
import { useNodeState, useNodeFill } from '../runtime/react';
import {
	addEdge,
	addNode,
	generateNodeName,
	removeEdge,
	removeNode,
	renameNode,
	updateNodeArgs,
	updateNodeVerbs,
} from './utils/draftGraph';
import {
	NODE_H,
	NODE_W,
	X_PAD,
	X_STEP,
	Y_PAD,
	Y_STEP,
} from './utils/autoLayout';
import { parseTsl } from './utils/parseTsl';
import { serializeTsl } from './utils/serializeTsl';
import { splitStatements } from './nodes/shell';
import { Core } from '../runtime/core';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	KEY,
	VALUE,
	LOCAL,
	TM_COMMAND,
	TM_REQUEST,
} from '../runtime/message';
import names from '../runtime/reserved-node-names.json';
import { THEMES, DEFAULT_THEME, isValidTheme } from './themes';

function topologyMap() {
	return (
		( window.NewspackNodesData &&
			window.NewspackNodesData.topologyPartitions ) ||
		{}
	);
}

function activeTopologySet() {
	const list =
		( window.NewspackNodesData &&
			window.NewspackNodesData.activeTopologies ) ||
		[];
	return new Set( list );
}

// Active topologies sort to the top of the dropdown, then alphabetical.
function sortedTopologies() {
	const all = Object.keys( topologyMap() );
	const active = activeTopologySet();
	return [ ...all ].sort( ( a, b ) => {
		const ad = active.has( a ) ? 0 : 1;
		const bd = active.has( b ) ? 0 : 1;
		return ad !== bd ? ad - bd : a.localeCompare( b );
	} );
}

const TOPOLOGIES = sortedTopologies();

function partitionList( topology ) {
	const n = topologyMap()[ topology ] || 1;
	return Array.from( { length: n }, ( _, i ) => i );
}

// '_sse/{topology}.p{N}' → { topology, partition }; any other cwd → null.
function parseWorker( cwd ) {
	const m = String( cwd ).match( /^_sse\/(.+)\.p(\d+)$/ );
	return m ? { topology: m[ 1 ], partition: Number( m[ 2 ] ) } : null;
}

// The longest worker menu item (`_sse/{topology}.p{N}`) that is a path-prefix of
// `path` — the worker whose subtree contains it. `cd`-ing onto a worker OR into
// any node beneath it resolves to that worker's mount; non-worker paths (roots,
// `_http`, …) resolve to null. Returns { topology, partition } | null.
function longestWorkerPrefix( path, options ) {
	let best = null;
	for ( const opt of options ) {
		if ( ! parseWorker( opt ) ) {
			continue;
		}
		if ( path === opt || path.startsWith( opt + '/' ) ) {
			if ( null === best || opt.length > best.length ) {
				best = opt;
			}
		}
	}
	return best ? parseWorker( best ) : null;
}

function readUrlParam( key ) {
	try {
		return new URLSearchParams( window.location.search ).get( key );
	} catch ( _e ) {
		return null;
	}
}
function initialTopologyFromUrl( fallback ) {
	const t = readUrlParam( 'topology' );
	return t && Object.prototype.hasOwnProperty.call( topologyMap(), t )
		? t
		: fallback;
}
function initialPartitionFromUrl() {
	const p = parseInt( readUrlParam( 'partition' ) || '0', 10 );
	return Number.isInteger( p ) && p >= 0 ? p : 0;
}

// 60 samples at 1s poll = ~1 minute of trailing rate history.
const RATE_HISTORY_MAX = 60;

// Stable empty defaults so unpopulated state keeps a constant reference.
const EMPTY_GRAPH = { nodes: [], edges: [] };
const EMPTY_TRANSCRIPT = [];

const THEME_STORAGE_KEY = 'newspack-nodes:topology:theme';

// Read the persisted skin; unknown/absent/disabled storage falls back to default.
function readStoredTheme() {
	try {
		const slug = window.localStorage.getItem( THEME_STORAGE_KEY );
		return isValidTheme( slug ) ? slug : DEFAULT_THEME;
	} catch ( _err ) {
		return DEFAULT_THEME;
	}
}

export default function TopologyConsole() {
	const [ topology, setTopology ] = useState( () =>
		initialTopologyFromUrl( TOPOLOGIES[ 0 ] )
	);
	const [ partition, setPartition ] = useState( () =>
		initialPartitionFromUrl()
	);
	const [ selectedId, setSelectedId ] = useState( null );
	// Mutually exclusive with selectedId — clicking either clears the other.
	const [ selectedEdge, setSelectedEdge ] = useState( null );
	const [ hoveredId, setHoveredId ] = useState( null );
	// `edit` freezes a draft snapshot so SSE pushes can't clobber it;
	// `baseline` is the draft at edit-entry, so the dirty check compares
	// against real edits rather than live SSE counter churn.
	const [ mode, setMode ] = useState( 'view' );
	const [ draft, setDraft ] = useState( { nodes: [], edges: [] } );
	const [ baseline, setBaseline ] = useState( { nodes: [], edges: [] } );
	const [ editingName, setEditingName ] = useState( '' );
	const [ discardModal, setDiscardModal ] = useState( null );
	const [ saveModal, setSaveModal ] = useState( null );
	const [ openModalShown, setOpenModalShown ] = useState( false );
	const [ toast, setToast ] = useState( null );
	const [ theme, setThemeState ] = useState( readStoredTheme );
	const setTheme = useCallback( ( slug ) => {
		const next = isValidTheme( slug ) ? slug : DEFAULT_THEME;
		setThemeState( next );
		try {
			window.localStorage.setItem( THEME_STORAGE_KEY, next );
		} catch ( _err ) {
			// localStorage disabled/quota'd; in-session only.
		}
	}, [] );
	const saveTopology = useSaveTopology();
	const deleteTopology = useDeleteTopology();
	const fetchTopology = useTopology();
	const topologyList = useTopologyList( { enabled: openModalShown } );
	const catalog = useClassCatalog( { enabled: true } );
	const [ replExpanded, setReplExpanded ] = useState( false );
	const replInputRef = useRef( null );
	const refocusReplIfExpanded = useCallback( () => {
		if ( replExpanded ) {
			window.requestAnimationFrame( () => replInputRef.current?.focus() );
		}
	}, [ replExpanded ] );

	// Per-node rate tracking, keyed by node id; rate = Δcount/Δs across ticks.
	const rateRef = useRef( new Map() );
	const [ rateVersion, setRateVersion ] = useState( 0 );

	// Dumper verbosity dial (0/1/2), mirroring the substrate Dumper. A ref
	// so the Dumper reads it per-frame without re-binding the graph.
	const debugLevelRef = useRef( 0 );

	// SSE off in edit mode so offline authoring doesn't poke the live worker.
	const { status, ssePid, shell } = useConsoleGraph( {
		topology,
		partition,
		enabled: mode !== 'edit',
		debugLevelRef,
	} );

	// Canvas/transcript state lives on dedicated nodes (WIRING-PLAN §4): the
	// Dumper (`_output`) is transcript-only; `_metadata` / `_uptime` publish the
	// silent-poll replies the Router routes to them.
	const parsed = useNodeState( names.METADATA, 'metadata' ) ?? EMPTY_GRAPH;
	const uptime = useNodeState( names.UPTIME, 'uptime' ) ?? null;
	// Tab-completion candidates from the `_completion` node ( { candidates, seq } ).
	const completion = useNodeState( names.COMPLETION, 'candidates' ) ?? null;
	const transcript =
		useNodeState( names.OUTPUT, 'transcript' ) ?? EMPTY_TRANSCRIPT;

	// The silent canvas polls fill the CommandInterpreter directly (§5).
	const fillCommandInterpreter = useNodeFill( names.COMMAND_INTERPRETER );

	// Shell cwd mirrored into React so the prompt + the canvas poll follow `cd`.
	// `shell.path` is the source of truth; a graph swap (topology/partition change)
	// remounts the Shell with a fresh path, so re-sync whenever `shell` changes.
	const [ cwd, setCwd ] = useState( '' );
	useEffect( () => {
		if ( shell ) {
			setCwd( shell.path );
		}
	}, [ shell ] );

	// Scoped per topology.partition so positions don't bleed between workers.
	const positionStorageKey = `newspack-nodes:topology:${ topology }.p${ partition }:positions`;
	// Entries: { x, y, user?: boolean }. Only user-tagged drags persist and
	// toggle "Reset Layout"; auto-seeded positions stay in-memory only.
	const [ positionOverrides, setPositionOverrides ] = useState( {} );
	useEffect( () => {
		try {
			const raw = window.localStorage.getItem( positionStorageKey );
			const loaded = raw ? JSON.parse( raw ) : {};
			const tagged = {};
			for ( const [ id, p ] of Object.entries( loaded ) ) {
				tagged[ id ] = { x: p.x, y: p.y, user: true };
			}
			setPositionOverrides( tagged );
		} catch ( _err ) {
			setPositionOverrides( {} );
		}
	}, [ positionStorageKey ] );
	const handlePositionChange = useCallback(
		( nodeId, pos ) => {
			setPositionOverrides( ( prev ) => {
				const next = {
					...prev,
					[ nodeId ]: { x: pos.x, y: pos.y, user: true },
				};
				// Persist user-tagged entries only.
				const userOnly = {};
				for ( const [ id, p ] of Object.entries( next ) ) {
					if ( p.user ) {
						userOnly[ id ] = { x: p.x, y: p.y };
					}
				}
				try {
					window.localStorage.setItem(
						positionStorageKey,
						JSON.stringify( userOnly )
					);
				} catch ( _err ) {
					// localStorage disabled/quota'd; in-session only.
				}
				return next;
			} );
		},
		[ positionStorageKey ]
	);
	// Null means "no override" → canvas autofits. Writes debounce 200ms so
	// a pan-drag's 60 setState/sec doesn't hammer localStorage.
	const viewportStorageKey = `newspack-nodes:topology:${ topology }.p${ partition }:viewport`;
	const [ viewport, setViewport ] = useState( null );
	useEffect( () => {
		try {
			const raw = window.localStorage.getItem( viewportStorageKey );
			setViewport( raw ? JSON.parse( raw ) : null );
		} catch ( _err ) {
			setViewport( null );
		}
	}, [ viewportStorageKey ] );
	const viewportSaveTimerRef = useRef( null );
	const handleViewportChange = useCallback(
		( next ) => {
			setViewport( next );
			if ( viewportSaveTimerRef.current ) {
				clearTimeout( viewportSaveTimerRef.current );
			}
			viewportSaveTimerRef.current = setTimeout( () => {
				try {
					if ( next === null ) {
						window.localStorage.removeItem( viewportStorageKey );
					} else {
						window.localStorage.setItem(
							viewportStorageKey,
							JSON.stringify( next )
						);
					}
				} catch ( _err ) {
					// localStorage quota'd/disabled; in-memory only.
				}
			}, 200 );
		},
		[ viewportStorageKey ]
	);

	// Server-side saved layout; empty `positions` means Reset falls back to autoLayout.
	const [ savedLayout, setSavedLayout ] = useState( null );
	const { fetchLayout, saveLayout } = useLayout();
	const effectiveTopologyName =
		mode === 'edit' && editingName ? editingName : topology;

	useEffect( () => {
		if ( ! effectiveTopologyName ) {
			setSavedLayout( null );
			return;
		}
		// Null while fetching so the live-mode seed can't lock in stale positions.
		setSavedLayout( null );
		fetchLayout( effectiveTopologyName )
			.then( ( resp ) => {
				setSavedLayout( {
					positions: resp.positions || null,
				} );
			} )
			.catch( () => {
				setSavedLayout( { positions: null } );
			} );
	}, [ effectiveTopologyName, fetchLayout ] );

	const [ resetConfirm, setResetConfirm ] = useState( null );

	// Returns null on empty/malformed payload so callers can branch cleanly.
	const savedPositionsToOverrides = useCallback( ( layout ) => {
		const saved = layout && layout.positions;
		if ( ! saved || Object.keys( saved ).length === 0 ) {
			return null;
		}
		const next = {};
		for ( const [ id, xy ] of Object.entries( saved ) ) {
			if ( Array.isArray( xy ) && xy.length >= 2 ) {
				next[ id ] = { x: xy[ 0 ], y: xy[ 1 ] };
			}
		}
		return next;
	}, [] );

	// Edit-mode default is autoLayout; live-mode default is the saved layout.
	const applyLayoutReset = useCallback(
		( target ) => {
			const seeded =
				target === 'saved'
					? savedPositionsToOverrides( savedLayout )
					: null;
			setPositionOverrides( seeded ?? {} );
			try {
				window.localStorage.removeItem( positionStorageKey );
			} catch ( _err ) {
				// in-memory state is the important part
			}
			setTimeout( () => {
				setViewport( null );
				try {
					window.localStorage.removeItem( viewportStorageKey );
				} catch ( _err ) {
					// ignore
				}
			}, 0 );
		},
		[
			savedLayout,
			savedPositionsToOverrides,
			positionStorageKey,
			viewportStorageKey,
		]
	);

	const handleResetLayout = useCallback( () => {
		if ( mode === 'edit' ) {
			setResetConfirm( {
				onConfirm: () => {
					setResetConfirm( null );
					applyLayoutReset( 'auto' );
				},
				onCancel: () => setResetConfirm( null ),
			} );
			return;
		}
		applyLayoutReset( 'saved' );
	}, [ mode, applyLayoutReset ] );

	const handleSaveLayout = useCallback( async () => {
		if ( ! effectiveTopologyName ) {
			return;
		}
		const positions = {};
		for ( const [ id, p ] of Object.entries( positionOverrides ) ) {
			if ( p && Number.isFinite( p.x ) && Number.isFinite( p.y ) ) {
				positions[ id ] = [ p.x, p.y ];
			}
		}
		try {
			const resp = await saveLayout( {
				name: effectiveTopologyName,
				positions,
			} );
			setSavedLayout( { positions: resp.positions || null } );
			setToast( {
				kind: 'success',
				text: `Saved layout for ${ resp.name }.`,
			} );
		} catch ( e ) {
			const msg =
				( e && e.data && e.data.message ) ||
				( e && e.message ) ||
				'Save layout failed';
			setToast( { kind: 'error', text: msg } );
		}
	}, [ effectiveTopologyName, positionOverrides, saveLayout ] );
	const layoutsEqualSaved = useMemo( () => {
		const saved = ( savedLayout && savedLayout.positions ) || null;
		const overrideIds = Object.keys( positionOverrides );
		const savedIds = saved ? Object.keys( saved ) : [];
		if ( ! saved ) {
			return overrideIds.length === 0;
		}
		if ( overrideIds.length !== savedIds.length ) {
			return false;
		}
		for ( const id of overrideIds ) {
			const cur = positionOverrides[ id ];
			const sav = saved[ id ];
			if ( ! Array.isArray( sav ) || sav.length < 2 ) {
				return false;
			}
			if ( cur.x !== sav[ 0 ] || cur.y !== sav[ 1 ] ) {
				return false;
			}
		}
		return true;
	}, [ positionOverrides, savedLayout ] );
	const hasOverrides =
		mode === 'edit'
			? Object.keys( positionOverrides ).length > 0
			: ! layoutsEqualSaved;
	const layoutDirty = ! layoutsEqualSaved;

	const partitions = useMemo( () => partitionList( topology ), [ topology ] );

	// Every cwd the Path menu can select: the local graph, the request scope,
	// then one entry per worker — only for ACTIVE topologies (inactive ones have
	// no live workers to reach). An off-menu cwd is still surfaced by the Header.
	const pathOptions = useMemo( () => {
		const active = activeTopologySet();
		return [
			'',
			'_sse',
			...sortedTopologies()
				.filter( ( t ) => active.has( t ) )
				.flatMap( ( t ) =>
					partitionList( t ).map( ( p ) => `_sse/${ t }.p${ p }` )
				),
		];
	}, [] );

	// Path selection — shared by the Path menu and REPL `cd`. Sets the cwd to the
	// path verbatim (free navigation: ANY path is allowed), then mounts the
	// deepest worker whose subtree contains it (the largest worker-prefix among
	// menu items). Mounting a DIFFERENT worker re-keys the graph and re-subscribes
	// `_sse` to its output (the rebuilt shell remounts at _sse/{worker}; the
	// [shell] effect syncs cwd). Staying within the current worker — or any
	// non-worker path — is a pure cwd move with no rebuild.
	const handlePathChange = useCallback(
		( nextPath ) => {
			if ( shell ) {
				shell.path = nextPath;
			}
			setCwd( nextPath );
			const worker = longestWorkerPrefix( nextPath, pathOptions );
			if (
				worker &&
				( worker.topology !== topology ||
					worker.partition !== partition )
			) {
				setTopology( worker.topology );
				setPartition( worker.partition );
			}
		},
		[ topology, partition, shell, pathOptions ]
	);

	// Reset to p0 when switching to a topology with fewer partitions.
	useEffect( () => {
		if ( partition >= partitions.length ) {
			setPartition( 0 );
		}
	}, [ partitions, partition ] );

	// Mirror (topology, partition) into the URL via replaceState (filter
	// toggles, not navigation); partition=0 stays out to keep links minimal.
	useEffect( () => {
		try {
			const url = new URL( window.location.href );
			if ( topology ) {
				url.searchParams.set( 'topology', topology );
			} else {
				url.searchParams.delete( 'topology' );
			}
			if ( partition > 0 ) {
				url.searchParams.set( 'partition', String( partition ) );
			} else {
				url.searchParams.delete( 'partition' );
			}
			window.history.replaceState( null, '', url.toString() );
		} catch ( _e ) {
			// SSR / restricted-context fallback — URL just won't update.
		}
	}, [ topology, partition ] );

	// Resolve the Dumper at call time so a graph swap (partition change) targets
	// the live node, not a torn-down one.
	const appendTranscript = useCallback( ( entry ) => {
		Core.node( names.OUTPUT )?.append( entry );
	}, [] );

	const clearTranscript = useCallback( () => {
		Core.node( names.OUTPUT )?.clear();
	}, [] );

	useEffect( () => {
		setSelectedId( null );
	}, [ topology, partition ] );

	// Per-node msg/s + byte/s rate tracking; one tick per published metadata
	// object. Negatives (worker respawn resets the counters) clamp to zero.
	useEffect( () => {
		const now = Date.now() / 1000;
		let touched = false;
		for ( const n of parsed.nodes ) {
			const prevEntry = rateRef.current.get( n.id );
			const bytesRead = n.bytesRead || 0;
			const bytesWritten = n.bytesWritten || 0;
			// Sticky "has ever been non-zero" flags so a counter reset
			// (worker respawn) doesn't blink the Inspector sparkline out.
			const hasMessages =
				( prevEntry && prevEntry.hasMessages ) || n.count > 0;
			const hasRead = ( prevEntry && prevEntry.hasRead ) || bytesRead > 0;
			const hasWritten =
				( prevEntry && prevEntry.hasWritten ) || bytesWritten > 0;
			if ( prevEntry && prevEntry.ts < now ) {
				// Negative delta = worker respawn; treat as rate unknown (0).
				const rawDCount = n.count - prevEntry.count;
				const dCount = rawDCount < 0 ? 0 : rawDCount;
				const rawDRead = bytesRead - ( prevEntry.bytesRead || 0 );
				const dRead = rawDRead < 0 ? 0 : rawDRead;
				const rawDWritten =
					bytesWritten - ( prevEntry.bytesWritten || 0 );
				const dWritten = rawDWritten < 0 ? 0 : rawDWritten;
				// Clamp dt to >=1s so bunched-up responses don't report a spike.
				const dTime = Math.max( 1, now - prevEntry.ts );
				const rate = dCount / dTime;
				const readRate = dRead / dTime;
				const writtenRate = dWritten / dTime;
				const history = prevEntry.history || [];
				const readHistory = prevEntry.readHistory || [];
				const writtenHistory = prevEntry.writtenHistory || [];
				history.push( rate );
				readHistory.push( readRate );
				writtenHistory.push( writtenRate );
				if ( history.length > RATE_HISTORY_MAX ) {
					history.shift();
				}
				if ( readHistory.length > RATE_HISTORY_MAX ) {
					readHistory.shift();
				}
				if ( writtenHistory.length > RATE_HISTORY_MAX ) {
					writtenHistory.shift();
				}
				rateRef.current.set( n.id, {
					count: n.count,
					bytesRead,
					bytesWritten,
					ts: now,
					rate,
					readRate,
					writtenRate,
					lastChangedTs: dCount > 0 ? now : prevEntry.lastChangedTs,
					history,
					readHistory,
					writtenHistory,
					hasMessages,
					hasRead,
					hasWritten,
				} );
				touched = true;
			} else if ( ! prevEntry ) {
				rateRef.current.set( n.id, {
					count: n.count,
					bytesRead,
					bytesWritten,
					ts: now,
					rate: 0,
					readRate: 0,
					writtenRate: 0,
					lastChangedTs: now,
					history: [],
					readHistory: [],
					writtenHistory: [],
					hasMessages,
					hasRead,
					hasWritten,
				} );
				touched = true;
			}
		}
		if ( touched ) {
			setRateVersion( ( v ) => v + 1 );
		}
	}, [ parsed ] );

	const dispatchStatement = useCallback(
		( statement ) => {
			if ( ! shell ) {
				return;
			}
			// Shell.parse → null (empty/comment), a local/error signal, or a
			// positional Message. We branch BEFORE filling so the ssePid gate
			// only blocks worker-bound sends, not local builtins.
			// Capture the prompt the user typed AT before `cd` mutates the path, so
			// the echoed entry keeps its own prompt instead of re-rendering on cd.
			const promptAtSend = `/${ shell.path }`;
			const parsedLine = shell.parse( statement );
			// `cd` mutates shell.path and returns null; route the new path through
			// the same handler the Path menu uses so a `cd` onto (or into) a worker
			// mounts it exactly like a menu pick — prompt, canvas poll, and `_sse`
			// subscription all follow.
			handlePathChange( shell.path );
			// Echo the user's input verbatim, tagged with the prompt at send time.
			// Before the null-return so `cd` (which parses to null) still shows in
			// the transcript like every other builtin; blank lines stay silent.
			if ( '' !== statement.trim() ) {
				appendTranscript( {
					kind: 'sent',
					text: statement,
					prompt: promptAtSend,
				} );
			}
			if ( null === parsedLine ) {
				return;
			}

			if ( Array.isArray( parsedLine ) ) {
				// A worker-bound Message; the reply arrives async over SSE.
				if ( ! ssePid ) {
					appendTranscript( {
						kind: 'error',
						text: '[no sse_pid yet] retry once CONNECTED',
					} );
					return;
				}
				shell.sink?.fill( parsedLine );
				return;
			}
			if ( parsedLine.kind === 'error' ) {
				appendTranscript( { kind: 'error', text: parsedLine.text } );
				return;
			}
			if ( parsedLine.kind === 'local' ) {
				if ( parsedLine.name === 'clear' ) {
					clearTranscript();
				} else if ( parsedLine.name === 'debug_level' ) {
					// Substrate Shell semantics: no-arg toggles 0/1, numeric clamps 0..2.
					if ( parsedLine.level === null ) {
						debugLevelRef.current =
							debugLevelRef.current > 0 ? 0 : 1;
					} else {
						debugLevelRef.current = Math.max(
							0,
							Math.min( 2, parsedLine.level )
						);
					}
					appendTranscript( {
						kind: 'info',
						text: `debug_level: ${ debugLevelRef.current }`,
					} );
				} else if ( parsedLine.name === 'echo' ) {
					appendTranscript( { kind: 'recv', text: parsedLine.text } );
				} else if ( parsedLine.name === 'status' ) {
					for ( const line of parsedLine.lines ) {
						appendTranscript( { kind: 'recv', text: line } );
					}
				} else if ( parsedLine.name === 'show_parse' ) {
					appendTranscript( {
						kind: 'info',
						text: `show_parse: ${ parsedLine.on ? 'on' : 'off' }`,
					} );
				}
			}
		},
		[ shell, ssePid, appendTranscript, clearTranscript, handlePathChange ]
	);

	// Live-canvas poll gating (WIRING-PLAN §4/§5). The Router TIMER in
	// useConsoleGraph drives emission; here we just point the poll nodes at the
	// shell's CURRENT path (cwd) and gate it — null pollTo makes onTimer a no-op,
	// so edit mode / pre-pid emit nothing and HttpOut.flush() posts an empty
	// buffer = no request.
	useEffect( () => {
		const to = mode !== 'edit' && ssePid ? cwd : null;
		const meta = Core.node( names.METADATA );
		const up = Core.node( names.UPTIME );
		if ( meta ) {
			meta.pollTo = to;
		}
		if ( up ) {
			up.pollTo = to;
		}
	}, [ mode, ssePid, cwd ] );

	// Tab-completion query (WIRING-PLAN §5 sibling of the canvas poll). The verb
	// depends on cursor context: completing the FIRST token (the command word) →
	// `help` (verb names); completing a LATER token (a node-name arg) → `ls`
	// (node names). KEY='completion' tells the worker's CI to emit a bare
	// candidate list; FROM pivots the reply to the silent `_completion` node.
	const requestCompletion = useCallback(
		( line ) => {
			if ( ! ssePid ) {
				return;
			}
			// First token iff there's no whitespace before the trailing token.
			const onFirstToken = ! /\s/.test( String( line ).trimStart() );
			const verb = onFirstToken ? 'help' : 'ls';
			const m = newMessage();
			m[ TYPE ] = TM_COMMAND;
			m[ FROM ] = names.COMPLETION;
			m[ TO ] = cwd;
			m[ KEY ] = 'completion';
			m[ VALUE ] = { name: verb, arguments: '', payload: '' };
			m[ LOCAL ] = true;
			fillCommandInterpreter( m );
		},
		[ ssePid, cwd, fillCommandInterpreter ]
	);

	// List completion candidates into the transcript (readline two-stage).
	const handleShowCandidates = useCallback(
		( candidates ) => {
			appendTranscript( {
				kind: 'recv',
				text: ( candidates || [] ).join( '  ' ),
			} );
		},
		[ appendTranscript ]
	);

	// Split on unquoted `;` so `help; ls` dispatches as two commands.
	const sendLine = useCallback(
		( line ) => {
			for ( const stmt of splitStatements( line ) ) {
				dispatchStatement( stmt );
			}
		},
		[ dispatchStatement ]
	);

	// Route Inspector actions through sendLine so they echo in the transcript.
	const handleInspectorAction = useCallback(
		( action, nodeId, payload ) => {
			if ( action === 'dump' ) {
				sendLine( `dump_node ${ nodeId }` );
			} else if ( action === 'tail' ) {
				sendLine( `connect_node ${ nodeId }` );
			} else if ( action === 'disconnect' ) {
				sendLine( `disconnect_node ${ nodeId }` );
			} else if ( action === 'send' ) {
				sendLine( `send_node ${ nodeId } ${ payload }` );
			} else if ( action === 'trace' ) {
				// payload is the target debug level (0 disable, 1 enable).
				const level = typeof payload === 'number' ? payload : 1;
				sendLine( `debug_state ${ nodeId } ${ level }` );
			} else if ( action === 'invoke' ) {
				// Unified verb invocation: TM_COMMAND (kind 'command') or
				// TM_REQUEST (kind 'request'), with args delivered both as a
				// positional string and a by-name payload map.
				if ( ! shell ) {
					return;
				}
				if ( ! ssePid ) {
					appendTranscript( {
						kind: 'error',
						text: '[no sse_pid yet] retry once CONNECTED',
					} );
					return;
				}
				const { verb, kind, positional, byName } = payload;
				const to = shell.prefix( nodeId );
				const m = newMessage();
				m[ TO ] = to;
				m[ FROM ] = shell.replyFrom( names.OUTPUT );
				m[ LOCAL ] = true;
				let echo;
				if ( 'request' === kind ) {
					m[ TYPE ] = TM_REQUEST;
					m[ VALUE ] = positional
						? `${ verb } ${ positional }`
						: verb;
					echo = `request_node ${ nodeId } ${ verb }${
						positional ? ' ' + positional : ''
					}`;
				} else {
					m[ TYPE ] = TM_COMMAND;
					m[ VALUE ] = {
						name: verb,
						arguments: positional,
						payload: byName,
					};
					echo = `command_node ${ nodeId } ${ verb }${
						positional ? ' ' + positional : ''
					}`;
				}
				appendTranscript( {
					kind: 'sent',
					text: echo,
					prompt: `/${ shell.path }`,
				} );
				shell.sink?.fill( m );
			}
			// Pop the transcript + focus the prompt to show the worker's reply.
			setReplExpanded( true );
			window.requestAnimationFrame( () => replInputRef.current?.focus() );
		},
		[ sendLine, shell, ssePid, appendTranscript ]
	);

	// Synthesize virtual edges from node_name verb args so autoLayout places
	// verb-targeted nodes in the right column instead of stacking at column 0.
	const augmentWithVirtualEdges = useCallback(
		( graph ) => {
			const classByName = new Map();
			for ( const c of catalog.classes || [] ) {
				classByName.set( c.shell_name, c );
			}
			const virtualEdges = [];
			for ( const node of graph.nodes ) {
				const schema = classByName.get( node.class );
				if ( ! schema || ! schema.verbs ) {
					continue;
				}
				for ( const inv of node.verbInvocations || [] ) {
					const vspec = schema.verbs.find(
						( v ) => v.name === inv.verb
					);
					if ( ! vspec || ! vspec.args ) {
						continue;
					}
					vspec.args.forEach( ( argSpec, i ) => {
						if ( argSpec.type !== 'node_name' ) {
							return;
						}
						const targetName = inv.args && inv.args[ i ];
						if ( ! targetName ) {
							return;
						}
						virtualEdges.push( {
							from: node.id,
							to: targetName,
							virtual: true,
						} );
					} );
				}
			}
			if ( ! virtualEdges.length ) {
				return graph;
			}
			return {
				nodes: graph.nodes,
				edges: [ ...graph.edges, ...virtualEdges ],
			};
		},
		[ catalog.classes ]
	);

	// Merge savedLayout positions in without clobbering user-tagged drags.
	const seedOverridesFromLayout = useCallback( () => {
		const seeded = savedPositionsToOverrides( savedLayout );
		if ( ! seeded ) {
			return;
		}
		setPositionOverrides( ( prev ) => {
			const next = { ...prev };
			let changed = false;
			for ( const [ id, xy ] of Object.entries( seeded ) ) {
				if ( next[ id ] ) {
					continue;
				}
				next[ id ] = xy;
				changed = true;
			}
			return changed ? next : prev;
		} );
	}, [ savedLayout, savedPositionsToOverrides ] );

	// Re-seed when the catalog arrives (it may race the edit auto-load),
	// but only while the user hasn't started editing.
	useEffect( () => {
		if ( mode !== 'edit' ) {
			return;
		}
		if ( ! catalog.classes || catalog.classes.length === 0 ) {
			return;
		}
		if ( draft.nodes.length === 0 ) {
			return;
		}
		if ( JSON.stringify( draft ) !== JSON.stringify( baseline ) ) {
			return; // user has edited — don't clobber
		}
		seedOverridesFromLayout();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ catalog.classes, mode, savedLayout ] );

	// Live-mode seed: fires once per (topology, savedLayout) while overrides
	// are empty (the gate no-ops on later SSE ticks).
	useEffect( () => {
		if ( mode === 'edit' ) {
			return;
		}
		if ( Object.keys( positionOverrides ).length > 0 ) {
			return;
		}
		if ( ! savedPositionsToOverrides( savedLayout ) ) {
			return;
		}
		seedOverridesFromLayout();
		setViewport( null );
		try {
			window.localStorage.removeItem( viewportStorageKey );
		} catch ( _err ) {
			// in-memory state is the important part
		}
	}, [
		savedLayout,
		mode,
		positionOverrides,
		seedOverridesFromLayout,
		savedPositionsToOverrides,
		viewportStorageKey,
	] );

	// Edit-mode toggle. The draft is authoritative; SSE pushes don't clobber it.
	const handleModeChange = useCallback(
		( next ) => {
			if ( next === mode ) {
				return;
			}
			if ( next === 'edit' ) {
				// Auto-load the currently-live topology; blank canvas if none.
				setMode( 'edit' );
				setEditingName( '' );
				rateRef.current = new Map();
				setRateVersion( ( v ) => v + 1 );
				// Preserve overrides + viewport from a prior edit session.
				const blank = { nodes: [], edges: [] };
				setDraft( blank );
				setBaseline( blank );
				if ( topology ) {
					fetchTopology( topology )
						.then( ( resp ) => {
							const loaded = parseTsl( resp.tsl || '' );
							setDraft( loaded );
							setBaseline( loaded );
							setEditingName( resp.name );
							// Initial seed; the catalog-load effect re-seeds.
							seedOverridesFromLayout();
						} )
						.catch( () => {
							// Silent fallback — build from scratch or OPEN.
						} );
				}
				return;
			}
			// Dirty = draft diverged from the edit-entry snapshot (comparing
			// against live `parsed` would flag every session via SSE churn).
			const dirty =
				JSON.stringify( draft ) !== JSON.stringify( baseline );
			// Re-fit the live canvas when the edit session left stale positions:
			// a Reset (empty overrides) or editing a different topology.
			const isResetToAuto = Object.keys( positionOverrides ).length === 0;
			const editedDifferentTopology =
				editingName && editingName !== topology;
			if ( isResetToAuto || editedDifferentTopology ) {
				if ( editedDifferentTopology ) {
					setPositionOverrides( {} );
				}
				setViewport( null );
				try {
					window.localStorage.removeItem( viewportStorageKey );
				} catch ( _err ) {
					// in-memory state is the important part
				}
			}
			if ( ! dirty ) {
				setMode( 'view' );
				return;
			}
			setDiscardModal( {
				onConfirm: () => {
					setDiscardModal( null );
					setMode( 'view' );
				},
				onCancel: () => setDiscardModal( null ),
			} );
		},
		[
			mode,
			draft,
			baseline,
			topology,
			editingName,
			fetchTopology,
			seedOverridesFromLayout,
			positionOverrides,
			viewportStorageKey,
		]
	);

	// Source of truth: live `parsed` in view mode, frozen draft in edit mode.
	const baseCanvasGraph = mode === 'edit' ? draft : parsed;

	// Virtual node_name-verb edges are derived (not in draft.edges) and marked
	// `virtual` so the canvas dims them and skips the click-to-delete target.
	const canvasGraph = useMemo( () => {
		if ( mode !== 'edit' ) {
			return baseCanvasGraph;
		}
		return augmentWithVirtualEdges( baseCanvasGraph );
	}, [ baseCanvasGraph, mode, augmentWithVirtualEdges ] );

	const handleConnect = useCallback( ( from, to ) => {
		setDraft( ( g ) => {
			// Non-Tee nodes have a single target slot; Tees fan out.
			const fromNode = g.nodes.find( ( n ) => n.id === from );
			if ( fromNode && fromNode.class !== 'Tee' ) {
				let cleared = { nodes: g.nodes, edges: g.edges };
				for ( const e of g.edges ) {
					if ( e.from === from ) {
						cleared = removeEdge( cleared, e.from, e.to );
					}
				}
				return addEdge( cleared, { from, to } );
			}
			return addEdge( g, { from, to } );
		} );
	}, [] );

	const handleRemoveNode = useCallback(
		( id ) => {
			setDraft( ( g ) => removeNode( g, id ) );
			if ( selectedId === id ) {
				setSelectedId( null );
			}
		},
		[ selectedId ]
	);

	const handleRemoveEdge = useCallback(
		( from, to ) => {
			setDraft( ( g ) => removeEdge( g, from, to ) );
			if (
				selectedEdge &&
				selectedEdge.from === from &&
				selectedEdge.to === to
			) {
				setSelectedEdge( null );
			}
		},
		[ selectedEdge ]
	);

	// Node and edge selection are mutually exclusive (unambiguous Delete).
	const handleSelectNode = useCallback(
		( id ) => {
			setSelectedId( id );
			setSelectedEdge( null );
			refocusReplIfExpanded();
		},
		[ refocusReplIfExpanded ]
	);

	const handleSelectEdge = useCallback(
		( edge ) => {
			setSelectedEdge( edge );
			setSelectedId( null );
			refocusReplIfExpanded();
		},
		[ refocusReplIfExpanded ]
	);

	// First background click dismisses the prompt; return true so the canvas
	// skips its own deselect/autofit for this click.
	const handleCanvasBackgroundClickConsumed = useCallback( () => {
		if ( ! replExpanded ) {
			return false;
		}
		setReplExpanded( false );
		replInputRef.current?.blur();
		return true;
	}, [ replExpanded ] );

	// Edit-mode Delete/Backspace removes the selection (skipped in form fields).
	useEffect( () => {
		if ( mode !== 'edit' ) {
			return undefined;
		}
		const onKey = ( e ) => {
			if ( e.key !== 'Delete' && e.key !== 'Backspace' ) {
				return;
			}
			const target = e.target;
			const tag = target && target.tagName;
			if ( tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ) {
				return;
			}
			if ( target && target.isContentEditable ) {
				return;
			}
			if ( selectedId ) {
				e.preventDefault();
				handleRemoveNode( selectedId );
			} else if ( selectedEdge ) {
				e.preventDefault();
				handleRemoveEdge( selectedEdge.from, selectedEdge.to );
			}
		};
		document.addEventListener( 'keydown', onKey );
		return () => document.removeEventListener( 'keydown', onKey );
	}, [ mode, selectedId, selectedEdge, handleRemoveNode, handleRemoveEdge ] );

	const handleSave = useCallback( () => {
		setSaveModal( {} );
	}, [] );

	const handleOpen = useCallback( () => {
		setOpenModalShown( true );
	}, [] );

	const handleNew = useCallback( () => {
		const blank = { nodes: [], edges: [] };
		setDraft( blank );
		setBaseline( blank );
		setEditingName( '' );
		setSelectedId( null );
		setSelectedEdge( null );
		setPositionOverrides( {} );
		setViewport( null );
		rateRef.current = new Map();
		setRateVersion( ( v ) => v + 1 );
	}, [] );

	// DELETE shows only for a topology with a user-saved copy (stock is protected).
	const canDeleteCurrent = useMemo( () => {
		if ( mode !== 'edit' || ! editingName ) {
			return false;
		}
		const entry = ( topologyList.topologies || [] ).find(
			( t ) => t.name === editingName
		);
		return (
			!! entry && ( entry.source === 'user' || entry.source === 'both' )
		);
	}, [ mode, editingName, topologyList.topologies ] );

	const handleDelete = useCallback( async () => {
		if ( ! editingName ) {
			return;
		}
		// eslint-disable-next-line no-alert -- intentional confirm; this is a destructive action.
		const ok = window.confirm(
			`Delete user-saved topology "${ editingName }"? Stock copy (if any) will become the active version.`
		);
		if ( ! ok ) {
			return;
		}
		try {
			const resp = await deleteTopology( { name: editingName } );
			setToast( {
				kind: 'success',
				text: resp.stock_fallback
					? `Deleted user copy of ${ editingName }; stock copy now active.`
					: `Deleted ${ editingName }.`,
			} );
			topologyList.reload();
			// Drop back to view mode; the file no longer exists.
			setMode( 'view' );
			setEditingName( '' );
		} catch ( e ) {
			const msg =
				( e && e.data && e.data.message ) ||
				( e && e.message ) ||
				'Delete failed';
			setToast( { kind: 'error', text: msg } );
		}
	}, [ editingName, deleteTopology, topologyList ] );

	const handleOpenPick = useCallback(
		async ( name ) => {
			setOpenModalShown( false );
			try {
				const resp = await fetchTopology( name );
				const next = parseTsl( resp.tsl || '' );
				// Replace draft AND baseline so the load starts clean.
				setDraft( next );
				setBaseline( next );
				setEditingName( resp.name );
				setSelectedId( null );
				setSelectedEdge( null );
				// Seed from the loaded graph so later drops don't reshuffle it.
				seedOverridesFromLayout();
				setViewport( null );
				rateRef.current = new Map();
				setRateVersion( ( v ) => v + 1 );
				setToast( {
					kind: 'success',
					text: `Loaded ${ resp.name } (${ resp.source }).`,
				} );
			} catch ( e ) {
				const msg =
					( e && e.data && e.data.message ) ||
					( e && e.message ) ||
					'Open failed';
				setToast( { kind: 'error', text: msg } );
			}
		},
		[ fetchTopology, seedOverridesFromLayout ]
	);

	// Class-name → schema map so serializeTsl fills empty positional slots
	// with schema defaults instead of stripping them as trailing empties.
	const schemasByShellName = useMemo(
		() =>
			Object.fromEntries(
				( catalog.classes || [] ).map( ( c ) => [ c.shell_name, c ] )
			),
		[ catalog.classes ]
	);

	const handleSaveConfirm = useCallback(
		async ( name ) => {
			setSaveModal( null );
			try {
				const tsl = serializeTsl( draft, schemasByShellName );
				const resp = await saveTopology( { name, tsl } );
				const restartedCount = ( resp.restarted_fleets || [] ).length;
				setToast( {
					kind: 'success',
					text: `Saved ${ resp.name }. Restarted ${ restartedCount } fleet(s).`,
				} );
				setEditingName( resp.name );
				// Refresh the picker so the next Open sees the new topology.
				topologyList.reload();
				setMode( 'view' );
			} catch ( e ) {
				const msg =
					( e && e.data && e.data.message ) ||
					( e && e.message ) ||
					'Save failed';
				const lineHint =
					e && e.data && e.data.line_number
						? ` (line ${ e.data.line_number })`
						: '';
				setToast( { kind: 'error', text: `${ msg }${ lineHint }` } );
			}
		},
		[ draft, saveTopology, topologyList, schemasByShellName ]
	);

	useEffect( () => {
		if ( ! toast ) {
			return undefined;
		}
		const t = setTimeout( () => setToast( null ), 5000 );
		return () => clearTimeout( t );
	}, [ toast ] );

	const handleRenameNode = useCallback(
		( oldId, rawNew ) => {
			const newName = String( rawNew || '' ).trim();
			if ( ! newName || newName === oldId ) {
				return false;
			}
			// Reject collisions before mutating anything.
			if ( draft.nodes.some( ( n ) => n.id === newName ) ) {
				return false;
			}
			const classByName = new Map();
			for ( const c of catalog.classes || [] ) {
				classByName.set( c.shell_name, c );
			}
			setDraft( ( g ) => {
				const renamed = renameNode( g, oldId, newName );
				if ( renamed === g ) {
					return g;
				}
				// Rewrite node_name verb args referencing oldId so virtual
				// edges stay in lockstep with the rename.
				const nodes = renamed.nodes.map( ( n ) => {
					if ( ! n.verbInvocations || ! n.verbInvocations.length ) {
						return n;
					}
					const schema = classByName.get( n.class );
					if ( ! schema || ! schema.verbs ) {
						return n;
					}
					const nextInvs = n.verbInvocations.map( ( inv ) => {
						const vspec = schema.verbs.find(
							( v ) => v.name === inv.verb
						);
						if ( ! vspec || ! vspec.args ) {
							return inv;
						}
						let touched = false;
						const args = inv.args.slice();
						vspec.args.forEach( ( a, i ) => {
							if (
								a.type === 'node_name' &&
								args[ i ] === oldId
							) {
								args[ i ] = newName;
								touched = true;
							}
						} );
						return touched ? { ...inv, args } : inv;
					} );
					return { ...n, verbInvocations: nextInvs };
				} );
				return { nodes, edges: renamed.edges };
			} );
			// Carry the position override onto the new key.
			setPositionOverrides( ( prev ) => {
				if ( ! prev[ oldId ] ) {
					return prev;
				}
				const next = { ...prev };
				next[ newName ] = next[ oldId ];
				delete next[ oldId ];
				return next;
			} );
			if ( selectedId === oldId ) {
				setSelectedId( newName );
			}
			return true;
		},
		[ draft.nodes, catalog.classes, selectedId ]
	);

	const handleUpdateArgs = useCallback( ( id, args ) => {
		setDraft( ( g ) => updateNodeArgs( g, id, args ) );
	}, [] );

	const handleUpdateVerbs = useCallback( ( id, verbs ) => {
		setDraft( ( g ) => updateNodeVerbs( g, id, verbs ) );
	}, [] );

	// Snap drop coords so dropped-node centers land on grid intersections;
	// returns the top-left position the renderer stores.
	const snapToGrid = useCallback( ( x, y ) => {
		const sx = X_STEP / 2;
		const sy = Y_STEP / 2;
		const ox = X_PAD + NODE_W / 2;
		const oy = Y_PAD + NODE_H / 2;
		const centerX = Math.round( ( x - ox ) / sx ) * sx + ox;
		const centerY = Math.round( ( y - oy ) / sy ) * sy + oy;
		return {
			x: centerX - NODE_W / 2,
			y: centerY - NODE_H / 2,
		};
	}, [] );

	const handleDropNode = useCallback(
		( { shellName, x, y } ) => {
			// Snap to the grid so dropped nodes line up and don't drift.
			const snapped = snapToGrid( x, y );
			setDraft( ( g ) => {
				const name = generateNodeName( g, shellName );
				handlePositionChange( name, snapped );
				return addNode( g, {
					shellName,
					name,
					x: snapped.x,
					y: snapped.y,
				} );
			} );
		},
		[ handlePositionChange, snapToGrid ]
	);

	// rateVersion is the recompute signal; the data lives in mutable rateRef.
	const selectedRateInfo = useMemo(
		() => ( selectedId ? rateRef.current.get( selectedId ) : null ),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ selectedId, rateVersion ]
	);

	return (
		<div
			className={ `topology-app theme-${ theme }${
				selectedId ? ' is-inspector-open' : ''
			}${ mode === 'edit' ? ' is-edit-mode' : '' }` }
		>
			<Header
				pathOptions={ pathOptions }
				path={ cwd }
				onPathChange={ handlePathChange }
				canEdit={ cwd.startsWith( '_sse/' ) }
				streamStatus={ status }
				uptime={ uptime }
				mode={ mode }
				onModeChange={ handleModeChange }
				onSave={ handleSave }
				onOpen={ handleOpen }
				onNew={ handleNew }
				onDelete={ handleDelete }
				canDelete={ canDeleteCurrent }
				theme={ theme }
				onThemeChange={ setTheme }
				themes={ THEMES }
			/>
			{ mode === 'edit' && (
				<Palette
					classes={ catalog.classes }
					loading={ catalog.loading }
				/>
			) }
			<CanvasFrame
				topology={
					mode === 'edit' ? editingName || 'untitled' : topology
				}
				partition={ mode === 'edit' ? null : partition }
				onResetLayout={ hasOverrides ? handleResetLayout : null }
				onSaveLayout={ layoutDirty ? handleSaveLayout : null }
				editMode={ mode === 'edit' }
			>
				<SchematicCanvas
					parsed={ canvasGraph }
					selectedId={ selectedId }
					onSelect={ handleSelectNode }
					positionOverrides={ positionOverrides }
					onPositionChange={ handlePositionChange }
					onDeselect={ () => {
						setSelectedId( null );
						setSelectedEdge( null );
					} }
					onBackgroundClickConsumed={
						handleCanvasBackgroundClickConsumed
					}
					hoveredId={ hoveredId }
					onHover={ setHoveredId }
					rateRef={ rateRef }
					rateVersion={ rateVersion }
					viewport={ viewport }
					onViewportChange={ handleViewportChange }
					editMode={ mode === 'edit' }
					onDropNode={ handleDropNode }
					onConnect={ handleConnect }
					selectedEdge={ selectedEdge }
					onSelectEdge={ handleSelectEdge }
					classCatalog={ schemasByShellName }
				/>
			</CanvasFrame>
			{ /* Inspector mounts only when a node is selected. */ }
			{ selectedId && (
				<Inspector
					selectedId={ selectedId }
					parsed={ canvasGraph }
					streamStatus={ status }
					rateInfo={ selectedRateInfo }
					onAction={ handleInspectorAction }
					onSelect={ handleSelectNode }
					onHover={ setHoveredId }
					nodeIds={
						new Set( canvasGraph.nodes.map( ( n ) => n.id ) )
					}
					ssePid={ ssePid }
					editMode={ mode === 'edit' }
					catalog={ catalog.classes }
					formatters={ catalog.formatters }
					onUpdateArgs={ handleUpdateArgs }
					onUpdateVerbs={ handleUpdateVerbs }
					onRemoveNode={ handleRemoveNode }
					onRenameNode={ handleRenameNode }
					onRemoveEdge={ handleRemoveEdge }
					onConnect={ handleConnect }
				/>
			) }
			{ mode !== 'edit' && (
				<ReplFooter
					prompt={ `/${ cwd }` }
					streamStatus={ status }
					canSend={ status === 'open' && !! ssePid }
					onSubmit={ sendLine }
					onClear={ clearTranscript }
					transcript={ transcript }
					expanded={ replExpanded }
					onExpandedChange={ setReplExpanded }
					inputRef={ replInputRef }
					completion={ completion }
					onComplete={ requestCompletion }
					onShowCandidates={ handleShowCandidates }
				/>
			) }
			{ discardModal && (
				<ConfirmModal
					title="Discard unsaved changes?"
					body="Leaving edit mode drops the draft topology. This cannot be undone."
					confirmLabel="Discard"
					cancelLabel="Keep editing"
					danger
					onConfirm={ discardModal.onConfirm }
					onCancel={ discardModal.onCancel }
				/>
			) }
			{ saveModal && (
				<PromptModal
					title="Save topology"
					body="Choose a name. Letters, numbers, dash, underscore."
					placeholder="my-topology"
					// Pre-fill the current name; save-over-same-name is the common case.
					initialValue={ topology || '' }
					pattern={ /^[a-zA-Z0-9_-]+$/ }
					confirmLabel="Save"
					onConfirm={ handleSaveConfirm }
					onCancel={ () => setSaveModal( null ) }
				/>
			) }
			{ resetConfirm && (
				<ConfirmModal
					title="Reset to saved layout?"
					body="This replaces your current customizations with the last saved layout (or auto-layout if none). You'll need to Save Layout to make changes permanent."
					confirmLabel="Reset"
					cancelLabel="Cancel"
					danger
					onConfirm={ resetConfirm.onConfirm }
					onCancel={ resetConfirm.onCancel }
				/>
			) }
			{ openModalShown && (
				<OpenTopologyModal
					topologies={ topologyList.topologies }
					loading={ topologyList.loading }
					error={ topologyList.error }
					onPick={ handleOpenPick }
					onCancel={ () => setOpenModalShown( false ) }
				/>
			) }
			{ toast && (
				<div
					className={ `topology-toast topology-toast--${ toast.kind }` }
					role="status"
				>
					{ toast.text }
				</div>
			) }
		</div>
	);
}
