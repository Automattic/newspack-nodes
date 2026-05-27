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
import { __, _n, sprintf } from '@wordpress/i18n';

import CanvasFrame from './components/CanvasFrame';
import GraphView from './components/GraphView';
import Header from './components/Header';
import { ConfirmModal, PromptModal } from './components/Modal';
import ReplFooter from './components/ReplFooter';

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
	withReplAnchor,
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

// The display/storage scope for a cwd: a worker (its topology+partition), the
// request scope (`_sse`), or the local in-browser graph (''). Worker sub-nodes
// resolve to their worker. Drives the canvas header + the viewport/positions
// storage keys so `/` and `/_sse` don't inherit the last worker's.
export function scopeFromCwd( cwd ) {
	const m = String( cwd ).match( /^_sse\/(.+?)\.p(\d+)(?:\/|$)/ );
	if ( m ) {
		return {
			key: `${ m[ 1 ] }.p${ m[ 2 ] }`,
			label: m[ 1 ],
			partition: Number( m[ 2 ] ),
			isWorker: true,
		};
	}
	if ( '_sse' === cwd ) {
		return {
			key: '_sse',
			label: 'request scope',
			partition: null,
			isWorker: false,
		};
	}
	return { key: 'local', label: 'local', partition: null, isWorker: false };
}

// The browser console's `status` builtin summary — the JS analogue of the PHP
// cli's `$shell->status_lines`. Reports the SSE session, the cwd, and which
// worker (if any) the cwd is pivoted into. `worker` is a longestWorkerPrefix()
// result ({ topology, partition } | null).
export function statusLines( { ssePid, cwd, worker } ) {
	if ( ! ssePid ) {
		return [ 'Browser console — no SSE session (not connected).' ];
	}
	return [
		`Browser console — SSE session ${ ssePid }`,
		`  cwd: ${ cwd || '/' }`,
		worker
			? `  worker pivot: ${ worker.topology }.p${ worker.partition }`
			: '  no worker pivot (local graph).',
	];
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

// The `_sse/{topology}.p{N}` path the cwd resolves to — the longest ACTIVE worker
// menu item that prefixes it — or null when the cwd isn't (under) a live worker.
// Active-set aware: a worker-SHAPED path for an inactive topology has no menu
// entry, so it returns null. This is the SINGLE worker-detection both gates share
// — the canvas poll target AND the SSE stream gate — so they never disagree (a
// pure-regex stream gate once opened the EventSource for a path the poll gate
// couldn't reach, stranding a slot with no keepalive).
export function workerPollPath( cwd, pathOptions ) {
	const worker = longestWorkerPrefix( cwd, pathOptions );
	return worker ? `_sse/${ worker.topology }.p${ worker.partition }` : null;
}

// Whether a send TO requires a live SSE session (pid). ONLY a worker pivot
// (`_sse/{topology}.pN[/…]`) does: SseIn wraps its reply FROM with `_sse:{pid}`
// so the server's HTTP_Filter can demux the worker's ASYNC reply back to this
// client's stream. A local-root command (empty TO) interprets in-browser; a
// request-scope command (`_sse`) and the direct `_http/{worker}` boundary form
// reply synchronously in the POST body — none of those wait on the stream. The
// send gates use this so a `cd /` (stream closed, pid null) doesn't block local
// commands with "[no sse_pid yet]".
export function toNeedsSseSession( to ) {
	return /^_sse\/[a-z0-9_-]+\.p\d+(?:\/|$)/.test( to || '' );
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
	// Display-only mirror of GraphView's authoritative selection, set via
	// onSelectionChange. Used ONLY for the `is-inspector-open` wrapper class
	// (and handleInspectorAction's transcript focus side-effect).
	const [ selectedId, setSelectedId ] = useState( null );
	// `edit` freezes a draft snapshot so SSE pushes can't clobber it;
	// `baseline` is the draft at edit-entry, so the dirty check compares
	// against real edits rather than live SSE counter churn.
	const [ mode, setMode ] = useState( 'view' );
	const [ draft, setDraft ] = useState( { nodes: [], edges: [] } );
	const [ baseline, setBaseline ] = useState( { nodes: [], edges: [] } );
	const [ editingName, setEditingName ] = useState( '' );
	// Source ('stock' | 'user' | 'both' | '') of the topology currently loaded
	// for editing — from the get/save response. Drives the DELETE button without
	// needing the Open-modal topology list (which isn't loaded until Open shows).
	const [ editingSource, setEditingSource ] = useState( '' );
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

	// Dumper verbosity dial (0/1/2), mirroring the substrate Dumper. A ref
	// so the Dumper reads it per-frame without re-binding the graph.
	const debugLevelRef = useRef( 0 );

	// Bumped by the "reset graph" control to remount the browser console graph
	// (teardown + rebuild) after a self-inflicted live edit, without reloading.
	const [ resetKey, setResetKey ] = useState( 0 );

	// Shell cwd mirrored into React so the prompt + the canvas poll follow `cd`.
	// `shell.path` is the source of truth; a graph swap (topology/partition change)
	// remounts the Shell with a fresh path, so re-sync whenever `shell` changes
	// (synced by the effect below, after `shell` exists). Declared here so the SSE
	// stream gate can read it.
	const [ cwd, setCwd ] = useState( '' );

	// Every cwd the Path menu can select: the local graph, the request scope, then
	// one entry per worker — only for ACTIVE topologies (inactive ones have no live
	// workers to reach). Declared here (above useConsoleGraph) so the SSE stream
	// gate can resolve the cwd against it. An off-menu cwd is surfaced by the Header.
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

	// SSE off in edit mode so offline authoring doesn't poke the live worker; the
	// stream also goes quiet when the cwd isn't a (live) worker (nothing to stream),
	// so a `cd /` or `cd /_sse` drops the EventSource without tearing the graph down.
	// Uses the SAME worker detection as the poll gate (workerPollPath), so the
	// stream never opens for a path the poll/heartbeat gate can't reach.
	const { status, ssePid, shell } = useConsoleGraph( {
		topology,
		partition,
		enabled: mode !== 'edit',
		streamEnabled: null !== workerPollPath( cwd, pathOptions ),
		debugLevelRef,
		resetKey,
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

	// Re-sync the mirrored cwd whenever `shell` changes (a graph swap remounts the
	// Shell with a fresh path). The state itself is declared above useConsoleGraph.
	useEffect( () => {
		if ( shell ) {
			setCwd( shell.path );
		}
	}, [ shell ] );

	// Derive the display/storage scope from the cwd, not the stale topology/
	// partition state (which only tracks worker paths). `/` → local, `/_sse` →
	// request scope, a worker (or sub-node) → that worker's `${topology}.p${N}`.
	const scope = scopeFromCwd( cwd );

	// Scoped per scope.key so positions don't bleed between workers/roots. For a
	// worker cwd scope.key === `${topology}.p${partition}`, so persisted worker
	// layouts still load; `/` and `/_sse` get their own independent keys.
	const positionStorageKey = `newspack-nodes:topology:${ scope.key }:positions`;
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
	const viewportStorageKey = `newspack-nodes:topology:${ scope.key }:viewport`;
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
				text: sprintf(
					// translators: %s: topology name.
					__( 'Saved layout for %s.', 'newspack-nodes' ),
					resp.name
				),
			} );
		} catch ( e ) {
			const msg =
				( e && e.data && e.data.message ) ||
				( e && e.message ) ||
				__( 'Save layout failed', 'newspack-nodes' );
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
				// Only a worker pivot's reply arrives async over the SSE stream, so
				// only that send waits on a session pid; local/request-scope sends
				// reply in-browser or synchronously in the POST body.
				if ( toNeedsSseSession( parsedLine[ TO ] ) && ! ssePid ) {
					appendTranscript( {
						kind: 'error',
						text: __(
							'[no sse_pid yet] retry once CONNECTED',
							'newspack-nodes'
						),
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
	// useConsoleGraph drives emission; the poll nodes address `_cwd` (a plain Node
	// whose `target` IS the cwd), so all the per-scope routing collapses to one
	// line: point `_cwd.target` at the current cwd. Router peels `_cwd`, the base
	// Node.fill re-stamps the live cwd into TO (empty TO for the local root → the
	// CI interprets locally), then forwards to the CI. One indirection routes a
	// worker pivot (reply async over the stream), the local graph (in-browser CI),
	// and request scope (synchronous POST) alike.
	useEffect( () => {
		const cwdNode = Core.node( names.CWD );
		if ( cwdNode ) {
			// A worker poll needs the SSE session to receive its reply; until the
			// stream connects (pid arrives), route polls to the local CI ('')
			// instead of POSTing replies the server can't demux. Off-worker /
			// once connected, point at the real cwd.
			const connecting =
				null !== workerPollPath( cwd, pathOptions ) && null === ssePid;
			cwdNode.target = connecting ? '' : cwd;
		}
		// Keep the Shell's `status` builtin lines current with the session/cwd so
		// the carrier it slices at parse time reflects live state (PHP stashes a
		// static mode summary; the browser cwd moves, so we refresh here).
		if ( shell ) {
			shell.statusLines = statusLines( {
				ssePid,
				cwd,
				worker: longestWorkerPrefix( cwd, pathOptions ),
			} );
		}
	}, [ shell, mode, ssePid, cwd, pathOptions ] );

	// Tab-completion query (WIRING-PLAN §5 sibling of the canvas poll). The verb
	// depends on cursor context: completing the FIRST token (the command word) →
	// `help` (verb names); completing a LATER token (a node-name arg) → `ls`
	// (node names). KEY='completion' tells the worker's CI to emit a bare
	// candidate list; FROM pivots the reply to the silent `_completion` node.
	const requestCompletion = useCallback(
		( line ) => {
			// Completion targets the cwd; only a worker-pivot cwd needs the session.
			if ( toNeedsSseSession( cwd ) && ! ssePid ) {
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
				const { verb, kind, positional, byName } = payload;
				// A command verb targets the node's `{name}:config` sibling CI —
				// UNLESS the node IS itself a Command_Interpreter_Node, which
				// handles its verbs directly (no sibling). The catalog's
				// per-class `is_interpreter` flag is the source of truth: map
				// nodeId → its node's class (shell_name) → that flag. Requests
				// are always answered by the node itself.
				const node = parsed.nodes.find( ( n ) => n.id === nodeId );
				const cls =
					node && catalog.classes
						? catalog.classes.find(
								( c ) => c.shell_name === node.class
						  )
						: null;
				const isInterpreter = !! ( cls && cls.is_interpreter );
				const commandTarget =
					'request' === kind || isInterpreter
						? nodeId
						: `${ nodeId }:config`;
				const m = newMessage();
				m[ TO ] = shell.prefix( commandTarget );
				m[ FROM ] = shell.replyFrom( names.OUTPUT );
				m[ LOCAL ] = true;
				// Only a worker-pivot target's reply rides the async stream; a
				// local-graph node invocation interprets in-browser without a pid.
				if ( toNeedsSseSession( m[ TO ] ) && ! ssePid ) {
					appendTranscript( {
						kind: 'error',
						text: __(
							'[no sse_pid yet] retry once CONNECTED',
							'newspack-nodes'
						),
					} );
					return;
				}
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
					echo = `command_node ${ commandTarget } ${ verb }${
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
		[ sendLine, shell, ssePid, appendTranscript, parsed, catalog.classes ]
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
				setEditingSource( '' );
				// Preserve overrides + viewport from a prior edit session.
				// Seed the reserved `_repl` anchor into both draft and baseline
				// so it's present from the start and its presence isn't dirty.
				const blank = withReplAnchor( { nodes: [], edges: [] } );
				setDraft( blank );
				setBaseline( blank );
				if ( topology ) {
					fetchTopology( topology )
						.then( ( resp ) => {
							const loaded = withReplAnchor(
								parseTsl( resp.tsl || '' )
							);
							setDraft( loaded );
							setBaseline( loaded );
							setEditingName( resp.name );
							setEditingSource( resp.source || '' );
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

	const handleConnect = useCallback(
		( from, to ) => {
			// Live canvas: the gesture is a live command at the current cwd.
			if ( mode !== 'edit' ) {
				sendLine( `connect_node ${ from } ${ to }` );
				return;
			}
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
		},
		[ mode, sendLine ]
	);

	const handleRemoveNode = useCallback(
		( id ) => {
			// Live canvas: the gesture is a live command at the current cwd.
			if ( mode !== 'edit' ) {
				sendLine( `remove_node ${ id }` );
				return;
			}
			setDraft( ( g ) => removeNode( g, id ) );
		},
		[ mode, sendLine ]
	);

	const handleRemoveEdge = useCallback( ( from, to ) => {
		setDraft( ( g ) => removeEdge( g, from, to ) );
	}, [] );

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
		setEditingSource( '' );
		setSelectedId( null );
		setPositionOverrides( {} );
		setViewport( null );
	}, [] );

	// DELETE shows only for a topology with a user-saved copy (stock is protected).
	// Keyed off the source of the loaded topology (from the get/save response),
	// so it appears on edit/after-save without first opening the Open modal.
	const canDeleteCurrent = useMemo(
		() =>
			mode === 'edit' &&
			!! editingName &&
			( editingSource === 'user' || editingSource === 'both' ),
		[ mode, editingName, editingSource ]
	);

	const handleDelete = useCallback( async () => {
		if ( ! editingName ) {
			return;
		}
		// eslint-disable-next-line no-alert -- intentional confirm; this is a destructive action.
		const ok = window.confirm(
			sprintf(
				// translators: %s: topology name.
				__(
					'Delete user-saved topology "%s"? Stock copy (if any) will become the active version.',
					'newspack-nodes'
				),
				editingName
			)
		);
		if ( ! ok ) {
			return;
		}
		try {
			const resp = await deleteTopology( { name: editingName } );
			setToast( {
				kind: 'success',
				text: resp.stock_fallback
					? sprintf(
							// translators: %s: topology name.
							__(
								'Deleted user copy of %s; stock copy now active.',
								'newspack-nodes'
							),
							editingName
					  )
					: sprintf(
							// translators: %s: topology name.
							__( 'Deleted %s.', 'newspack-nodes' ),
							editingName
					  ),
			} );
			topologyList.reload();
			// Drop back to view mode; the file no longer exists.
			setMode( 'view' );
			setEditingName( '' );
			setEditingSource( '' );
		} catch ( e ) {
			const msg =
				( e && e.data && e.data.message ) ||
				( e && e.message ) ||
				__( 'Delete failed', 'newspack-nodes' );
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
				setEditingSource( resp.source || '' );
				setSelectedId( null );
				// Seed from the loaded graph so later drops don't reshuffle it.
				seedOverridesFromLayout();
				setViewport( null );
				setToast( {
					kind: 'success',
					text: sprintf(
						// translators: 1: topology name, 2: source (stock/user/both).
						__( 'Loaded %1$s (%2$s).', 'newspack-nodes' ),
						resp.name,
						resp.source
					),
				} );
			} catch ( e ) {
				const msg =
					( e && e.data && e.data.message ) ||
					( e && e.message ) ||
					__( 'Open failed', 'newspack-nodes' );
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
				const fleetsPhrase = sprintf(
					// translators: %d: number of restarted fleets.
					_n(
						'Restarted %d fleet.',
						'Restarted %d fleets.',
						restartedCount,
						'newspack-nodes'
					),
					restartedCount
				);
				setToast( {
					kind: 'success',
					text: sprintf(
						// translators: 1: topology name, 2: "Restarted N fleet(s)." phrase.
						__( 'Saved %1$s. %2$s', 'newspack-nodes' ),
						resp.name,
						fleetsPhrase
					),
				} );
				setEditingName( resp.name );
				// Just-written user copy is now deletable: 'both' when it shadows
				// a stock copy, else 'user'. Keeps the DELETE button correct after
				// save without waiting for an Open-modal list refresh.
				setEditingSource( resp.shadows_stock ? 'both' : 'user' );
				// Refresh the picker so the next Open sees the new topology.
				topologyList.reload();
				setMode( 'view' );
			} catch ( e ) {
				const msg =
					( e && e.data && e.data.message ) ||
					( e && e.message ) ||
					__( 'Save failed', 'newspack-nodes' );
				const lineHint =
					e && e.data && e.data.line_number
						? ' ' +
						  sprintf(
								// translators: %d: line number in the topology source.
								__( '(line %d)', 'newspack-nodes' ),
								e.data.line_number
						  )
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
			// Live canvas: dispatch a live make_node; position is cosmetic and
			// not sent (poll-reflect lays it out). Name uniqued against the
			// live graph so it won't collide with an existing node.
			if ( mode !== 'edit' ) {
				const name = generateNodeName( parsed, shellName );
				sendLine( `make_node ${ shellName } ${ name }` );
				return;
			}
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
		[ mode, parsed, sendLine, handlePositionChange, snapToGrid ]
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
			<GraphView
				graph={ canvasGraph }
				frame={ CanvasFrame }
				frameProps={ {
					topology:
						mode === 'edit'
							? editingName || 'untitled'
							: scope.label,
					partition: mode === 'edit' ? null : scope.partition,
					isWorker: mode === 'edit' ? true : scope.isWorker,
					onResetLayout: hasOverrides ? handleResetLayout : null,
					onSaveLayout: layoutDirty ? handleSaveLayout : null,
					// Only the local in-browser graph (cwd root) is ephemeral;
					// any pivoted view — a worker over _sse OR the _http
					// broadcast boundary — self-heals on respawn, so a reset is
					// meaningless.
					onResetGraph:
						mode === 'edit' || '' !== cwd
							? null
							: () => setResetKey( ( k ) => k + 1 ),
					editMode: mode === 'edit',
				} }
				resetKey={ `${ scope.key }|${ mode }|${ editingName }` }
				interactive={ true }
				editMode={ mode === 'edit' }
				showPalette={ true }
				paletteLoading={ catalog.loading }
				classCatalog={ schemasByShellName }
				catalog={ catalog.classes }
				formatters={ catalog.formatters }
				streamStatus={ status }
				ssePid={ ssePid }
				positionOverrides={ positionOverrides }
				onPositionChange={ handlePositionChange }
				viewport={ viewport }
				onViewportChange={ handleViewportChange }
				onConnect={ handleConnect }
				onRemoveNode={ handleRemoveNode }
				onRemoveEdge={ handleRemoveEdge }
				onDropNode={ handleDropNode }
				onInspectorAction={ handleInspectorAction }
				onRenameNode={ handleRenameNode }
				onUpdateArgs={ handleUpdateArgs }
				onUpdateVerbs={ handleUpdateVerbs }
				onSelectionChange={ ( id ) => {
					setSelectedId( id );
					refocusReplIfExpanded();
				} }
				selection={ selectedId }
				onBackgroundClickConsumed={
					handleCanvasBackgroundClickConsumed
				}
			/>
			{ mode !== 'edit' && (
				<ReplFooter
					prompt={ `/${ cwd }` }
					streamStatus={ status }
					// Input is always enabled: a poll/command for any scope routes
					// through `_cwd`, so there is no scope where the prompt must wait.
					canSend={ true }
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
					title={ __( 'Discard unsaved changes?', 'newspack-nodes' ) }
					body={ __(
						'Leaving edit mode drops the draft topology. This cannot be undone.',
						'newspack-nodes'
					) }
					confirmLabel={ __( 'Discard', 'newspack-nodes' ) }
					cancelLabel={ __( 'Keep editing', 'newspack-nodes' ) }
					danger
					onConfirm={ discardModal.onConfirm }
					onCancel={ discardModal.onCancel }
				/>
			) }
			{ saveModal && (
				<PromptModal
					title={ __( 'Save topology', 'newspack-nodes' ) }
					body={ __(
						'Choose a name. Letters, numbers, dash, underscore.',
						'newspack-nodes'
					) }
					placeholder={ __( 'my-topology', 'newspack-nodes' ) }
					// Pre-fill the current name; save-over-same-name is the common case.
					initialValue={ topology || '' }
					pattern={ /^[a-zA-Z0-9_-]+$/ }
					confirmLabel={ __( 'Save', 'newspack-nodes' ) }
					onConfirm={ handleSaveConfirm }
					onCancel={ () => setSaveModal( null ) }
				/>
			) }
			{ resetConfirm && (
				<ConfirmModal
					title={ __( 'Reset to saved layout?', 'newspack-nodes' ) }
					body={ __(
						"This replaces your current customizations with the last saved layout (or auto-layout if none). You'll need to Save Layout to make changes permanent.",
						'newspack-nodes'
					) }
					confirmLabel={ __( 'Reset', 'newspack-nodes' ) }
					cancelLabel={ __( 'Cancel', 'newspack-nodes' ) }
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
