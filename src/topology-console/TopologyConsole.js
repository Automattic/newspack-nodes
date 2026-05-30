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
import { ConfirmModal, PromptModal, NewNodeModal } from './components/Modal';
import ReplFooter from './components/ReplFooter';

import OpenTopologyModal from './components/OpenTopologyModal';

import { useClassCatalog } from './hooks/useClassCatalog';
import { useJsCatalog } from './hooks/useJsCatalog';
import { useLayout } from './hooks/useLayout';
import { useSaveTopology } from './hooks/useSaveTopology';
import { useDeleteTopology } from './hooks/useDeleteTopology';
import { useTopology, useTopologyList } from './hooks/useTopologyList';
import { useConsoleGraph } from './hooks/useConsoleGraph';
import { useDebugLayout } from '../debug-overlay/useDebugLayout';
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
import { snapToGrid } from './utils/autoLayout';
import { parseTsl } from './utils/parseTsl';
import { makeReplDismissHandler } from './utils/replDismissHandler';
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
import {
	THEMES,
	DEFAULT_THEME,
	isValidTheme,
	THEME_STORAGE_KEY,
	PALETTE_COLLAPSED_STORAGE_KEY_LIVE,
	PALETTE_COLLAPSED_STORAGE_KEY_EDIT,
} from './themes';

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
// request scope (`_sse`), or any other top-level cwd. Worker sub-nodes resolve
// to their worker. Each unique cwd gets its own storage key so canvas layouts
// don't bleed across scopes (`/`, `/_http`, `/_sse`, workers all distinct).
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
	if ( '' === cwd ) {
		return {
			key: 'local',
			label: 'local',
			partition: null,
			isWorker: false,
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
	// Any other top-level cwd (`_http`, `_completion`, etc.) gets its own
	// storage key so its canvas layout doesn't fight with `/`. Strip the
	// leading underscore for display since CanvasFrame interpolates label
	// as `topologies/${label}.tsl` and `_http.tsl` is a misleading non-file.
	const label = cwd.startsWith( '_' ) ? cwd.slice( 1 ) : cwd;
	return { key: cwd, label, partition: null, isWorker: false };
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
// (`_sse/{topology}.pN[/…]`) does: SseInNode wraps its reply FROM with `_sse:{pid}`
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

// Per-mode palette-collapsed: live defaults to collapsed (storage '0' =
// user opened it); edit defaults to OPEN (storage '1' = user closed it).
function paletteKeyFor( mode ) {
	return 'edit' === mode
		? PALETTE_COLLAPSED_STORAGE_KEY_EDIT
		: PALETTE_COLLAPSED_STORAGE_KEY_LIVE;
}
function readStoredPaletteCollapsed( mode ) {
	const key = paletteKeyFor( mode );
	const def = 'edit' !== mode; // live default: collapsed; edit default: open
	try {
		const stored = window.localStorage.getItem( key );
		if ( stored === '0' ) {
			return false;
		}
		if ( stored === '1' ) {
			return true;
		}
		return def;
	} catch ( _err ) {
		return def;
	}
}

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
	// Live-mode palette drop on a class with declared args stages here; the
	// NewNodeModal renders until commit/cancel.
	const [ pendingDrop, setPendingDrop ] = useState( null );
	const [ saveModal, setSaveModal ] = useState( null );
	// Pending topology-delete confirmation: `{ name }` while the ConfirmModal
	// is up, null otherwise. The actual delete runs in the modal's onConfirm.
	const [ deleteModal, setDeleteModal ] = useState( null );
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
	const [ paletteCollapsed, setPaletteCollapsedState ] = useState( () =>
		readStoredPaletteCollapsed( mode )
	);
	const togglePaletteCollapsed = useCallback( () => {
		setPaletteCollapsedState( ( prev ) => {
			const next = ! prev;
			try {
				window.localStorage.setItem(
					paletteKeyFor( mode ),
					next ? '1' : '0'
				);
			} catch ( _err ) {
				// localStorage disabled/quota'd; in-session only.
			}
			return next;
		} );
	}, [ mode ] );
	// Switch modes → reload the persisted state for the new mode (each mode
	// has its own key + default).
	useEffect( () => {
		setPaletteCollapsedState( readStoredPaletteCollapsed( mode ) );
	}, [ mode ] );
	const saveTopology = useSaveTopology();
	const deleteTopology = useDeleteTopology();
	const fetchTopology = useTopology();
	const topologyList = useTopologyList( { enabled: openModalShown } );
	// Two catalogs in play: the PHP one (fetched lazily over HTTP — used when
	// editing a topology or interacting with a worker) and the JS one (the
	// browser-side make_node registry, used at cwd '/' where commands run in
	// this realm). The choice is made below once `scope` is known.
	const phpCatalog = useClassCatalog( { enabled: true } );
	const jsCatalog = useJsCatalog();
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

	// resetLocalGraph stashes the cwd here so the [shell] sync effect can restore
	// it after useConsoleGraph rehomes Shell.path to the default `_sse/{reader}`.
	// Without this, "reset graph" would yank the user off `/` (or wherever they
	// were) every time. Null = no restore pending.
	const cwdRestoreRef = useRef( null );

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
			'_http',
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
	// Shell with a fresh path). If a reset was the cause of the remount, restore
	// the pre-reset cwd onto the shell instead of inheriting its default path.
	useEffect( () => {
		if ( shell ) {
			if ( cwdRestoreRef.current !== null ) {
				shell.path = cwdRestoreRef.current;
				cwdRestoreRef.current = null;
			}
			setCwd( shell.path );
		}
	}, [ shell ] );

	// Derive the display/storage scope from the cwd, not the stale topology/
	// partition state (which only tracks worker paths). `/` → local, `/_sse` →
	// request scope, a worker (or sub-node) → that worker's `${topology}.p${N}`.
	const scope = scopeFromCwd( cwd );

	// Pick the catalog that matches where make_node will actually run: the JS
	// `includeNodes` set at cwd '/' (browser-side Core), the PHP one
	// otherwise (worker SSE or topology editing — both PHP-side). Edit mode
	// always uses PHP because the topology file configures PHP workers.
	const catalog =
		mode !== 'edit' && scope.key === 'local' ? jsCatalog : phpCatalog;

	// Server-side saved layout; resolved (via fetchLayout) to either
	// `{ positions: { id: [x, y], ... } }` or `{ positions: null }`. Used as
	// the seed source in live mode (and in edit mode when the user opens a
	// saved topology); the canvas's autoLayout is the final fallback.
	const [ savedLayout, setSavedLayout ] = useState( null );
	const { fetchLayout, saveLayout } = useLayout();
	const effectiveTopologyName =
		mode === 'edit' && editingName ? editingName : topology;

	// One layout entry per scope (same pattern as the debug overlay): a single
	// localStorage key holds `{ positions, viewport, dirty }`. Edit and view
	// share the same key so a layout saved in either mode rehydrates on the
	// other — the user's mental model is "the layout at this scope", not
	// "the layout at this scope in this mode".
	const positionStorageKey = `newspack-nodes:topology:${ scope.key }`;
	const {
		positions: positionOverrides,
		viewport,
		isDirty: layoutDirty,
		onPositionChange: handlePositionChange,
		onViewportChange: handleViewportChange,
		onSeedLayout,
		renamePosition,
		resetLayout,
	} = useDebugLayout( positionStorageKey );

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
					positions: resp?.positions || null,
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

	// The server-saved layout describes the TOPOLOGY's nodes (the worker's
	// graph). It's only the right seed source when the canvas is actually
	// showing that topology — i.e. a worker cwd whose label matches the
	// topology, or in edit mode (where the user is editing the topology's
	// spec). At cwd="/" the canvas renders the local browser Shell, which
	// is unrelated to the topology; seeding the server layout there would
	// dump worker-shape node ids (`completed:tee`, `jobs:partition`, …) into
	// the local scope's localStorage.
	const isServerScope =
		mode === 'edit' || ( scope.isWorker && scope.label === topology );

	// Reset-in-edit-mode is the explicit "blow it away" path: it should go
	// to autoLayout, not replay the server seed. This flag blocks the
	// server-seed effect (and unblocks the canvas autoLayout seed) for the
	// rest of the session at the current scope/topology. Cleared whenever
	// the scope/topology/mode changes — those are fresh-load scenarios where
	// the server seed should re-apply.
	const [ serverSeedBlocked, setServerSeedBlocked ] = useState( false );
	useEffect( () => {
		setServerSeedBlocked( false );
	}, [ effectiveTopologyName, scope.key, mode ] );

	const serverPositionsMap = useMemo(
		() => savedPositionsToOverrides( savedLayout ),
		[ savedLayout, savedPositionsToOverrides ]
	);
	useEffect( () => {
		if ( ! isServerScope ) {
			return;
		}
		if ( serverSeedBlocked ) {
			return;
		}
		if ( ! serverPositionsMap ) {
			return;
		}
		onSeedLayout( serverPositionsMap );
	}, [
		isServerScope,
		serverSeedBlocked,
		serverPositionsMap,
		positionOverrides,
		onSeedLayout,
	] );

	// Canvas autoLayout seed. Always runs when:
	//   - non-server scope (no server layout to defer to), OR
	//   - server scope but server-seed is blocked (post-edit-Reset path).
	// Otherwise hold off until the fetch resolves AND no server seed is
	// available, so autoLayout doesn't lock in before the server arrives.
	const canvasOnSeedLayout = ( () => {
		if ( ! isServerScope || serverSeedBlocked ) {
			return onSeedLayout;
		}
		if ( savedLayout === null ) {
			return null;
		}
		if (
			serverPositionsMap &&
			Object.keys( serverPositionsMap ).length > 0
		) {
			return null;
		}
		return onSeedLayout;
	} )();

	// Comparison the Save Layout chip gates on: only show "save" when the
	// current positions diverge from what the server has. Reused below by
	// Reset Layout in live mode so it can flag "your layout doesn't match
	// the server's — click to restore".
	const layoutDivergesFromSaved = useMemo( () => {
		const saved = ( savedLayout && savedLayout.positions ) || null;
		const overrideIds = Object.keys( positionOverrides );
		const savedIds = saved ? Object.keys( saved ) : [];
		if ( ! saved ) {
			return overrideIds.length > 0;
		}
		if ( overrideIds.length !== savedIds.length ) {
			return true;
		}
		for ( const id of overrideIds ) {
			const cur = positionOverrides[ id ];
			const sav = saved[ id ];
			if ( ! Array.isArray( sav ) || sav.length < 2 ) {
				return true;
			}
			if ( cur.x !== sav[ 0 ] || cur.y !== sav[ 1 ] ) {
				return true;
			}
		}
		return false;
	}, [ positionOverrides, savedLayout ] );

	// "Reset Layout" chip gating differs by mode:
	// - Live at a server scope (worker matching the topology): show when the
	//   local positions don't match the server-saved layout. Covers the
	//   "exited edit after a Reset without saving" case where positions are
	//   autoLayout but the server still has user-customized positions.
	// - Live at the local scope (cwd="/"): there's no server reference; the
	//   reset target is just autoLayout, so show only when the user has
	//   touched something (dirty).
	// - Edit: show whenever there's a layout to discard. Hide it when the
	//   layout already IS autoLayout (post-reset, untouched — clicking again
	//   would re-run the same autoLayout) — `serverSeedBlocked && !dirty`.
	const editLayoutIsAutoLayout = serverSeedBlocked && ! layoutDirty;
	const showResetLayoutChip = ( () => {
		if ( mode === 'edit' ) {
			return (
				Object.keys( positionOverrides ).length > 0 &&
				! editLayoutIsAutoLayout
			);
		}
		if ( isServerScope ) {
			return layoutDivergesFromSaved;
		}
		return layoutDirty;
	} )();

	const handleResetLayout = useCallback( () => {
		if ( mode === 'edit' ) {
			setResetConfirm( {
				onConfirm: () => {
					setResetConfirm( null );
					// Edit-mode Reset → autoLayout, not the server-saved
					// layout. Block server-seed for the rest of this session
					// at this scope+topology so the canvas's autoLayout seed
					// runs instead.
					setServerSeedBlocked( true );
					resetLayout();
				},
				onCancel: () => setResetConfirm( null ),
			} );
			return;
		}
		resetLayout();
	}, [ mode, resetLayout ] );

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

	// Clear the METADATA set_state cache on scope change so the canvas doesn't
	// briefly render the previous scope's nodes (which the canvas's autofit
	// effect would then lock in via setViewport, causing the "zoom out / bleed"
	// reported on /_sse → / transitions). With the cache cleared, parsed.nodes
	// is empty until the next poll arrives for the new scope; the autofit only
	// commits against FRESH data.
	useEffect( () => {
		Core.node( names.METADATA )?.setState( 'metadata', null );
	}, [ scope.key ] );

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
	// interpreter interprets locally), then forwards to the interpreter. One indirection routes a
	// worker pivot (reply async over the stream), the local graph (in-browser interpreter),
	// and request scope (synchronous POST) alike.
	useEffect( () => {
		const cwdNode = Core.node( names.CWD );
		if ( cwdNode ) {
			// Track the cwd verbatim. At a worker cwd without a pid, the POST
			// will fail to round-trip (server has no SSE to demux the reply),
			// but the request is cheap and silent; the canvas just holds its
			// last state until the stream connects. The previous "route locally
			// while connecting" fallback misleadingly displayed the LOCAL graph
			// at a worker cwd, which is what the user calls out as unintuitive.
			cwdNode.target = cwd;
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
	// (node names). KEY='completion' tells the worker's interpreter to emit a bare
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
				// A command verb targets the node's `{name}:config` sibling interpreter —
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
				if ( ! schema || ! schema.commands ) {
					continue;
				}
				for ( const inv of node.verbInvocations || [] ) {
					const cspec = schema.commands.find(
						( v ) => v.name === inv.verb
					);
					if ( ! cspec || ! cspec.args ) {
						continue;
					}
					cspec.args.forEach( ( argSpec, i ) => {
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

	// Server seed runs via useDebugLayout's onSeedLayout — see the earlier
	// `serverPositionsMap` effect. The old per-mode seed/race plumbing is
	// gone; the hook is the single source of truth for positions, and the
	// canvas's onSeedLayout handles the autoLayout fallback when no server
	// layout is available.

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
		[ mode, draft, baseline, topology, fetchTopology ]
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

	// Shared canvas-background-click dismiss pattern (mirrored in the overlay).
	const handleCanvasBackgroundClickConsumed = makeReplDismissHandler( {
		replExpanded,
		setReplExpanded,
		inputRef: replInputRef,
	} );

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
		resetLayout();
	}, [ resetLayout ] );

	// "Reset graph" — a real reset of the local browser graph. Wipes every Core
	// node that isn't part of the canonical console graph (i.e. user `make_node`s
	// that survived a self-inflicted break), clears local-scope layout state so
	// the canvas re-autofits cleanly, then bumps resetKey to rebuild the spine.
	// cwdRestoreRef carries the user's cwd through the remount (otherwise the
	// rebuilt Shell snaps path back to `_sse/{reader}` and drags cwd along).
	const PROTECTED_NODE_NAMES = useMemo(
		() =>
			new Set( [
				names.COMMAND_INTERPRETER,
				names.ROUTER,
				names.OUTPUT,
				names.METADATA,
				names.UPTIME,
				names.COMPLETION,
				names.HEARTBEAT,
				names.HTTP,
				names.SSE,
				names.CWD,
			] ),
		[]
	);
	const resetLocalGraph = useCallback( () => {
		cwdRestoreRef.current = cwd;
		for ( const name of [ ...Core.nodes.keys() ] ) {
			if ( ! PROTECTED_NODE_NAMES.has( name ) ) {
				Core.unregisterNode( name );
			}
		}
		// resetLocalGraph is only invoked from the local-scope chip (scope.key
		// === 'local'), so this clears the same key the hook is using.
		resetLayout();
		setResetKey( ( k ) => k + 1 );
	}, [ cwd, PROTECTED_NODE_NAMES, resetLayout ] );

	// Hide the Reset Graph chip when there's nothing to reset (only the
	// canonical console graph remains). Mirrors the overlay's gating.
	const hasUserAddedLocalNodes = parsed.nodes.some(
		( n ) => ! PROTECTED_NODE_NAMES.has( n.id )
	);

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

	// Stage the delete; the ConfirmModal's onConfirm does the real work.
	const handleDelete = useCallback( () => {
		if ( ! editingName ) {
			return;
		}
		setDeleteModal( { name: editingName } );
	}, [ editingName ] );

	const confirmDelete = useCallback( async () => {
		const name = deleteModal?.name;
		setDeleteModal( null );
		if ( ! name ) {
			return;
		}
		try {
			const resp = await deleteTopology( { name } );
			setToast( {
				kind: 'success',
				text: resp.stock_fallback
					? sprintf(
							// translators: %s: topology name.
							__(
								'Deleted user copy of %s; stock copy now active.',
								'newspack-nodes'
							),
							name
					  )
					: sprintf(
							// translators: %s: topology name.
							__( 'Deleted %s.', 'newspack-nodes' ),
							name
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
	}, [ deleteModal, deleteTopology, topologyList ] );

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
				// The storage key includes editingName, so the hook auto-loads
				// the right positions for the opened topology; the server-seed
				// effect handles the savedLayout fetch.
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
		[ fetchTopology ]
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
					if ( ! schema || ! schema.commands ) {
						return n;
					}
					const nextInvs = n.verbInvocations.map( ( inv ) => {
						const cspec = schema.commands.find(
							( v ) => v.name === inv.verb
						);
						if ( ! cspec || ! cspec.args ) {
							return inv;
						}
						let touched = false;
						const args = inv.args.slice();
						cspec.args.forEach( ( a, i ) => {
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
			// Carry the position override onto the new key. Dirty-neutral —
			// rename isn't a user-driven position change.
			renamePosition( oldId, newName );
			if ( selectedId === oldId ) {
				setSelectedId( newName );
			}
			return true;
		},
		[ draft.nodes, catalog.classes, selectedId, renamePosition ]
	);

	const handleUpdateArgs = useCallback( ( id, args ) => {
		setDraft( ( g ) => updateNodeArgs( g, id, args ) );
	}, [] );

	const handleUpdateVerbs = useCallback( ( id, verbs ) => {
		setDraft( ( g ) => updateNodeVerbs( g, id, verbs ) );
	}, [] );

	// snapToGrid is imported from utils/autoLayout — same constants the renderer
	// uses for the existing nodes.

	const handleDropNode = useCallback(
		( { shellName, x, y } ) => {
			// Live canvas: dispatch a live make_node; position is cosmetic and
			// not sent (poll-reflect lays it out). Name uniqued against the
			// live graph so it won't collide with an existing node.
			if ( mode !== 'edit' ) {
				// Every live-mode palette drop goes through NewNodeModal so
				// the user can override the auto-generated name (and add
				// args when the class declares them). commitPendingDrop
				// (below) dispatches once the user confirms.
				const defaultName = generateNodeName( parsed, shellName );
				const cls = ( catalog?.classes || [] ).find(
					( c ) => c.shell_name === shellName
				);
				const argSchema = cls?.arguments || [];
				setPendingDrop( { shellName, defaultName, argSchema, x, y } );
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
		// sendLine is consumed by commitPendingDrop (below), not this callback —
		// live-mode drop just stages pendingDrop now.
		[ mode, parsed, handlePositionChange, catalog?.classes ]
	);

	// NewNodeModal commit/cancel (live mode).
	const commitPendingDrop = useCallback(
		( { name, args } ) => {
			if ( ! pendingDrop ) {
				return;
			}
			const { shellName, x, y } = pendingDrop;
			const trimmed = ( args || '' ).trim();
			const line = trimmed
				? `make_node ${ shellName } ${ name } ${ trimmed }`
				: `make_node ${ shellName } ${ name }`;
			sendLine( line );
			handlePositionChange( name, snapToGrid( x, y ) );
			setPendingDrop( null );
		},
		[ pendingDrop, sendLine, handlePositionChange ]
	);
	const cancelPendingDrop = useCallback( () => setPendingDrop( null ), [] );

	return (
		<div
			className={ `topology-app theme-${ theme }${
				selectedId ? ' is-inspector-open' : ''
			}${ mode === 'edit' ? ' is-edit-mode' : '' }${
				paletteCollapsed ? ' is-palette-collapsed' : ''
			}` }
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
					onResetLayout: showResetLayoutChip
						? handleResetLayout
						: null,
					onSaveLayout: layoutDivergesFromSaved
						? handleSaveLayout
						: null,
					// Only the local in-browser graph (cwd root) is ephemeral;
					// any pivoted view — a worker over _sse OR the _http
					// broadcast boundary — self-heals on respawn, so a reset is
					// meaningless.
					onResetGraph:
						mode === 'edit' ||
						'' !== cwd ||
						! hasUserAddedLocalNodes
							? null
							: resetLocalGraph,
					editMode: mode === 'edit',
				} }
				resetKey={ `${ scope.key }|${ mode }|${ editingName }` }
				interactive={ true }
				editMode={ mode === 'edit' }
				showPalette={ true }
				paletteLoading={ catalog.loading }
				paletteCollapsed={ paletteCollapsed }
				onPaletteToggle={ togglePaletteCollapsed }
				classCatalog={ schemasByShellName }
				catalog={ catalog.classes }
				formatters={ catalog.formatters }
				streamStatus={ status }
				ssePid={ ssePid }
				positionOverrides={ positionOverrides }
				onPositionChange={ handlePositionChange }
				onSeedLayout={ canvasOnSeedLayout }
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
			{ deleteModal && (
				<ConfirmModal
					title={ __( 'Delete topology?', 'newspack-nodes' ) }
					body={ sprintf(
						// translators: %s: topology name.
						__(
							'Delete user-saved topology "%s"? Stock copy (if any) will become the active version.',
							'newspack-nodes'
						),
						deleteModal.name
					) }
					confirmLabel={ __( 'Delete', 'newspack-nodes' ) }
					cancelLabel={ __( 'Cancel', 'newspack-nodes' ) }
					danger
					onConfirm={ confirmDelete }
					onCancel={ () => setDeleteModal( null ) }
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
			{ pendingDrop && (
				<NewNodeModal
					shellName={ pendingDrop.shellName }
					defaultName={ pendingDrop.defaultName }
					argSchema={ pendingDrop.argSchema }
					onConfirm={ commitPendingDrop }
					onCancel={ cancelPendingDrop }
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
