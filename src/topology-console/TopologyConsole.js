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

import { formatCommandArgs } from '../runtime/command-args';
import CanvasFrame from './components/CanvasFrame';
import ConsoleShell from './components/ConsoleShell';
import { HeaderControls } from './components/Header';
import { ConfirmModal, PromptModal, NewNodeModal } from './components/Modal';

import OpenTopologyModal from './components/OpenTopologyModal';
import TopologySettingsPanel from './components/TopologySettingsPanel';

import { useClassCatalog } from './hooks/useClassCatalog';
import { useVaults } from './hooks/useVaults';
import { useJsCatalog } from './hooks/useJsCatalog';
import { useLayout } from './hooks/useLayout';
import { useSaveTopology } from './hooks/useSaveTopology';
import { useDeleteTopology } from './hooks/useDeleteTopology';
import { useTopology, useTopologyList } from './hooks/useTopologyList';
import { useTopologyCatalog } from './hooks/useTopologyCatalog';
import { useConsoleGraph } from './hooks/useConsoleGraph';
import { useCanonicalNodes, driftNodeIds } from './hooks/useCanonicalNodes';
import { useGraphSource } from './hooks/useGraphSource';
import { buildComposeTargets } from './utils/composeTargets';
import { useCompletion } from './hooks/useCompletion';
import { useGraphHandlers } from './hooks/useGraphHandlers';
import { useGraphSurface } from './hooks/useGraphSurface';
import { useCanvasLayout } from './hooks/useCanvasLayout';
import { useGraphReset } from '../debug-overlay/useGraphReset';
import { useNodeState, useNodeFill } from '../runtime/react';
import {
	useExpandedIncludes,
	fetchExpandedIncludes,
	invalidateExpandedIncludes,
	primeExpandedIncludes,
} from './hooks/useExpandedIncludes';
import {
	addInclude,
	connectDraftEdge,
	draftIsDirty,
	addNode,
	applyLoadedBaseline,
	generateNodeName,
	reconcileIncludes,
	removeEdge,
	removeInclude,
	removeNode,
	renameNode,
	updateNodeArgs,
	updateNodeVerbs,
	withReplAnchor,
	withResolvedConfigEdges,
} from './utils/draftGraph';
import { snapToGrid } from './utils/autoLayout';
import { stampOrigins } from './utils/stampOrigins';
import { clusterLayout } from './utils/clusterLayout';
import { augmentWithVirtualEdges } from './utils/virtualEdges';
import { parseTsl } from './utils/parseTsl';
import { serializeTsl } from './utils/serializeTsl';
import { splitStatements } from '../runtime/shell-node';
import { dispatchLocalCommand } from './core/dispatchLocalCommand';
import { getCommandClient } from './utils/commandClient';
import unwrapCommandResponse from './utils/unwrapCommandResponse';
import { scopeFromCwd } from './utils/scope';
import { Core } from '../runtime/core';
import { TO, applyComposeFields } from '../runtime/message';
import names from '../runtime/reserved-node-names.json';
import {
	THEMES,
	getStoredTheme,
	applySkin,
	initSkin,
	PALETTE_COLLAPSED_STORAGE_KEY_LIVE,
	PALETTE_COLLAPSED_STORAGE_KEY_EDIT,
} from './themes';

// Pure derivations over a topology catalog, shared by the seed and live menu.

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

// Every cwd the Path menu offers: local graph, request scope, active workers.
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

// Page-load snapshot — seeds the initial topology pick, NOT the live menu.
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

// scopeFromCwd lives in utils/scope to avoid a hook→component cycle.
export { scopeFromCwd };

// localStorage key for the canvas layout: view keys by scope, edit by topology.
export function layoutStorageKey( { mode, editingName, scopeKey } ) {
	if ( 'edit' === mode ) {
		return editingName
			? `newspack-nodes:topology:edit:${ editingName }`
			: null;
	}
	return `newspack-nodes:topology:${ scopeKey }`;
}

// Browser console 'status' summary — JS analogue of the PHP cli status_lines.
export function statusLines( { ssePid, cwd, worker } ) {
	if ( ! ssePid ) {
		return [ 'Browser console — no SSE session (not connected).' ];
	}
	return [
		`Browser console — SSE session ${ ssePid }`,
		`  cwd: ${ cwd || '/' }`,
		worker
			? `  attached worker: ${ worker.topology }.p${ worker.partition }`
			: '  no attached worker (local graph).',
	];
}

// Longest worker menu item prefixing 'path' (its mount), or null.
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

// Active worker the cwd resolves to, or null — the ONE gate poll+SSE share.
export function workerPollPath( cwd, pathOptions ) {
	const worker = longestWorkerPrefix( cwd, pathOptions );
	return worker ? `${ worker.topology }.p${ worker.partition }` : null;
}

// True only for an attached-worker TO — its async reply needs the SSE pid.
export function toNeedsSseSession( to ) {
	return /^[a-z0-9_-]+\.p\d+(?:\/|$)/.test( to || '' );
}

// REPL ceiling from measured appHeight − repl-bar − handle; null pre-layout.
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
	// Honor deep link via SEED or live; SEED wins — bundles clobber live.
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

export default function TopologyConsole( { headerControlsSlot } ) {
	const [ topology, setTopology ] = useState( () =>
		initialTopologyFromUrl( TOPOLOGIES[ 0 ] )
	);
	const [ partition, setPartition ] = useState( () =>
		initialPartitionFromUrl()
	);
	// Display-only mirror of GraphView's authoritative selection.
	const [ selectedId, setSelectedId ] = useState( null );
	// edit freezes a draft; baseline is the edit-entry draft (dirty check).
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
	// Source of the topology being edited; drives the DELETE button.
	const [ editingSource, setEditingSource ] = useState( '' );

	// { name, drop } for a just-dropped topology awaiting its cluster layout.
	const pendingClusterRef = useRef( null );

	const [ discardModal, setDiscardModal ] = useState( null );
	// Live-mode palette drop with declared args stages here (NewNodeModal).
	const [ pendingDrop, setPendingDrop ] = useState( null );
	const [ saveModal, setSaveModal ] = useState( null );
	// { name } while the post-save "Activate now?" prompt is up, else null.
	const [ activateModal, setActivateModal ] = useState( null );
	// Pending delete confirm: { name } while ConfirmModal is up, else null.
	const [ deleteModal, setDeleteModal ] = useState( null );
	const [ openModalShown, setOpenModalShown ] = useState( false );
	const [ settingsOpen, setSettingsOpen ] = useState( false );
	const [ toast, setToast ] = useState( null );
	// Palette chrome shared with the debug overlay; key varies by mode.
	const {
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
	// Apply the persisted skin to <html> on mount (global root class).
	useEffect( () => {
		initSkin();
	}, [] );
	const saveTopology = useSaveTopology();
	const deleteTopology = useDeleteTopology();
	const fetchTopology = useTopology();
	const topologyList = useTopologyList( { enabled: openModalShown } );
	// Two catalogs: PHP (HTTP; workers/edit) and JS (browser make_node).
	const phpCatalog = useClassCatalog( { enabled: true } );
	const loadPhpCatalog = phpCatalog.load;
	const jsCatalog = useJsCatalog();
	const vaultCatalog = useVaults( { enabled: true } );
	// Measure .topology-app so the REPL ceiling tracks real height.
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

	// Dumper verbosity dial (0/1/2); a ref so it's read without re-binding.
	const debugLevelRef = useRef( 0 );
	// Reactive mirror of the dial so the Inspector's Verbose toggle reads it.
	const [ debugLevel, setDebugLevel ] = useState( 0 );

	// "reset graph" stashes the cwd so the shell sync can restore it.
	const cwdRestoreRef = useRef( null );

	// Shell cwd mirrored into React; shell.path is the source of truth.
	const [ cwd, setCwd ] = useState( '' );

	// Live topology catalog (counts + active set) from topologies.list.
	const {
		partitions: topologyWorkers,
		active: activeTopologies,
		entries: topologyEntries,
		reload: reloadCatalog,
	} = useTopologyCatalog();

	// Every cwd the Path menu can select; recomputed from the live catalog.
	const pathOptions = useMemo(
		() => buildPathOptions( topologyWorkers, activeTopologies ),
		[ topologyWorkers, activeTopologies ]
	);

	// SSE off in edit mode / off-worker cwd; same detection as poll gate.
	const { status, ssePid, shell, seedError } = useConsoleGraph( {
		topology,
		partition,
		enabled: mode !== 'edit',
		// One RemoteIpc per active worker, keyed by {topology}.p{N}.
		workers: pathOptions.filter( ( o ) => parseWorker( o ) ),
		streamEnabled: null !== workerPollPath( cwd, pathOptions ),
		debugLevelRef,
		loadCatalog: loadPhpCatalog,
	} );
	useEffect( () => {
		const error = seedError || phpCatalog.error;
		if ( ! error ) {
			return;
		}
		const msg =
			( error && error.data && error.data.message ) ||
			( error && error.message ) ||
			__( 'Failed to load the PHP class catalog.', 'newspack-nodes' );
		setToast( { kind: 'error', text: msg } );
	}, [ seedError, phpCatalog.error ] );

	// Canvas/transcript state lives on dedicated nodes (WIRING-PLAN §4).
	const { graph: parsed, hasNodes: parsedHasNodes } = useGraphSource( {
		coreFallback: false,
	} );
	const uptime = useNodeState( names.UPTIME, 'uptime' ) ?? null;
	// Tab-completion candidates from `_completion` ( { candidates, seq } ).
	const completion = useNodeState( names.COMPLETION, 'candidates' ) ?? null;
	const transcript =
		useNodeState( names.OUTPUT, 'transcript' ) ?? EMPTY_TRANSCRIPT;

	// The silent canvas polls fill the CommandInterpreter directly (§5).
	const fillCommandInterpreter = useNodeFill( names.COMMAND_INTERPRETER );

	// Re-sync mirrored cwd on shell change; restore pre-reset cwd on reset.
	useEffect( () => {
		if ( shell ) {
			if ( cwdRestoreRef.current !== null ) {
				shell.path = cwdRestoreRef.current;
				cwdRestoreRef.current = null;
			}
			setCwd( shell.path );
		}
	}, [ shell ] );

	// Derive the display/storage scope from the cwd, not stale topology state.
	const scope = scopeFromCwd( cwd );

	/**
	 * Whose includes are we showing? The draft in edit mode; in view mode, the
	 * topology on screen — reading draft.includes there leaks a stale edit's
	 * hulls onto a completely different topology's live graph.
	 */
	const viewedIncludes = useMemo( () => {
		const entry = ( topologyEntries || [] ).find(
			( t ) => t.name === scope.label
		);
		return entry?.includes || [];
	}, [ topologyEntries, scope.label ] );
	const activeIncludes = useMemo(
		() => ( 'edit' === mode ? draft.includes || [] : viewedIncludes ),
		[ mode, draft.includes, viewedIncludes ]
	);

	// The composed `topologies expand` result for that include set.
	const { baseline: expandBaseline, error: expandError } =
		useExpandedIncludes( activeIncludes );
	// Previous expandBaseline, so reconcile can diff old vs new on each change.
	const prevExpandBaselineRef = useRef( null );
	useEffect( () => {
		// The draft is inert outside edit mode; skip the wasted reconcile.
		if ( mode !== 'edit' ) {
			return;
		}
		// Read the ref NOW: the updater runs at render, after the line below.
		const prev = prevExpandBaselineRef.current;
		setDraft( ( g ) => reconcileIncludes( g, prev, expandBaseline ) );
		prevExpandBaselineRef.current = expandBaseline;
	}, [ expandBaseline, mode ] );

	// Pick the catalog where make_node runs: JS at cwd '/', else PHP.
	const catalog =
		mode !== 'edit' && scope.key === 'local' ? jsCatalog : phpCatalog;

	// Server-saved layout (fetchLayout): seed source, autoLayout is fallback.
	const [ savedLayout, setSavedLayout ] = useState( null );
	const { fetchLayout, saveLayout } = useLayout();
	const effectiveTopologyName =
		mode === 'edit' && editingName ? editingName : topology;

	useEffect( () => {
		if ( ! effectiveTopologyName ) {
			setSavedLayout( null );
			return undefined;
		}
		const requestedTopologyName = effectiveTopologyName;
		let active = true;
		// Null while fetching so init can't lock in stale positions.
		setSavedLayout( null );
		fetchLayout( requestedTopologyName )
			.then( ( resp ) => {
				if ( ! active ) {
					return;
				}
				setSavedLayout( {
					name: requestedTopologyName,
					positions: resp?.positions || null,
				} );
			} )
			.catch( () => {
				if ( ! active ) {
					return;
				}
				setSavedLayout( {
					name: requestedTopologyName,
					positions: null,
				} );
			} );
		return () => {
			active = false;
		};
	}, [ effectiveTopologyName, fetchLayout ] );

	const currentSavedLayout =
		savedLayout?.name === effectiveTopologyName ? savedLayout : null;

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

	// Server layout fits only a matching-worker or edit scope, not cwd "/".
	const isServerScope =
		mode === 'edit' || ( scope.isWorker && scope.label === topology );

	// Edit-mode Reset blocks the server seed so the canvas autoLayouts.
	const [ serverSeedBlocked, setServerSeedBlocked ] = useState( false );
	useEffect( () => {
		setServerSeedBlocked( false );
	}, [ effectiveTopologyName, scope.key, mode ] );

	const serverPositionsMap = useMemo(
		() => savedPositionsToOverrides( currentSavedLayout ),
		[ currentSavedLayout, savedPositionsToOverrides ]
	);

	// Graph canvas renders: frozen draft in edit, live metadata in view.
	const layoutGraph = useMemo(
		() =>
			augmentWithVirtualEdges(
				mode === 'edit' ? draft : parsed,
				catalog.classes
			),
		[ mode, draft, parsed, catalog.classes ]
	);

	// VIEW waits for a REAL node; scaffolding-only layout tucks everything.
	const serverFetchResolved =
		! effectiveTopologyName || currentSavedLayout !== null;
	const graphHasContent =
		mode === 'edit' ? layoutGraph.nodes.length > 0 : parsedHasNodes;
	const layoutReady =
		graphHasContent && ( ! isServerScope || serverFetchResolved );

	// One layout entry per scope (view) or edited topology (edit).
	const positionStorageKey = layoutStorageKey( {
		mode,
		editingName,
		scopeKey: scope.key,
	} );
	const {
		positions: positionOverrides,
		viewport,
		viewportDelta,
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

	// Shared graph-dirty + Reset Graph logic (identical to the debug overlay).
	const { resetGraph: resetLocalGraphCore, canResetGraph } = useGraphReset( {
		shell,
		nodes: parsed.nodes,
		isLocalScope: '' === cwd,
		canRebuild: mode !== 'edit',
		markDirty,
	} );

	// Save Layout chip gate: positions diverge from the server's saved layout.
	const layoutDivergesFromSaved = useMemo( () => {
		const saved =
			( currentSavedLayout && currentSavedLayout.positions ) || null;
		// Only ids still on the canvas; skip a deleted node's stale override.
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
	}, [ positionOverrides, currentSavedLayout, layoutGraph ] );

	// Reset Layout chip gating differs by mode (edit / server / local).
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
		const savedTopologyName = effectiveTopologyName;
		// Only serialize canvas ids; skip a deleted node's stale override.
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
				name: savedTopologyName,
				positions,
			} );
			setSavedLayout( ( currentLayout ) =>
				currentLayout && currentLayout.name !== savedTopologyName
					? currentLayout
					: {
							name: savedTopologyName,
							positions: resp.positions || null,
					  }
			);
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

	// Path selection (Path menu + REPL cd): set cwd, mount the deepest worker.
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

	// Mirror (topology, partition) into the URL via replaceState; skip p0.
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

	// Resolve the Dumper at call time so a graph swap targets the live node.
	const appendTranscript = useCallback( ( entry ) => {
		Core.node( names.OUTPUT )?.append( entry );
	}, [] );

	const clearTranscript = useCallback( () => {
		Core.node( names.OUTPUT )?.clear();
	}, [] );

	useEffect( () => {
		setSelectedId( null );
	}, [ topology, partition ] );

	// Clear METADATA cache on scope change so stale nodes don't autofit-lock.
	useEffect( () => {
		Core.node( names.METADATA )?.setState( 'metadata', null );
	}, [ scope.key ] );

	const dispatchStatement = useCallback(
		( statement, fields ) => {
			if ( ! shell ) {
				return;
			}
			// Branch before fill so the ssePid gate blocks only worker sends.
			const promptAtSend = `/${ shell.path }`;
			const parsedLine = shell.parse( statement );
			// cd mutates shell.path; route the new path like a Path-menu pick.
			handlePathChange( shell.path );
			// Echo input verbatim before the null-return; blanks stay silent.
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
				// Only an attached worker's async reply waits on the SSE pid.
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
				// Compose modal's flag checkboxes + FROM / ID / KEY inputs.
				applyComposeFields( parsedLine, fields );
				// dispatch (not sink.fill) so useGraphReset's tap sees it.
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
				// Reactive mirror for the Inspector's Verbose toggle.
				onDebugLevel: setDebugLevel,
				setSkin: applySkin,
				skins: THEMES,
				// Read fresh so list_skins marks the live skin.
				currentSkin: getStoredTheme(),
			} );
		},
		[ shell, ssePid, appendTranscript, clearTranscript, handlePathChange ]
	);

	// Live-canvas poll gating (WIRING-PLAN §4/§5): point _cwd.target at cwd.
	useEffect( () => {
		const cwdNode = Core.node( names.CWD );
		if ( cwdNode ) {
			// Track the cwd verbatim; a pidless worker cwd's POST no-ops.
			cwdNode.target = cwd;
		}
		// Keep the Shell's status lines current with the session/cwd.
		if ( shell ) {
			shell.statusLines = statusLines( {
				ssePid,
				cwd,
				worker: longestWorkerPrefix( cwd, pathOptions ),
			} );
		}
	}, [ shell, mode, ssePid, cwd, pathOptions ] );

	// Tab-completion query (WIRING-PLAN §5), shared via useCompletion.
	const { requestCompletion, handleShowCandidates } = useCompletion( {
		cwd,
		fill: fillCommandInterpreter,
		append: appendTranscript,
		skip: () => toNeedsSseSession( cwd ) && ! ssePid,
	} );

	// Unquoted ';' splits; a held continuation owns the whole next line.
	const sendLine = useCallback(
		( line, fields ) => {
			const stmts = shell?.hasPending()
				? [ line ]
				: splitStatements( line );
			for ( const stmt of stmts ) {
				dispatchStatement( stmt, fields );
			}
			if ( shell?.hasPending() ) {
				appendTranscript( {
					kind: 'sent',
					text: '',
					prompt: shell.pendingPrompt(),
				} );
			}
		},
		[ dispatchStatement, shell, appendTranscript ]
	);

	// Shared live-mode handlers (connect/remove/send/trace/invoke/drop).
	const liveHandlers = useGraphHandlers( {
		shell,
		graph: parsed,
		catalogClasses: catalog.classes,
		dispatch: ( echoLine, name, args, fields ) =>
			sendLine( echoLine, fields ),
		append: appendTranscript,
		onDropStage: setPendingDrop,
		prefix: ( target ) => shell?.prefix( target ),
		replyFrom: ( node ) => shell?.replyFrom( node ),
		sseGuard: ( to ) => ! ( toNeedsSseSession( to ) && ! ssePid ),
	} );

	// Route Inspector actions through the shared handler; focus the prompt.
	const handleInspectorAction = useCallback(
		( action, nodeId, payload, fields ) => {
			liveHandlers.onInspectorAction( action, nodeId, payload, fields );
			setReplExpanded( true );
			window.requestAnimationFrame( () => replInputRef.current?.focus() );
		},
		[ liveHandlers, setReplExpanded, replInputRef ]
	);

	// useCanvasLayout owns positions: autoLayout once, then drags mutate it.

	// Edit-mode toggle. Draft is authoritative; SSE pushes don't clobber it.
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
					Promise.all( [
						fetchTopology( topology ),
						loadPhpCatalog(),
					] )
						.then( async ( [ resp, loadedCatalog ] ) => {
							const parsedGraph = withResolvedConfigEdges(
								parseTsl( resp.tsl || '' ),
								resp.resolved_config_edges
							);
							const includeBaseline =
								resp.expanded ??
								( await fetchExpandedIncludes(
									parsedGraph.includes
								) );
							primeExpandedIncludes(
								parsedGraph.includes,
								includeBaseline
							);
							const loaded = withReplAnchor(
								applyLoadedBaseline(
									parsedGraph,
									includeBaseline,
									loadedCatalog.classes
								)
							);
							// Sync ref: re-fetch diffs vs THIS, not EMPTY.
							prevExpandBaselineRef.current = includeBaseline;
							setDraft( loaded );
							setBaseline( loaded );
							setEditingName( resp.name );
							setEditingSource( resp.source || '' );
						} )
						.catch( ( e ) => {
							// Draft stays blank; surface WHY, don't go silent.
							const msg =
								( e && e.data && e.data.message ) ||
								( e && e.message ) ||
								__(
									'Failed to load topology.',
									'newspack-nodes'
								);
							setToast( { kind: 'error', text: msg } );
						} );
				}
				return;
			}
			// Dirty = draft vs the edit-entry snapshot, not live parsed.
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
		[ mode, draft, baseline, topology, fetchTopology, loadPhpCatalog ]
	);

	// Source of truth: live `parsed` in view mode, frozen draft in edit mode.
	const baseCanvasGraph = mode === 'edit' ? draft : parsed;

	// Compose "To" list: the VIEWED graph (parsed.nodes), not Core.nodes.
	const composeTargets = useMemo(
		() => buildComposeTargets( parsed.nodes ),
		[ parsed.nodes ]
	);

	/**
	 * One soft hull per directly-declared include. Membership comes from the
	 * BASELINE's provenance intersected with the nodes actually on screen, so it
	 * works in live mode too, where metadata nodes carry no `origin` of their own.
	 */
	const hulls = useMemo( () => {
		const membership = expandBaseline.hulls || {};
		const onScreen = new Set(
			( ( 'edit' === mode ? draft.nodes : parsed.nodes ) || [] ).map(
				( n ) => n.id
			)
		);
		// @longform Depth per hull (parents paint below); a shared include
		// takes its DEEPEST occurrence — it must ride above every parent
		// chain pulling it, and the shallowest would pin it under one.
		const depthOf = {};
		const walkDepths = ( tree, depth ) => {
			Object.entries( tree || {} ).forEach( ( [ name, subtree ] ) => {
				depthOf[ name ] = Math.max( depthOf[ name ] ?? 0, depth );
				walkDepths( subtree, depth + 1 );
			} );
		};
		walkDepths( expandBaseline.tree, 1 );
		return Object.entries( membership )
			.map( ( [ include, memberIds ] ) => ( {
				include,
				depth: depthOf[ include ] ?? 0,
				nodeIds: memberIds.filter( ( id ) => onScreen.has( id ) ),
			} ) )
			.filter( ( h ) => h.nodeIds.length > 0 );
	}, [ expandBaseline, mode, draft.nodes, parsed.nodes ] );

	// Virtual edges are derived; origin is stamped (metadata carries none).
	const canvasGraph = useMemo( () => {
		const graph = stampOrigins(
			baseCanvasGraph,
			expandBaseline.hulls || {}
		);
		if ( mode !== 'edit' ) {
			return graph;
		}
		return augmentWithVirtualEdges( graph, catalog.classes );
	}, [ baseCanvasGraph, mode, catalog.classes, expandBaseline ] );

	// Runtime drift (roadmap [49]): live nodes not in the registered .tsl.
	const canonicalNodes = useCanonicalNodes( topology );
	const driftIds = useMemo(
		() =>
			mode === 'edit'
				? null
				: driftNodeIds( canvasGraph?.nodes, canonicalNodes ),
		[ mode, canvasGraph, canonicalNodes ]
	);

	// snapToGrid from utils/autoLayout — same constants the renderer uses.

	const handleDropNode = useCallback(
		( { shellName, x, y } ) => {
			// Live canvas: stage the NewNodeModal; position is cosmetic.
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
		// sendLine is consumed by commitPendingDrop (below), not this callback.
		[ mode, liveHandlers, handlePositionChange ]
	);

	// Palette topology drop; edit-only, like handleDropNode.
	const handleDropTopology = useCallback(
		( { name, x, y } ) => {
			if ( mode !== 'edit' ) {
				return;
			}
			pendingClusterRef.current = { name, drop: snapToGrid( x, y ) };
			setDraft( ( g ) => addInclude( g, name ) );
		},
		[ mode ]
	);

	// Unpositioned borrowed node is invisible; lay out below.
	useEffect( () => {
		const pending = pendingClusterRef.current;
		if ( ! pending ) {
			return;
		}
		const landed = ( expandBaseline.nodes || [] ).some( ( n ) =>
			( n.origin || [] ).includes( pending.name )
		);
		if ( ! landed ) {
			return;
		}
		const positions = clusterLayout(
			expandBaseline.nodes,
			expandBaseline.edges,
			pending.name,
			pending.drop,
			positionOverrides
		);
		for ( const [ id, pos ] of Object.entries( positions ) ) {
			handlePositionChange( id, pos );
		}
		pendingClusterRef.current = null;
	}, [ expandBaseline, handlePositionChange, positionOverrides ] );

	// Backstop for the palette's greying-out: revert to the last-good includes.
	useEffect( () => {
		if ( ! expandError ) {
			return;
		}
		setToast( { kind: 'error', text: expandError } );
		setDraft( ( g ) => ( {
			...g,
			includes: Object.keys( expandBaseline.tree || {} ),
		} ) );
		pendingClusterRef.current = null;
	}, [ expandError, expandBaseline ] );

	// Inspector's IncludeTree remove button.
	const handleRemoveInclude = useCallback(
		( name ) => setDraft( ( g ) => removeInclude( g, name ) ),
		[]
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
			// Optimistically inject the dropped node; the next poll reconciles.
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
			setDraft( ( graph ) =>
				connectDraftEdge( graph, from, to, catalog.classes )
			);
		},
		[ mode, liveHandlers, catalog.classes ]
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

	// DELETE shows only for a topology with a user-saved copy (stock kept).
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
			// A delete restarts the matching fleet — re-fetch the live catalog.
			invalidateExpandedIncludes();
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
				// Rewrite verb args on oldId so virtual edges track the rename.
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
				// Spread renamed so frontmatter + name survive the rewrite.
				return { ...renamed, nodes };
			} );
			// Carry the position override onto the new key. Dirty-neutral.
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

	// Not frontmatter: serializeTsl emits it as the file's last statement.
	const handleSecureLevelChange = useCallback( ( next ) => {
		setDraft( ( g ) => ( { ...g, secureLevel: next } ) );
	}, [] );

	// Opening a topology lands you in the editor, from live too — like New.
	const handleOpenPick = useCallback(
		async ( name ) => {
			setOpenModalShown( false );
			setMode( 'edit' );
			try {
				const [ resp, loadedCatalog ] = await Promise.all( [
					fetchTopology( name ),
					loadPhpCatalog(),
				] );
				const parsedGraph = withResolvedConfigEdges(
					parseTsl( resp.tsl || '' ),
					resp.resolved_config_edges
				);
				const includeBaseline =
					resp.expanded ??
					( await fetchExpandedIncludes( parsedGraph.includes ) );
				primeExpandedIncludes( parsedGraph.includes, includeBaseline );
				const next = withReplAnchor(
					applyLoadedBaseline(
						parsedGraph,
						includeBaseline,
						loadedCatalog.classes
					)
				);
				// Sync ref: re-fetch diffs vs THIS, not EMPTY.
				prevExpandBaselineRef.current = includeBaseline;
				// Replace draft AND baseline so the load starts clean.
				setDraft( next );
				setBaseline( next );
				setEditingName( resp.name );
				setEditingSource( resp.source || '' );
				setSelectedId( null );
				// Close settings so the panel reseeds from loaded frontmatter.
				setSettingsOpen( false );
				// Storage key includes editingName, so the hook auto-loads.
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
		[ fetchTopology, loadPhpCatalog ]
	);

	/**
	 * Drill into a hull: open the topology it stands for. This REPLACES the draft,
	 * so an edited draft must be confirmed away first — same contract as leaving
	 * edit mode, and for the same reason.
	 */
	const handleDrillIntoHull = useCallback(
		( name ) => {
			if ( ! draftIsDirty( draft, baseline ) ) {
				handleOpenPick( name );
				return;
			}
			setDiscardModal( {
				onConfirm: () => {
					setDiscardModal( null );
					handleOpenPick( name );
				},
				onCancel: () => setDiscardModal( null ),
			} );
		},
		[ draft, baseline, handleOpenPick ]
	);

	// SAVE snapshots the live graph via dump_config (edit saves the draft).
	const handleSave = useCallback( () => {
		if ( 'edit' === mode ) {
			setSaveModal( {} );
			return;
		}
		const dumper = Core.node( names.OUTPUT );
		if ( ! shell || ! dumper ) {
			return;
		}
		dumper.captureNextReply( 'dump_config', ( payload, isError ) => {
			const tsl = String( payload ?? '' );
			if ( isError || '' === tsl.trim() ) {
				setToast( {
					kind: 'error',
					text: __(
						'Could not capture the live topology.',
						'newspack-nodes'
					),
				} );
				return;
			}
			// Prefill a worker snapshot with its topology; local stays blank.
			setSaveModal( {
				tsl,
				initialName: scope.isWorker ? scope.label : '',
			} );
		} );
		sendLine( 'dump_config' );
	}, [ mode, shell, sendLine, scope ] );

	const handleOpen = useCallback( () => {
		setOpenModalShown( true );
	}, [] );

	const handleNew = useCallback( () => {
		// Carry the _repl anchor like handleModeChange's blank draft.
		const blank = withReplAnchor( {
			nodes: [],
			edges: [],
			frontmatter: {},
		} );
		// New starts a fresh topology from live mode too — lands you in edit.
		setMode( 'edit' );
		setDraft( blank );
		setBaseline( blank );
		setEditingName( '' );
		setEditingSource( '' );
		setSelectedId( null );
		setSettingsOpen( false );
		resetLayout();
	}, [ resetLayout ] );

	// Honor the Topologies tab's ?new / ?edit deep-links, then consume it.
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

	// "Reset graph" — shared useGraphReset rebuild; cwdRestoreRef keeps cwd.
	const handleResetGraph = useCallback( () => {
		cwdRestoreRef.current = cwd;
		resetLocalGraphCore();
	}, [ cwd, resetLocalGraphCore ] );

	// Class-name → schema map so serializeTsl fills empty positional slots.
	const schemasByShellName = useMemo(
		() =>
			Object.fromEntries(
				( catalog.classes || [] ).map( ( c ) => [ c.shell_name, c ] )
			),
		[ catalog.classes ]
	);

	// DOWNLOAD: write the draft out as <name>.tsl via a Blob object URL.
	const handleDownload = useCallback( () => {
		const tsl = serializeTsl( draft, schemasByShellName, expandBaseline );
		const blob = new window.Blob( [ tsl ], { type: 'text/plain' } );
		const url = window.URL.createObjectURL( blob );
		const a = document.createElement( 'a' );
		a.href = url;
		a.download = `${ editingName || 'untitled' }.tsl`;
		document.body.appendChild( a );
		a.click();
		a.remove();
		window.URL.revokeObjectURL( url );
	}, [ draft, schemasByShellName, expandBaseline, editingName ] );

	// UPLOAD: load a .tsl file's text into the draft; baseline stays → dirty.
	const handleUpload = useCallback(
		async ( file ) => {
			try {
				const [ text, loadedCatalog ] = await Promise.all( [
					file.text(),
					loadPhpCatalog(),
				] );
				const parsedGraph = parseTsl( text );
				const includeBaseline = await fetchExpandedIncludes(
					parsedGraph.includes
				);
				primeExpandedIncludes( parsedGraph.includes, includeBaseline );
				const loaded = withReplAnchor(
					applyLoadedBaseline(
						parsedGraph,
						includeBaseline,
						loadedCatalog.classes
					)
				);
				// Sync ref: the reconcile effect diffs vs THIS, not EMPTY.
				prevExpandBaselineRef.current = includeBaseline;
				setDraft( loaded );
				setToast( {
					kind: 'success',
					text: sprintf(
						// translators: %s: uploaded file name.
						__( 'Loaded %s into the editor.', 'newspack-nodes' ),
						file.name
					),
				} );
			} catch ( e ) {
				const msg =
					( e && e.message ) ||
					__( 'Upload failed', 'newspack-nodes' );
				setToast( { kind: 'error', text: msg } );
			}
		},
		[ loadPhpCatalog ]
	);

	const handleSaveConfirm = useCallback(
		async ( name ) => {
			// Live SAVE carries captured TSL; edit serializes the draft.
			const capturedTsl = saveModal?.tsl;
			setSaveModal( null );
			// Snapshot new-vs-existing before the save reloads the catalog.
			const isNewTopology = ! Object.prototype.hasOwnProperty.call(
				topologyWorkers,
				name
			);
			try {
				const tsl =
					capturedTsl ??
					serializeTsl( draft, schemasByShellName, expandBaseline );
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
				// Written user copy now deletable: 'both' if it shadows stock.
				setEditingSource( resp.shadows_stock ? 'both' : 'user' );
				// Refresh the picker so the next Open sees the new topology.
				topologyList.reload();
				// A save restarts the fleet — re-fetch the live catalog.
				invalidateExpandedIncludes();
				reloadCatalog();
				setSettingsOpen( false );
				setMode( 'view' );
				// A brand-new topology saves inactive; offer to activate now.
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
			saveModal,
			draft,
			saveTopology,
			topologyList,
			schemasByShellName,
			expandBaseline,
			reloadCatalog,
			topologyWorkers,
		]
	);

	// "Activate now?" confirm — dispatch 'topologies activate <name>'.
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
					args: formatCommandArgs( [ name ] ),
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

	// Console controls: node=portal, null=nothing, undefined=inline.
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
			onDownload={ handleDownload }
			onUpload={ handleUpload }
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
			className={ `topology-app newspack-nodes-theme is-inspector-open${
				mode === 'edit' ? ' is-edit-mode' : ''
			}${ paletteCollapsed ? ' is-palette-collapsed' : '' }${
				inspectorCollapsed ? ' is-inspector-collapsed' : ''
			}` }
		>
			{ /* Console controls — portaled into the hub header slot. */ }
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
					// Only the local (cwd root) graph is resettable.
					onResetGraph: canResetGraph ? handleResetGraph : null,
					editMode: mode === 'edit',
				} }
				buildingClassName="topology-canvas-building"
				showRepl={ mode !== 'edit' }
				// Hub owns the shared brand header; Console controls portal in.
				showHeader={ false }
				canvasProps={ {
					...canvasChromeProps,
					resetKey: `${ scope.key }|${ mode }|${ editingName }`,
					// Empty cwd = local graph; worker cwd = dump_metadata.
					local: '' === cwd,
					interactive: true,
					editMode: mode === 'edit',
					showPalette: true,
					paletteLoading: catalog.loading,
					classCatalog: schemasByShellName,
					catalog: catalog.classes,
					driftIds,
					formatters: catalog.formatters,
					vaults: vaultCatalog.vaults,
					streamStatus: status,
					positionOverrides,
					onPositionChange: handlePositionChange,
					viewport,
					viewportDelta,
					onViewportChange: handleViewportChange,
					onConnect: handleConnect,
					onRemoveNode: handleRemoveNode,
					onRemoveEdge: handleRemoveEdge,
					onDropNode: handleDropNode,
					onInspectorAction: handleInspectorAction,
					// Live Dumper verbosity — the Verbose toggle reads it.
					debugLevel,
					composeTargets,
					onRenameNode: handleRenameNode,
					onUpdateArgs: handleUpdateArgs,
					onUpdateVerbs: handleUpdateVerbs,
					hulls,
					topologies: topologyEntries,
					currentTopology: editingName,
					onDropTopology: handleDropTopology,
					includeTree: expandBaseline.tree,
					// Mode-aware: draft.includes would leak into live.
					includes: activeIncludes,
					onRemoveInclude: handleRemoveInclude,
					// Drill into a hull (guarded when the draft is dirty).
					onOpenTopology: handleDrillIntoHull,
					onSelectionChange: ( id ) => {
						setSelectedId( id );
						// Auto-open inspector; NO refocus (breaks Delete).
						openInspectorOnSelect( id );
					},
					selection: selectedId,
				} }
				replProps={ {
					...replChromeProps,
					prompt: `/${ cwd }`,
					streamStatus: status,
					// Input always enabled: any scope routes via _cwd.
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
					// Live: captured topology name; edit: the edited name.
					initialValue={ saveModal.initialName ?? editingName }
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
					vaults={ vaultCatalog.vaults }
					onConfirm={ commitPendingDrop }
					onCancel={ cancelPendingDrop }
				/>
			) }
			{ mode === 'edit' && settingsOpen && (
				<TopologySettingsPanel
					key={ editingName || 'untitled' }
					frontmatter={ draft.frontmatter || {} }
					configDefaultPartitions={ configDefaultPartitions }
					secureLevel={ draft.secureLevel || '' }
					onChange={ handleFrontmatterChange }
					onSecureLevelChange={ handleSecureLevelChange }
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
