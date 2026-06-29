/**
 * TopologyConsole — top-level shell.
 */

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	createPortal,
} from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';

import CanvasFrame from './components/CanvasFrame';
import ConsoleShell from './components/ConsoleShell';
import { HeaderControls } from './components/Header';
import { ConfirmModal, PromptModal, NewNodeModal } from './components/Modal';

import OpenTopologyModal from './components/OpenTopologyModal';
import TopologySettingsPanel from './components/TopologySettingsPanel';

import { useClassCatalog } from './hooks/useClassCatalog';
import { useJsCatalog } from './hooks/useJsCatalog';
import { useLayout } from './hooks/useLayout';
import { useSaveTopology } from './hooks/useSaveTopology';
import { useDeleteTopology } from './hooks/useDeleteTopology';
import { useTopology, useTopologyList } from './hooks/useTopologyList';
import { useTopologyCatalog } from './hooks/useTopologyCatalog';
import { useConsoleGraph } from './hooks/useConsoleGraph';
import { useCanonicalNodes, driftNodeIds } from './hooks/useCanonicalNodes';
import { useGraphSource } from './hooks/useGraphSource';
import { useCompletion } from './hooks/useCompletion';
import { useGraphHandlers } from './hooks/useGraphHandlers';
import { useGraphSurface } from './hooks/useGraphSurface';
import { useCanvasLayout } from './hooks/useCanvasLayout';
import { useGraphReset } from '../debug-overlay/useGraphReset';
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
import { augmentWithVirtualEdges } from './utils/virtualEdges';
import { parseTsl } from './utils/parseTsl';
import { serializeTsl } from './utils/serializeTsl';
import { splitStatements } from '../runtime/shell-node';
import { dispatchLocalCommand } from './core/dispatchLocalCommand';
import { getCommandClient } from './utils/commandClient';
import unwrapCommandResponse from './utils/unwrapCommandResponse';
import { scopeFromCwd } from './utils/scope';
import { Core } from '../runtime/core';
import { TO } from '../runtime/message';
import names from '../runtime/reserved-node-names.json';
import {
	THEMES,
	getStoredTheme,
	PALETTE_COLLAPSED_STORAGE_KEY_LIVE,
	PALETTE_COLLAPSED_STORAGE_KEY_EDIT,
} from './themes';

// Pure derivations over a catalog — `partitions` is `{ name: num_partitions }`,
// `active` is the list of active topology names. Shared by the module-level seed
// (initial topology from the URL) and the live useTopologyCatalog data, so the
// menu and the seed compute identically.

// Active topologies sort to the top of the dropdown, then alphabetical.
function sortTopologies( partitions, active ) {
	const activeSet = new Set( active );
	return Object.keys( partitions ).sort( ( a, b ) => {
		const ad = activeSet.has( a ) ? 0 : 1;
		const bd = activeSet.has( b ) ? 0 : 1;
		return ad !== bd ? ad - bd : a.localeCompare( b );
	} );
}

function partitionIndices( partitions, topology ) {
	const n = partitions[ topology ] || 1;
	return Array.from( { length: n }, ( _, i ) => i );
}

// Every cwd the Path menu can select: the local graph, the request scope, then
// one entry per worker — only for ACTIVE topologies (inactive ones have no live
// workers to reach).
function buildPathOptions( partitions, active ) {
	const activeSet = new Set( active );
	return [
		'',
		'_http',
		...sortTopologies( partitions, active )
			.filter( ( t ) => activeSet.has( t ) )
			.flatMap( ( t ) =>
				partitionIndices( partitions, t ).map(
					( p ) => `${ t }.p${ p }`
				)
			),
	];
}

// The page-load snapshot — ONLY the seed for the initial topology pick; the live
// menu data comes from useTopologyCatalog (which seeds from this same snapshot).
const SEED_WORKERS =
	( window.NewspackNodesData && window.NewspackNodesData.topologyWorkers ) ||
	{};
const TOPOLOGIES = sortTopologies(
	SEED_WORKERS,
	( window.NewspackNodesData && window.NewspackNodesData.activeTopologies ) ||
		[]
);

// '{topology}.p{N}' → { topology, partition }; any other cwd → null.
function parseWorker( cwd ) {
	const m = String( cwd ).match( /^([^/]+)\.p(\d+)$/ );
	return m ? { topology: m[ 1 ], partition: Number( m[ 2 ] ) } : null;
}

// scopeFromCwd lives in utils/scope (imported above) so useConsoleGraph can gate
// its seed on it without a hook→component cycle. Re-exported for existing consumers.
export { scopeFromCwd };

// The localStorage key the canvas position map persists under, or null to skip
// persistence. View mode keys by the cwd scope (each worker / `/` / `_sse` keeps
// its own layout). Edit mode keys by the TOPOLOGY being edited — an unactivated
// topology has no worker to `cd` onto, so a cwd-derived key would collide every
// edited topology onto one slot (and stomp the live local-scope layout). An
// untitled draft has no identity, so it returns null (in-memory only) rather than
// share a slot. Cross-mode persistence rides the server-saved layout (layouts CI).
export function layoutStorageKey( { mode, editingName, scopeKey } ) {
	if ( 'edit' === mode ) {
		return editingName
			? `newspack-nodes:topology:edit:${ editingName }`
			: null;
	}
	return `newspack-nodes:topology:${ scopeKey }`;
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

// The longest worker menu item (`{topology}.p{N}`) that is a path-prefix of
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

// The `{topology}.p{N}` path the cwd resolves to — the longest ACTIVE worker
// menu item that prefixes it — or null when the cwd isn't (under) a live worker.
// Active-set aware: a worker-SHAPED path for an inactive topology has no menu
// entry, so it returns null. This is the SINGLE worker-detection both gates share
// — the canvas poll target AND the SSE stream gate — so they never disagree (a
// pure-regex stream gate once opened the EventSource for a path the poll gate
// couldn't reach, stranding a slot with no keepalive).
export function workerPollPath( cwd, pathOptions ) {
	const worker = longestWorkerPrefix( cwd, pathOptions );
	return worker ? `${ worker.topology }.p${ worker.partition }` : null;
}

// Whether a send TO requires a live SSE session (pid). ONLY a worker pivot
// (`{topology}.pN[/…]`) does: SseInNode wraps its reply FROM with `_sse:{pid}`
// so the server's HTTP_Filter can demux the worker's ASYNC reply back to this
// client's stream. A local-root command (empty TO) interprets in-browser; a
// request-scope command (`_sse`) and the direct `_http/{worker}` boundary form
// reply synchronously in the POST body — none of those wait on the stream. The
// send gates use this so a `cd /` (stream closed, pid null) doesn't block local
// commands with "[no sse_pid yet]".
export function toNeedsSseSession( to ) {
	return /^[a-z0-9_-]+\.p\d+(?:\/|$)/.test( to || '' );
}

// REPL transcript ceiling, derived from the MEASURED `.topology-app` height so
// it can't drift from the chrome above it. The console grid is `0 1fr 38px`
// (a collapsed header row / canvas / repl-bar — see graph-view.scss): the
// console's own header moved up to the shared hub header above the tabs, so the
// canvas frame no longer reserves a header row. The transcript fills the canvas
// row, so the ceiling is appHeight − repl-bar − a resize-handle reserve.
// The reserve is 0 here (NOT the overlay's 4): appHeight is measured exactly and
// the transcript bottom is exactly the repl-bar top, so 0 lands the transcript
// top precisely at the canvas top — the 6px handle straddles that edge and ~1px
// peeks below the tab bar (the rest of its hit area extends down, still
// grabbable). The overlay needs +4 only because it hardcodes its header/bar
// instead of measuring them. Returns null before layout (height 0) so
// ReplFooter keeps its own fallback.
const CONSOLE_REPL_BAR_PX = 38;
const CONSOLE_RESIZE_HANDLE_PX = 0;
const REPL_MIN_HEIGHT_PX = 80;
export function replCeilingFromAppHeight( appHeight ) {
	if ( ! appHeight || appHeight <= 0 ) {
		return null;
	}
	return Math.max(
		REPL_MIN_HEIGHT_PX,
		appHeight - CONSOLE_REPL_BAR_PX - CONSOLE_RESIZE_HANDLE_PX
	);
}

function readUrlParam( key ) {
	try {
		return new URLSearchParams( window.location.search ).get( key );
	} catch ( _e ) {
		return null;
	}
}
export function initialTopologyFromUrl( fallback ) {
	const t = readUrlParam( 'topology' );
	if ( ! t ) {
		return fallback;
	}
	// Honor the deep link if EITHER the module-load SEED or the live read knows
	// the topology. The SEED is the reliable source in PRODUCTION: each hub bundle
	// (event-dashboards, devtools-hub, console, …) localizes its OWN
	// `NewspackNodesData` global, and the last one to execute clobbers
	// topologyWorkers — so a render-time live read sees {} and every deep link
	// fell back to the first topology. The live read is kept as the fallback for
	// the case the SEED was empty at module import (e.g. a late-landing snapshot).
	const live =
		( window.NewspackNodesData &&
			window.NewspackNodesData.topologyWorkers ) ||
		{};
	const known =
		Object.prototype.hasOwnProperty.call( SEED_WORKERS, t ) ||
		Object.prototype.hasOwnProperty.call( live, t );
	return known ? t : fallback;
}
function initialPartitionFromUrl() {
	const p = parseInt( readUrlParam( 'partition' ) || '0', 10 );
	return Number.isInteger( p ) && p >= 0 ? p : 0;
}

// Stable empty defaults so unpopulated state keeps a constant reference.
const EMPTY_TRANSCRIPT = [];

// Per-mode palette key: edit and live store separately (different defaults).
function paletteKeyFor( mode ) {
	return 'edit' === mode
		? PALETTE_COLLAPSED_STORAGE_KEY_EDIT
		: PALETTE_COLLAPSED_STORAGE_KEY_LIVE;
}

export default function TopologyConsole( {
	publishTheme,
	headerControlsSlot,
} ) {
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
	const [ draft, setDraft ] = useState( {
		nodes: [],
		edges: [],
		frontmatter: {},
	} );
	const [ baseline, setBaseline ] = useState( {
		nodes: [],
		edges: [],
		frontmatter: {},
	} );
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
	// `{ name }` while the post-save "Activate now?" prompt is up for a
	// freshly-created topology, null otherwise. The confirm dispatches activate.
	const [ activateModal, setActivateModal ] = useState( null );
	// Pending topology-delete confirmation: `{ name }` while the ConfirmModal
	// is up, null otherwise. The actual delete runs in the modal's onConfirm.
	const [ deleteModal, setDeleteModal ] = useState( null );
	const [ openModalShown, setOpenModalShown ] = useState( false );
	const [ settingsOpen, setSettingsOpen ] = useState( false );
	const [ toast, setToast ] = useState( null );
	// Theme + palette chrome shared with the debug overlay. The console picks
	// the palette key by mode (live vs edit, with per-mode defaults); the hook
	// reloads palette state whenever the key/default change on a mode switch.
	const {
		theme,
		onThemeChange,
		paletteCollapsed,
		inspectorCollapsed,
		openInspectorOnSelect,
		canvasChromeProps,
		replChromeProps,
		setReplExpanded,
		replInputRef,
	} = useGraphSurface( {
		paletteKey: paletteKeyFor( mode ),
		defaultCollapsed: 'edit' !== mode,
	} );
	// Keep the hub's token context on the Console's live theme (a set_skin
	// re-skins the whole hub chrome, not just the canvas body).
	useEffect( () => publishTheme?.( theme ), [ publishTheme, theme ] );
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
	// Measure the `.topology-app` grid so the REPL transcript ceiling tracks the
	// real available height (the console lives inside the DevtoolsTabHost tab bar,
	// which the window-based fallback can't see). A ResizeObserver keeps it correct
	// across window resizes + admin-menu collapse.
	const appRef = useRef( null );
	const [ appHeight, setAppHeight ] = useState( 0 );
	useEffect( () => {
		const el = appRef.current;
		if ( ! el ) {
			return undefined;
		}
		const measure = () => setAppHeight( el.offsetHeight );
		measure();
		if ( typeof window === 'undefined' || ! window.ResizeObserver ) {
			return undefined;
		}
		const ro = new window.ResizeObserver( measure );
		ro.observe( el );
		return () => ro.disconnect();
	}, [] );
	const replMaxHeightPx = replCeilingFromAppHeight( appHeight );

	// Dumper verbosity dial (0/1/2), mirroring the substrate Dumper. A ref
	// so the Dumper reads it per-frame without re-binding the graph.
	const debugLevelRef = useRef( 0 );

	// The "reset graph" control stashes the cwd here so the [shell] sync effect can restore
	// it after useConsoleGraph rehomes Shell.path to the default `{reader}`.
	// Without this, "reset graph" would yank the user off `/` (or wherever they
	// were) every time. Null = no restore pending.
	const cwdRestoreRef = useRef( null );

	// Shell cwd mirrored into React so the prompt + the canvas poll follow `cd`.
	// `shell.path` is the source of truth; a graph swap (topology/partition change)
	// remounts the Shell with a fresh path, so re-sync whenever `shell` changes
	// (synced by the effect below, after `shell` exists). Declared here so the SSE
	// stream gate can read it.
	const [ cwd, setCwd ] = useState( '' );

	// Live topology catalog: partition counts + active set, refreshed from
	// `topologies.list` (poll + on save/delete). The page-load snapshot goes
	// stale the moment a topology is saved/deleted here or a worker is
	// started/stopped elsewhere — this is what keeps the Path menu reacting
	// without a full reload.
	const {
		partitions: topologyWorkers,
		active: activeTopologies,
		reload: reloadCatalog,
	} = useTopologyCatalog();

	// Every cwd the Path menu can select. Declared here (above useConsoleGraph) so
	// the SSE stream gate can resolve the cwd against it; recomputes whenever the
	// live catalog changes. An off-menu cwd is surfaced by the Header.
	const pathOptions = useMemo(
		() => buildPathOptions( topologyWorkers, activeTopologies ),
		[ topologyWorkers, activeTopologies ]
	);

	// SSE off in edit mode so offline authoring doesn't poke the live worker; the
	// stream also goes quiet when the cwd isn't a (live) worker (nothing to stream),
	// so a `cd /` or `cd /_http` drops the EventSource without tearing the graph down.
	// Uses the SAME worker detection as the poll gate (workerPollPath), so the
	// stream never opens for a path the poll/heartbeat gate can't reach.
	const { status, ssePid, shell } = useConsoleGraph( {
		topology,
		partition,
		enabled: mode !== 'edit',
		// One RemoteIpc per active worker: the path-menu entries that parse as a
		// worker (`{topology}.p{N}`) ARE the active worker readers.
		workers: pathOptions.filter( ( o ) => parseWorker( o ) ),
		streamEnabled: null !== workerPollPath( cwd, pathOptions ),
		debugLevelRef,
	} );

	// Canvas/transcript state lives on dedicated nodes (WIRING-PLAN §4): the
	// Dumper (`_output`) is transcript-only; `_metadata` / `_uptime` publish the
	// silent-poll replies the Router routes to them.
	const { graph: parsed } = useGraphSource( { coreFallback: false } );
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
	// partition state (which only tracks worker paths). `/` → local, a worker
	// (or sub-node) → that worker's `${topology}.p${N}`.
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

	useEffect( () => {
		if ( ! effectiveTopologyName ) {
			setSavedLayout( null );
			return;
		}
		// Null while fetching so the one-shot init can't lock in stale positions.
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
	// graph). It's only the right init source when the canvas is actually
	// showing that topology — i.e. a worker cwd whose label matches the
	// topology, or in edit mode (where the user is editing the topology's
	// spec). At cwd="/" the canvas renders the local browser Shell, which
	// is unrelated to the topology; adopting the server layout there would
	// dump worker-shape node ids (`completed:tee`, `jobs:partition`, …) into
	// the local scope's localStorage.
	const isServerScope =
		mode === 'edit' || ( scope.isWorker && scope.label === topology );

	// Edit-mode Reset blocks the server seed for the rest of the session at this
	// scope/topology so the canvas autoLayouts instead of replaying the saved
	// layout (live mode still loads saved). Cleared on a fresh scope/topology/mode.
	const [ serverSeedBlocked, setServerSeedBlocked ] = useState( false );
	useEffect( () => {
		setServerSeedBlocked( false );
	}, [ effectiveTopologyName, scope.key, mode ] );

	const serverPositionsMap = useMemo(
		() => savedPositionsToOverrides( savedLayout ),
		[ savedLayout, savedPositionsToOverrides ]
	);

	// The complete graph the canvas renders for this scope: the frozen draft in
	// edit mode (SSE is off, so `parsed` is empty there), the live metadata in
	// view mode. Augmented with verb-arg virtual edges so autoLayout places
	// verb-targeted nodes (e.g. errors:partition) downstream, not stacked at
	// column 0; view-mode metadata nodes carry no verbInvocations → no-op there.
	const layoutGraph = useMemo(
		() =>
			augmentWithVirtualEdges(
				mode === 'edit' ? draft : parsed,
				catalog.classes
			),
		[ mode, draft, parsed, catalog.classes ]
	);

	// Build the graph first: a local scope is ready once the graph has nodes;
	// a server scope must also wait for the layout fetch to resolve so the
	// one-shot init can adopt it instead of autoLayout. An untitled draft
	// (no topology to fetch) counts as resolved, else the canvas waits forever.
	const serverFetchResolved = ! effectiveTopologyName || savedLayout !== null; // null === in-flight
	const layoutReady =
		layoutGraph.nodes.length > 0 &&
		( ! isServerScope || serverFetchResolved );

	// One layout entry per scope (view) or per edited topology (edit). The key
	// holds `{ positions, viewport, modified }`; cross-mode persistence rides the
	// server-saved layout, not this localStorage cache. See layoutStorageKey.
	const positionStorageKey = layoutStorageKey( {
		mode,
		editingName,
		scopeKey: scope.key,
	} );
	const {
		positions: positionOverrides,
		viewport,
		canReset,
		onPositionChange: handlePositionChange,
		onViewportChange: handleViewportChange,
		renamePosition,
		markDirty,
		resetLayout,
	} = useCanvasLayout( {
		storageKey: positionStorageKey,
		graph: layoutGraph,
		ready: layoutReady,
		serverLayout:
			isServerScope && ! serverSeedBlocked ? serverPositionsMap : null,
	} );

	// Shared graph-dirty + Reset Graph logic (identical to the debug overlay). The
	// Shell dispatch tap flips structureDirty on any graph-mutating command — drag
	// gesture OR typed REPL line — and a surviving user node keeps the chip up
	// across a rebuild. Local-scope only; canRebuild = the live graph is mounted.
	// resetGraph marks the layout dirty so Reset Layout surfaces after a rebuild.
	const { resetGraph: resetLocalGraphCore, canResetGraph } = useGraphReset( {
		shell,
		nodes: parsed.nodes,
		isLocalScope: '' === cwd,
		canRebuild: mode !== 'edit',
		markDirty,
	} );

	// Comparison the Save Layout chip gates on: only show "save" when the
	// current positions diverge from what the server has. Reused below by
	// Reset Layout in live mode so it can flag "your layout doesn't match
	// the server's — click to restore".
	const layoutDivergesFromSaved = useMemo( () => {
		const saved = ( savedLayout && savedLayout.positions ) || null;
		// Only consider ids still on the canvas; a deleted node's stale override
		// must not show false divergence.
		const liveIds = new Set( layoutGraph.nodes.map( ( n ) => n.id ) );
		const overrideIds = Object.keys( positionOverrides ).filter( ( id ) =>
			liveIds.has( id )
		);
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
	}, [ positionOverrides, savedLayout, layoutGraph ] );

	// Reset Layout chip gating differs by mode:
	// - Edit: show whenever there's a layout to discard, but hide it right after a
	//   Reset (untouched autoLayout — clicking again re-runs the same autoLayout).
	// - Live server scope (worker matching the topology): show when the local
	//   layout diverges from the server-saved one (click restores saved).
	// - Live local scope (cwd "/"): no server reference; show when modified.
	const editLayoutIsAutoLayout = serverSeedBlocked && ! canReset;
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
		return canReset;
	} )();
	const handleResetLayout = useCallback( () => {
		if ( mode === 'edit' ) {
			setResetConfirm( {
				onConfirm: () => {
					setResetConfirm( null );
					// Edit-mode Reset → autoLayout, not the server seed.
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
		// Only serialize ids still on the canvas; a deleted node's stale override
		// must not leak back to the server.
		const liveIds = new Set( layoutGraph.nodes.map( ( n ) => n.id ) );
		const positions = {};
		for ( const [ id, p ] of Object.entries( positionOverrides ) ) {
			if (
				liveIds.has( id ) &&
				p &&
				Number.isFinite( p.x ) &&
				Number.isFinite( p.y )
			) {
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
	}, [ effectiveTopologyName, positionOverrides, saveLayout, layoutGraph ] );
	const partitions = useMemo(
		() => partitionIndices( topologyWorkers, topology ),
		[ topologyWorkers, topology ]
	);

	const configDefaultPartitions =
		( window.NewspackNodesData &&
			window.NewspackNodesData.configNumPartitions ) ||
		1;

	// Path selection — shared by the Path menu and REPL `cd`. Sets the cwd to the
	// path verbatim (free navigation: ANY path is allowed), then mounts the
	// deepest worker whose subtree contains it (the largest worker-prefix among
	// menu items). Mounting a DIFFERENT worker re-keys the graph and re-subscribes
	// its RemoteIpc (the rebuilt shell remounts at `{worker}`; the
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
	// reported on worker → / transitions). With the cache cleared, parsed.nodes
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
				// dispatch (not sink.fill) so useGraphReset's onDispatch tap sees
				// the verb — a canvas/REPL rewire dirties the graph uniformly.
				shell.dispatch( parsedLine );
				return;
			}
			if ( parsedLine.kind === 'error' ) {
				appendTranscript( { kind: 'error', text: parsedLine.text } );
				return;
			}
			dispatchLocalCommand( {
				parsed: parsedLine,
				append: appendTranscript,
				clear: clearTranscript,
				debugLevelRef,
				setSkin: onThemeChange,
				skins: THEMES,
				// Read fresh (not the reactive `theme`) so list_skins marks the
				// live skin regardless of this callback's stale closure.
				currentSkin: getStoredTheme(),
			} );
		},
		[
			shell,
			ssePid,
			appendTranscript,
			clearTranscript,
			handlePathChange,
			onThemeChange,
		]
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

	// Tab-completion query (WIRING-PLAN §5 sibling of the canvas poll). Shared with
	// the debug overlay via useCompletion; the console gates the request on a live
	// SSE session for a worker-pivot cwd.
	const { requestCompletion, handleShowCandidates } = useCompletion( {
		cwd,
		fill: fillCommandInterpreter,
		append: appendTranscript,
		skip: () => toNeedsSseSession( cwd ) && ! ssePid,
	} );

	// Split on unquoted `;` so `help; ls` dispatches as two commands.
	const sendLine = useCallback(
		( line ) => {
			for ( const stmt of splitStatements( line ) ) {
				dispatchStatement( stmt );
			}
		},
		[ dispatchStatement ]
	);

	// Shared live-mode handlers (connect/remove/disconnect/send/trace/invoke/drop).
	// Verb lines route through sendLine (which echoes + dispatches through the
	// useGraphReset tap); invoke builds its raw TM_COMMAND / TM_REQUEST with the
	// worker-pivot prefix/replyFrom + an SSE-session guard. The console adds its
	// own edit-mode branches on top (handleConnect / handleRemoveNode /
	// handleDropNode below) and its repl-expand/focus side-effect on inspector.
	const liveHandlers = useGraphHandlers( {
		shell,
		graph: parsed,
		catalogClasses: catalog.classes,
		dispatch: ( echoLine ) => sendLine( echoLine ),
		append: appendTranscript,
		onDropStage: setPendingDrop,
		prefix: ( target ) => shell?.prefix( target ),
		replyFrom: ( node ) => shell?.replyFrom( node ),
		sseGuard: ( to ) => ! ( toNeedsSseSession( to ) && ! ssePid ),
	} );

	// Route Inspector actions through the shared handler, then pop the transcript
	// + focus the prompt so the worker's reply is visible.
	const handleInspectorAction = useCallback(
		( action, nodeId, payload ) => {
			liveHandlers.onInspectorAction( action, nodeId, payload );
			setReplExpanded( true );
			window.requestAnimationFrame( () => replInputRef.current?.focus() );
		},
		[ liveHandlers, setReplExpanded, replInputRef ]
	);

	// useCanvasLayout owns positions: it runs autoLayout once (or adopts the
	// serverLayout at a server scope) when the complete graph is ready, then
	// only drags/drops/tucks mutate the map. No seed plumbing here.

	// Edit-mode toggle. The draft is authoritative; SSE pushes don't clobber it.
	const handleModeChange = useCallback(
		( next ) => {
			if ( next === mode ) {
				return;
			}
			if ( next !== 'edit' ) {
				setSettingsOpen( false );
			}
			if ( next === 'edit' ) {
				// Auto-load the currently-live topology; blank canvas if none.
				setMode( 'edit' );
				setEditingName( '' );
				setEditingSource( '' );
				const blank = withReplAnchor( {
					nodes: [],
					edges: [],
					frontmatter: {},
				} );
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
		return augmentWithVirtualEdges( baseCanvasGraph, catalog.classes );
	}, [ baseCanvasGraph, mode, catalog.classes ] );

	// Runtime drift (roadmap [49]): live nodes not in the registered .tsl (and not
	// reserved `_` infra), painted distinctly. Live mode only — in edit mode the
	// draft IS the source, so "drift" is meaningless.
	const canonicalNodes = useCanonicalNodes( topology );
	const driftIds = useMemo(
		() =>
			mode === 'edit'
				? null
				: driftNodeIds( canvasGraph?.nodes, canonicalNodes ),
		[ mode, canvasGraph, canonicalNodes ]
	);

	// snapToGrid is imported from utils/autoLayout — same constants the renderer
	// uses for the existing nodes.

	const handleDropNode = useCallback(
		( { shellName, x, y } ) => {
			// Live canvas: stage the NewNodeModal (commitPendingDrop dispatches the
			// make_node once the user confirms). Position is cosmetic and not sent
			// (poll-reflect lays it out).
			if ( mode !== 'edit' ) {
				liveHandlers.onDropNode( { shellName, x, y } );
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
		[ mode, liveHandlers, handlePositionChange ]
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
			// Optimistically inject the dropped node so it appears at once (no poll
			// wait, no dump_metadata round-trip); the next full poll reconciles.
			Core.node( names.METADATA )?.optimisticPatch( name, {
				class: shellName,
				target: '',
			} );
			handlePositionChange( name, snapToGrid( x, y ) );
			setPendingDrop( null );
		},
		[ pendingDrop, sendLine, handlePositionChange ]
	);
	const cancelPendingDrop = useCallback( () => setPendingDrop( null ), [] );

	const handleConnect = useCallback(
		( from, to ) => {
			// Live canvas: the gesture is a live command at the current cwd.
			if ( mode !== 'edit' ) {
				liveHandlers.onConnect( from, to );
				return;
			}
			setDraft( ( g ) => {
				// Non-Tee nodes have a single target slot; Tees fan out.
				const fromNode = g.nodes.find( ( n ) => n.id === from );
				if ( fromNode && fromNode.class !== 'Tee' ) {
					let cleared = { ...g };
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
		[ mode, liveHandlers ]
	);

	const handleRemoveNode = useCallback(
		( id ) => {
			// Live canvas: the gesture is a live command at the current cwd.
			if ( mode !== 'edit' ) {
				liveHandlers.onRemoveNode( id );
				return;
			}
			setDraft( ( g ) => removeNode( g, id ) );
		},
		[ mode, liveHandlers ]
	);

	const handleRemoveEdge = useCallback(
		( from, to ) => {
			// Live canvas: the gesture is a live command at the current cwd.
			if ( mode !== 'edit' ) {
				liveHandlers.onRemoveEdge( from, to );
				return;
			}
			setDraft( ( g ) => removeEdge( g, from, to ) );
		},
		[ mode, liveHandlers ]
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
			// A delete restarts (or stock-falls-back) the matching fleet — re-fetch
			// the live catalog so the Path menu drops/repartitions it without reload.
			reloadCatalog();
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
	}, [ deleteModal, deleteTopology, topologyList, reloadCatalog ] );

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
				// Spread `renamed` so frontmatter (num_partitions, …) + name survive
				// the verb-rewrite; only the nodes array is replaced.
				return { ...renamed, nodes };
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

	const handleFrontmatterChange = useCallback( ( nextFrontmatter ) => {
		setDraft( ( g ) => ( { ...g, frontmatter: nextFrontmatter } ) );
	}, [] );

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
				// Close settings so the panel reseeds from the loaded frontmatter
				// (re-opening the same name wouldn't remount it otherwise).
				setSettingsOpen( false );
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

	// Shared canvas-background-click dismiss pattern (mirrored in the overlay).
	const handleSave = useCallback( () => {
		setSaveModal( {} );
	}, [] );

	const handleOpen = useCallback( () => {
		setOpenModalShown( true );
	}, [] );

	const handleNew = useCallback( () => {
		// Carry the _repl anchor like handleModeChange's blank draft — without a
		// node the layout graph is empty, layoutReady stays false, and the whole
		// editor body (palette/canvas/inspector) blanks behind the building gate.
		const blank = withReplAnchor( {
			nodes: [],
			edges: [],
			frontmatter: {},
		} );
		// New is a "start a fresh topology" affordance available from live mode
		// too — land the user in edit mode (no-op when already editing).
		setMode( 'edit' );
		setDraft( blank );
		setBaseline( blank );
		setEditingName( '' );
		setEditingSource( '' );
		setSelectedId( null );
		setSettingsOpen( false );
		resetLayout();
	}, [ resetLayout ] );

	// Honor the Topologies tab's deep-links, then consume the param so a later
	// LIVE toggle or refresh doesn't snap back into edit. `?new=1` is a DISTINCT
	// signal (not `?edit=1` with no `?topology`): the `(topology, partition)` URL
	// sync above writes the default `?topology=TOPOLOGIES[0]` on mount, so by the
	// time this effect runs a "New" link would already look like an edit of that
	// default — `?new=1` is sync-proof and always blanks via `handleNew`.
	useEffect( () => {
		const isNew = '1' === readUrlParam( 'new' );
		const isEdit = '1' === readUrlParam( 'edit' );
		if ( ! isNew && ! isEdit ) {
			return;
		}
		if ( isNew ) {
			handleNew();
		} else {
			handleModeChange( 'edit' );
		}
		try {
			const url = new URL( window.location.href );
			url.searchParams.delete( 'new' );
			url.searchParams.delete( 'edit' );
			window.history.replaceState( null, '', url.toString() );
		} catch ( _e ) {
			// Best-effort param cleanup.
		}
		// Mount-only: consume the deep-link once.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [] );

	// "Reset graph" — the shared useGraphReset rebuild (removeNode all → bump the
	// generation so useConsoleGraph rebuilds off the canonical wiring → keep the
	// layout + surface Reset Layout). cwdRestoreRef carries the user's cwd through
	// the remount (otherwise the rebuilt Shell snaps path back to `{reader}`
	// and the [shell] sync effect drags cwd along).
	const handleResetGraph = useCallback( () => {
		cwdRestoreRef.current = cwd;
		resetLocalGraphCore();
	}, [ cwd, resetLocalGraphCore ] );

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
			// Snapshot "new vs existing" against the catalog the console already
			// holds, BEFORE the save reloads it: a name not previously known is a
			// freshly-created topology and earns the post-save "Activate now?" prompt.
			const isNewTopology = ! Object.prototype.hasOwnProperty.call(
				topologyWorkers,
				name
			);
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
				// A save restarts the matching fleet — re-fetch the live catalog so
				// the Path menu picks up the new/repartitioned worker without reload.
				reloadCatalog();
				setSettingsOpen( false );
				setMode( 'view' );
				// A brand-new topology saves inactive; offer to activate it now.
				if ( isNewTopology ) {
					setActivateModal( { name: resp.name } );
				}
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
		[
			draft,
			saveTopology,
			topologyList,
			schemasByShellName,
			reloadCatalog,
			topologyWorkers,
		]
	);

	// "Activate now?" confirm — dispatch `topologies activate <name>` through the
	// same command client the catalog uses for its verbs. A failed activate
	// toasts rather than crashing; the topology stays saved-but-inactive.
	const confirmActivate = useCallback( async () => {
		const name = activateModal?.name;
		setActivateModal( null );
		if ( ! name ) {
			return;
		}
		try {
			unwrapCommandResponse(
				await getCommandClient().send( {
					to: 'topologies',
					verb: 'activate',
					args: name,
				} )
			);
			reloadCatalog();
			setToast( {
				kind: 'success',
				text: sprintf(
					// translators: %s: topology name.
					__( 'Activated %s.', 'newspack-nodes' ),
					name
				),
			} );
		} catch ( e ) {
			const msg =
				( e && e.data && e.data.message ) ||
				( e && e.message ) ||
				__( 'Activate failed', 'newspack-nodes' );
			setToast( { kind: 'error', text: msg } );
		}
	}, [ activateModal, reloadCatalog ] );

	useEffect( () => {
		if ( ! toast ) {
			return undefined;
		}
		const t = setTimeout( () => setToast( null ), 5000 );
		return () => clearTimeout( t );
	}, [ toast ] );

	// The Console's own controls (PATH / NEW / EDIT / SAVE / LIVE). In the hub
	// they belong on the right of the ONE shared header, so they're portaled into
	// its slot (kept live with this tab's state). `headerControlsSlot` distinguishes
	// the three cases: a node = the hub slot (portal); `null` = the hub slot not
	// yet mounted (render nothing, no one-frame flash in the body); `undefined` =
	// rendered standalone, e.g. in tests (render inline so the controls still exist).
	const headerControls = (
		<HeaderControls
			pathOptions={ pathOptions }
			path={ cwd }
			onPathChange={ handlePathChange }
			canEdit={ null !== longestWorkerPrefix( cwd, pathOptions ) }
			streamStatus={ status }
			uptime={ uptime }
			mode={ mode }
			onModeChange={ handleModeChange }
			onSave={ handleSave }
			onOpen={ handleOpen }
			onNew={ handleNew }
			onSettings={ () => setSettingsOpen( ( v ) => ! v ) }
			settingsActive={ settingsOpen }
			onDelete={ handleDelete }
			canDelete={ canDeleteCurrent }
		/>
	);
	let renderedHeaderControls = null;
	if ( headerControlsSlot ) {
		renderedHeaderControls = createPortal(
			headerControls,
			headerControlsSlot
		);
	} else if ( undefined === headerControlsSlot ) {
		renderedHeaderControls = headerControls;
	}

	return (
		<div
			ref={ appRef }
			className={ `topology-app newspack-nodes-theme theme-${ theme } is-inspector-open${
				mode === 'edit' ? ' is-edit-mode' : ''
			}${ paletteCollapsed ? ' is-palette-collapsed' : '' }${
				inspectorCollapsed ? ' is-inspector-collapsed' : ''
			}` }
		>
			{ /* The Console's own controls (PATH / NEW / EDIT / SAVE / LIVE) live
			     on the right of the hub's ONE shared header — portaled into its
			     slot, so they stay live with this tab's state. */ }
			{ renderedHeaderControls }
			<ConsoleShell
				ready={ layoutReady }
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
					// any pivoted view — a worker RemoteIpc OR the _http
					// broadcast boundary — self-heals on respawn, so a reset is
					// meaningless. canResetGraph already gates on local scope +
					// live mode + (a mutating edit OR a surviving user node).
					onResetGraph: canResetGraph ? handleResetGraph : null,
					editMode: mode === 'edit',
				} }
				buildingClassName="topology-canvas-building"
				showRepl={ mode !== 'edit' }
				// The hub owns the ONE shared brand header above the tabs; the
				// Console's own controls are portaled into its slot (below).
				showHeader={ false }
				canvasProps={ {
					...canvasChromeProps,
					resetKey: `${ scope.key }|${ mode }|${ editingName }`,
					// Empty cwd = the browser's own (local) graph → the no-node
					// header reads wire-accurate IoTelemetry; a pivoted worker cwd
					// stays on the dump_metadata roll-up.
					local: '' === cwd,
					interactive: true,
					editMode: mode === 'edit',
					showPalette: true,
					paletteLoading: catalog.loading,
					classCatalog: schemasByShellName,
					catalog: catalog.classes,
					driftIds,
					formatters: catalog.formatters,
					streamStatus: status,
					positionOverrides,
					onPositionChange: handlePositionChange,
					viewport,
					onViewportChange: handleViewportChange,
					onConnect: handleConnect,
					onRemoveNode: handleRemoveNode,
					onRemoveEdge: handleRemoveEdge,
					onDropNode: handleDropNode,
					onInspectorAction: handleInspectorAction,
					onRenameNode: handleRenameNode,
					onUpdateArgs: handleUpdateArgs,
					onUpdateVerbs: handleUpdateVerbs,
					onSelectionChange: ( id ) => {
						setSelectedId( id );
						// Selecting a node auto-opens the inspector (rail → panel).
						// Deliberately does NOT refocus the REPL: stealing focus into
						// the transcript input makes the document-level Delete handler
						// bail (it skips form fields), so you couldn't delete a node
						// without first minimizing the transcript.
						openInspectorOnSelect( id );
					},
					selection: selectedId,
				} }
				replProps={ {
					...replChromeProps,
					prompt: `/${ cwd }`,
					streamStatus: status,
					// Input is always enabled: a poll/command for any scope routes
					// through `_cwd`, so there is no scope where the prompt waits.
					canSend: true,
					onSubmit: sendLine,
					onClear: clearTranscript,
					transcript,
					completion,
					onComplete: requestCompletion,
					onShowCandidates: handleShowCandidates,
					maxHeightPx: replMaxHeightPx,
				} }
			/>
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
					// Pre-fill the EDITED topology's name (set on edit-entry / Open), not
					// the live console's `topology` — save-over-same-name is the common
					// case, and Open changes what's edited without touching `topology`.
					initialValue={ editingName }
					pattern={ /^[a-zA-Z0-9_-]+$/ }
					confirmLabel={ __( 'Save', 'newspack-nodes' ) }
					onConfirm={ handleSaveConfirm }
					onCancel={ () => setSaveModal( null ) }
				/>
			) }
			{ activateModal && (
				<ConfirmModal
					title={ __( 'Activate now?', 'newspack-nodes' ) }
					body={ sprintf(
						// translators: %s: topology name.
						__(
							'Topology "%s" was saved but is not running. Activate it now to spawn its workers?',
							'newspack-nodes'
						),
						activateModal.name
					) }
					confirmLabel={ __( 'Activate', 'newspack-nodes' ) }
					cancelLabel={ __( 'Not now', 'newspack-nodes' ) }
					onConfirm={ confirmActivate }
					onCancel={ () => setActivateModal( null ) }
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
					nodeNames={ parsed.nodes.map( ( n ) => n.name || n.id ) }
					formatters={ catalog.formatters }
					onConfirm={ commitPendingDrop }
					onCancel={ cancelPendingDrop }
				/>
			) }
			{ mode === 'edit' && settingsOpen && (
				<TopologySettingsPanel
					key={ editingName || 'untitled' }
					frontmatter={ draft.frontmatter || {} }
					configDefaultPartitions={ configDefaultPartitions }
					onChange={ handleFrontmatterChange }
					onClose={ () => setSettingsOpen( false ) }
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
