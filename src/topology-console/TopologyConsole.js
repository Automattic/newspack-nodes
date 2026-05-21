/**
 * TopologyConsole — top-level shell.
 *
 * Wires:
 *   useConsoleGraph   → per-session in-browser node graph (SseConnector →
 *                       SessionSink; CommandOut). The console's live SSE-in
 *                       and command-out path flow through real nodes.
 *   useNodeState      → read SessionSink's metadata/uptime/transcript state
 *   parseMetadata     → derive {nodes, edges} (inside SessionSink)
 *   Header            → topology/partition selectors + LIVE LED
 *   Palette           → static class catalog (inert in v1)
 *   CanvasFrame       → plotter chrome (meta + reticles + title block)
 *   SchematicCanvas   → SVG node graph
 *   Inspector         → selected-node detail pane
 *   ReplFooter        → prompt + status line
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
import { shell, splitStatements } from './utils/shell';

// The topology dropdown and partition counts both come from the same map
// injected by the admin page as `NewspackNodesData.topologyPartitions`,
// itself built by enumerating every TSL file `Topology_Registry::list()`
// returns. That's the same set the admin Topologies checkbox renders,
// so the console dropdown surfaces both the operator's currently-active
// selections and any other TSL files they could turn on — not just the
// app's file-default catalog. Partition counts come from each topology's
// TSL frontmatter when present, with a sensible fallback.
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

// Active topologies (the ones the supervisor is currently spawning
// workers for) sort to the top of the dropdown so "what's running" is
// one click away regardless of how many other TSL files exist. Within
// each group we keep alphabetical order, which is what the admin
// already ships from PHP.
const TOPOLOGIES = ( () => {
	const all = Object.keys( topologyMap() );
	const active = activeTopologySet();
	return [ ...all ].sort( ( a, b ) => {
		const ad = active.has( a ) ? 0 : 1;
		const bd = active.has( b ) ? 0 : 1;
		return ad !== bd ? ad - bd : a.localeCompare( b );
	} );
} )();

function partitionList( topology ) {
	const n = topologyMap()[ topology ] || 1;
	return Array.from( { length: n }, ( _, i ) => i );
}

// URL-state helpers. The admin page deep-links to a topology/partition
// via ?topology=<name>&partition=<n>; the selectors below mirror back
// into the URL via history.replaceState so refreshing or copying the
// URL preserves the operator's current view.
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

// Live-canvas poll cadence (ms), client-side. Replaces the deleted
// TopologyStreamController's server-side STATS_INTERVAL_S / UPTIME_INTERVAL_S
// timer: now that the console tails the worker via the generic
// messages-stream, it pokes dump_metadata / uptime itself.
const STATS_INTERVAL_MS = 1000;
const UPTIME_INTERVAL_MS = 5000;

// Per-node rate history depth. With a 1s stats poll, 60 samples = ~1 minute
// of trailing data, plenty for a quick "is this node busy or quiet?" glance.
const RATE_HISTORY_MAX = 60;

// Stable empty defaults for the SessionSink-published node state, so a
// not-yet-populated `metadata` / `transcript` keeps a constant reference
// across renders (downstream useMemo / props don't churn before the
// graph mounts).
const EMPTY_GRAPH = { nodes: [], edges: [] };
const EMPTY_TRANSCRIPT = [];

export default function TopologyConsole() {
	const [ topology, setTopology ] = useState( () =>
		initialTopologyFromUrl( TOPOLOGIES[ 0 ] )
	);
	const [ partition, setPartition ] = useState( () =>
		initialPartitionFromUrl()
	);
	const [ selectedId, setSelectedId ] = useState( null );
	// Edge selection (edit mode only). { from, to } or null. Mutually
	// exclusive with selectedId — clicking either clears the other.
	const [ selectedEdge, setSelectedEdge ] = useState( null );
	// Hover state — lifted so the Inspector can highlight a node by
	// hovering one of its routing-list links (target/also/from).
	const [ hoveredId, setHoveredId ] = useState( null );
	// Edit-mode state. `view` (default) renders the live SSE-driven graph;
	// `edit` freezes a draft snapshot taken at the toggle moment so SSE
	// pushes never clobber operator work in progress. `baseline` is the
	// draft as it stood at edit-mode entry — kept separate so the dirty
	// check compares draft-vs-baseline (real edits) rather than
	// draft-vs-live-parsed (which would constantly disagree with itself
	// thanks to SSE counter updates).
	const [ mode, setMode ] = useState( 'view' );
	const [ draft, setDraft ] = useState( { nodes: [], edges: [] } );
	const [ baseline, setBaseline ] = useState( { nodes: [], edges: [] } );
	// Name of the topology being edited. Drives the canvas title +
	// pre-fills the Save modal. Reset on each edit-mode entry; updated
	// on Open and after a successful Save.
	const [ editingName, setEditingName ] = useState( '' );
	// Pending discard-confirm modal. Null = no modal. Holds the closure
	// to invoke if the user clicks "Discard" — keeps the confirm logic
	// declarative (state-driven), not imperative window.confirm-style.
	const [ discardModal, setDiscardModal ] = useState( null );
	// Save-topology PromptModal state. Null = closed; object = open.
	const [ saveModal, setSaveModal ] = useState( null );
	// Open-topology picker state. Boolean — modal mounts when true.
	const [ openModalShown, setOpenModalShown ] = useState( false );
	// Toast for the post-save success/error banner. { kind, text } or null.
	const [ toast, setToast ] = useState( null );
	const saveTopology = useSaveTopology();
	const deleteTopology = useDeleteTopology();
	const fetchTopology = useTopology();
	const topologyList = useTopologyList( { enabled: openModalShown } );
	// Lazy-load the class catalog the first time the user enters edit
	// mode AND in live mode (so the Inspector's per-class TM_REQUEST
	// buttons can read the `requests` schema). useClassCatalog caches
	// the response, so re-entries are free.
	const catalog = useClassCatalog( { enabled: true } );
	// Lifted: ReplFooter's transcript visibility, so Inspector actions
	// (Dump, Tail) can pop the pane open when they fire commands the
	// user wants to see the response of.
	const [ replExpanded, setReplExpanded ] = useState( false );
	// REPL input ref — canvas + Inspector handlers blur or re-focus it to
	// maintain the "transcript visible ⟺ prompt focused" invariant.
	const replInputRef = useRef( null );
	const refocusReplIfExpanded = useCallback( () => {
		if ( replExpanded ) {
			window.requestAnimationFrame( () => replInputRef.current?.focus() );
		}
	}, [ replExpanded ] );

	// Per-node rate tracking: { id: { count, ts, rate, lastChangedTs } }
	// Updated each time a `gui:auto` ls table arrives. rate = Δcount/Δs
	// across consecutive ticks; lastChangedTs marks the last tick where
	// count grew so the Inspector can render "Xs ago" without polling.
	const rateRef = useRef( new Map() );
	const [ rateVersion, setRateVersion ] = useState( 0 );

	// Local Dumper verbosity dial. 0 = curated render only (default);
	// 1 = prepend a one-line `<TM_FLAGS> from <from>: <value>` header
	// to every incoming msg; 2 = same as 1 but full envelope on the
	// header line and the value on the next line. Mirrors the substrate
	// Dumper's `debug_level` semantics. Held in a ref (not state) so
	// SessionSink reads it synchronously per-frame without re-binding the
	// graph every time the level changes.
	const debugLevelRef = useRef( 0 );

	// Mount the per-session node graph (SseConnector → SessionSink;
	// CommandOut). SSE off in edit mode — the operator is authoring
	// offline and shouldn't poke the live worker with `ls` ticks. The
	// stream resumes when they switch back to view mode.
	const { status, ssePid, sessionNode, commandOutName } = useConsoleGraph( {
		topology,
		partition,
		enabled: mode !== 'edit',
		debugLevelRef,
	} );

	// Read SessionSink's published state. `metadata` is the live parsed
	// graph (replaces the old `parsed` state); `uptime` is the right-half
	// of the worker's uptime line; `transcript` is the shared REPL buffer.
	const parsed = useNodeState( 'session', 'metadata' ) ?? EMPTY_GRAPH;
	const uptime = useNodeState( 'session', 'uptime' ) ?? null;
	const transcript =
		useNodeState( 'session', 'transcript' ) ?? EMPTY_TRANSCRIPT;

	// Fill the command-out node — both the silent poll and the REPL drive
	// sends through this single function.
	const fillCommandOut = useNodeFill( commandOutName );

	// User-pinned positions, keyed by node name. Survives reloads via
	// localStorage; scoped per `topology.partition` so positions don't
	// bleed between worker types. Loaded on topology/partition change;
	// updates write back synchronously on each drag commit.
	const positionStorageKey = `newspack-nodes:topology:${ topology }.p${ partition }:positions`;
	// Each entry: { x, y, user?: boolean }. `user: true` marks a
	// position the operator explicitly placed via drag — only those
	// persist to localStorage and only those toggle "Reset Layout".
	// Auto-seeded positions (from autoLayout on edit-mode entry)
	// stay in-memory only and don't trip the reset affordance.
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
				// Persist user-tagged entries only — auto-seeded
				// positions are transient and re-derived each session.
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
					// localStorage may be disabled / quota'd; silently
					// fall back to in-session-only overrides.
				}
				return next;
			} );
		},
		[ positionStorageKey ]
	);
	// Pan/zoom viewport — same persistence shape as positionOverrides
	// so reloads / topology switches preserve the user's last view.
	// Null means "no override" → SchematicCanvas autofits to the
	// tight bbox. Writes debounce via a 200ms timeout so a pan-drag's
	// 60 setState/sec doesn't hammer localStorage.
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
					// localStorage quota'd / disabled; in-memory only.
				}
			}, 200 );
		},
		[ viewportStorageKey ]
	);

	// Server-side saved layout for the current topology (fetched on
	// topology change). Reset Layout reverts to this; Save Layout
	// writes the current positionOverrides to it. Null until the
	// fetch has resolved; an empty `positions` map means "no saved
	// layout exists" and Reset falls back to autoLayout.
	const [ savedLayout, setSavedLayout ] = useState( null );
	const { fetchLayout, saveLayout } = useLayout();
	const effectiveTopologyName =
		mode === 'edit' && editingName ? editingName : topology;

	useEffect( () => {
		if ( ! effectiveTopologyName ) {
			setSavedLayout( null );
			return;
		}
		// Null while fetching so the live-mode seed effect can't lock
		// in stale positions from the previous topology before the
		// new fetch resolves.
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

	// Pending "Reset layout — are you sure?" modal. Edit-mode only;
	// live mode resets without confirmation since the change is
	// in-session.
	const [ resetConfirm, setResetConfirm ] = useState( null );

	// Convert a savedLayout payload to the {id: {x, y}} shape
	// positionOverrides uses. Returns null when the payload is empty
	// or malformed so callers can branch cleanly.
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

	// Restore the canvas to a default layout. Edit-mode default is
	// the programmatic autoLayout (empty overrides); live-mode default
	// is the operator-pinned saved layout (or autoLayout if none).
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
	// Layout-control visibility. The default state for each mode:
	//   - edit: empty positionOverrides (canvas falls back to autoLayout)
	//   - live: positionOverrides == savedLayout (operator-pinned baseline)
	// Reset Layout shows whenever current ≠ default. Save Layout shows
	// (in edit mode only) whenever current ≠ savedLayout — something to
	// persist.
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

	// If the user switches to a topology with fewer partitions than the
	// one they were on, reset the partition selector to p0 so we don't
	// stream from a non-existent worker.
	useEffect( () => {
		if ( partition >= partitions.length ) {
			setPartition( 0 );
		}
	}, [ partitions, partition ] );

	// Mirror the current (topology, partition) into the URL so refreshing
	// or copy-pasting the address preserves what the operator is looking
	// at. `replaceState` instead of `pushState` — these are filter
	// toggles, not navigation events, and stacking them in the back-
	// button history would be annoying. `partition=0` is the default and
	// stays out of the URL to keep the canonical share-link minimal.
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

	// Append a transcript entry through the SessionSink (which owns the
	// shared ring buffer + cap). REPL echoes, errors, and info lines all
	// route here so they interleave with incoming-message renders in the
	// order they occur.
	const appendTranscript = useCallback(
		( entry ) => {
			sessionNode?.append( entry );
		},
		[ sessionNode ]
	);

	// Clear the shared transcript (the `clear` builtin + ReplFooter's
	// clear button).
	const clearTranscript = useCallback( () => {
		sessionNode?.clear();
	}, [ sessionNode ] );

	// Reset selection when the (topology, partition) pair changes — a fresh
	// REPL session. The parsed graph + transcript live in the SessionSink,
	// which useConsoleGraph re-creates for the new worker, so they reset
	// on their own.
	useEffect( () => {
		setSelectedId( null );
	}, [ topology, partition ] );

	// Per-node rate + last-changed tracking, driven off the SessionSink's
	// published `metadata` graph. Each `gui:auto` poll produces a NEW
	// metadata object inside the SessionSink, so this effect fires exactly
	// once per tick (the same cadence the old inline gui:auto branch ran
	// at). Same tick drives both — Δcount/Δs gives the msg/s rate, and a
	// non-zero Δcount marks the node as "live, recently active." Also
	// appends to a ring-buffer history (cap RATE_HISTORY_MAX samples) so
	// the canvas can draw a per-node sparkline.
	//
	// Byte-rate histories (readHistory / writtenHistory) ride alongside on
	// the same tick so the inspector can plot bytes/s read and written with
	// the same horizontal axis as the msg/s sparkline. A worker respawn
	// resets the counters the same way the message counter resets, so we
	// clamp negatives to zero the same way.
	useEffect( () => {
		const now = Date.now() / 1000;
		let touched = false;
		for ( const n of parsed.nodes ) {
			const prevEntry = rateRef.current.get( n.id );
			const bytesRead = n.bytesRead || 0;
			const bytesWritten = n.bytesWritten || 0;
			// Sticky "has ever been non-zero" flags per stat. The Inspector
			// uses these to gate sparkline rendering — once a stat has seen
			// activity, the plot stays even when the counter resets to 0
			// (e.g. worker respawn). Prevents graphs from blinking out the
			// moment a worker recycles.
			const hasMessages =
				( prevEntry && prevEntry.hasMessages ) || n.count > 0;
			const hasRead = ( prevEntry && prevEntry.hasRead ) || bytesRead > 0;
			const hasWritten =
				( prevEntry && prevEntry.hasWritten ) || bytesWritten > 0;
			if ( prevEntry && prevEntry.ts < now ) {
				// A worker respawn resets the counter, so dCount can go
				// strongly negative on the first tick of a new process.
				// Treat that as "rate unknown" (0) — using the raw delta
				// would draw a deep dip below the baseline that
				// misrepresents what just happened.
				const rawDCount = n.count - prevEntry.count;
				const dCount = rawDCount < 0 ? 0 : rawDCount;
				const rawDRead = bytesRead - ( prevEntry.bytesRead || 0 );
				const dRead = rawDRead < 0 ? 0 : rawDRead;
				const rawDWritten =
					bytesWritten - ( prevEntry.bytesWritten || 0 );
				const dWritten = rawDWritten < 0 ? 0 : rawDWritten;
				// Clamp to the nominal tick interval (1s) so bunched-up
				// gui:auto responses — e.g. two arrivals 100ms apart after
				// a worker stall — don't divide a full tick's delta by a
				// tiny dt and report a 10× spike. Worst case we under-report
				// on a genuinely-fast tick; the alternative (nonsense peaks)
				// is worse for the auto-scaling sparkline.
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
			const interpreted = shell( statement );
			if ( ! interpreted ) {
				return;
			}
			// Echo the user's input verbatim so they see what was
			// dispatched. Sigil styling distinguishes outgoing from
			// responses in the transcript.
			appendTranscript( { kind: 'sent', text: statement } );

			if ( interpreted.kind === 'error' ) {
				appendTranscript( { kind: 'error', text: interpreted.text } );
				return;
			}
			if ( interpreted.kind === 'local' ) {
				if ( interpreted.name === 'clear' ) {
					clearTranscript();
				} else if ( interpreted.name === 'debug_level' ) {
					// Match the substrate Shell's `debug_level` builtin:
					// no-arg = toggle between 0 and 1; numeric = set
					// explicitly (clamped 0..2). The shell parser
					// already returns `null` for no-arg and rejects
					// out-of-range numeric input.
					if ( interpreted.level === null ) {
						debugLevelRef.current =
							debugLevelRef.current > 0 ? 0 : 1;
					} else {
						debugLevelRef.current = Math.max(
							0,
							Math.min( 2, interpreted.level )
						);
					}
					appendTranscript( {
						kind: 'info',
						text: `debug_level: ${ debugLevelRef.current }`,
					} );
				}
				return;
			}
			// kind === 'post'
			if ( ! ssePid ) {
				appendTranscript( {
					kind: 'error',
					text: '[no sse_pid yet] retry once CONNECTED',
				} );
				return;
			}
			// Fill the command-out node, which posts a connect_worker_input +
			// the command and pivots the worker's reply back through this
			// session's open messages-stream connection via FROM=`_http/<ssePid>`.
			// Fire-and-forget — the worker's real reply arrives async over
			// the SSE stream and lands in the transcript via SessionSink.
			fillCommandOut( { commands: [ interpreted.body ] } );
		},
		[ ssePid, appendTranscript, clearTranscript, fillCommandOut ]
	);

	// Live-canvas poll. The deleted TopologyStreamController fired
	// dump_metadata/uptime server-side on a timer; now that we tail the
	// worker through the generic messages-stream, the console drives the
	// poll itself by filling the command-out node. KEY=gui:auto /
	// gui:uptime route the responses to the silent canvas-refresh path
	// (SessionSink), distinct from user-typed gui:typed commands. Paused in
	// edit mode (the stream is closed) and until the session pid lands from
	// the connected envelope.
	useEffect( () => {
		if ( mode === 'edit' || ! ssePid ) {
			return undefined;
		}
		const dumpCmd = {
			type: 'command',
			name: 'dump_metadata',
			arguments: '',
			key: 'gui:auto',
		};
		const uptimeCmd = {
			type: 'command',
			name: 'uptime',
			arguments: '',
			key: 'gui:uptime',
		};
		// dump_metadata fires every tick; uptime (slower) rides the SAME batch
		// whenever its cadence has elapsed — one /command request + one worker
		// mount per cycle instead of two. The immediate paint sends both.
		fillCommandOut( { commands: [ dumpCmd, uptimeCmd ] } );
		let sinceUptime = 0;
		const id = setInterval( () => {
			sinceUptime += STATS_INTERVAL_MS;
			const uptimeDue = sinceUptime >= UPTIME_INTERVAL_MS;
			if ( uptimeDue ) {
				sinceUptime = 0;
			}
			fillCommandOut( {
				commands: uptimeDue ? [ dumpCmd, uptimeCmd ] : [ dumpCmd ],
			} );
		}, STATS_INTERVAL_MS );
		return () => clearInterval( id );
	}, [ mode, ssePid, fillCommandOut ] );

	// Split the typed line on unquoted `;` so `help; ls` dispatches two
	// commands instead of one. Each statement runs through
	// dispatchStatement independently — local builtins (clear,
	// debug_level) and remote POSTs interleave in the order typed.
	const sendLine = useCallback(
		( line ) => {
			for ( const stmt of splitStatements( line ) ) {
				dispatchStatement( stmt );
			}
		},
		[ dispatchStatement ]
	);

	// Inspector action dispatch. Each action maps to a verb the user
	// could have typed at the REPL; routing through sendLine keeps the
	// echo + response visible in the transcript instead of being a
	// silent backchannel.
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
				// payload here is the target level (0 to disable, 1
				// to enable) — Inspector decides based on the current
				// debug_state field from the latest dump_metadata.
				const level = typeof payload === 'number' ? payload : 1;
				sendLine( `debug_state ${ nodeId } ${ level }` );
			} else if ( action === 'request' ) {
				// payload here is the request verb (e.g. GET_LAG).
				// `request_node` (alias `request`) sends a TM_REQUEST
				// at the target node; the reply walks TO=FROM back via
				// `_http/<ssePid>` to this messages-stream session.
				sendLine( `request_node ${ nodeId } ${ payload }` );
			}
			// Always pop the transcript open after an Inspector action
			// — the user's expecting to see the worker's reply. Move
			// focus to the prompt too so the next keystroke goes into a
			// follow-up command (and the invariant "transcript shown ⟺
			// prompt focused" holds after this state change).
			setReplExpanded( true );
			window.requestAnimationFrame( () => replInputRef.current?.focus() );
		},
		[ sendLine ]
	);

	// Augment a graph with virtual edges synthesized from node_name
	// verb args (e.g. RequestBuilder's set_errors_target target=…).
	// Used by both the canvas's display graph and the auto-layout
	// seeder so loaded topologies place verb-targeted nodes in the
	// right columns (otherwise autoLayout treats them as sources and
	// stacks them at column 0).
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

	// Merge savedLayout positions into positionOverrides without
	// clobbering existing entries. User-tagged drags always survive;
	// only ids the operator hasn't placed yet pick up saved-layout
	// values.
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

	// EDIT auto-load races the catalog fetch — the seed may fire
	// before catalog.classes is populated, in which case virtual
	// edges aren't computed and verb-targeted nodes stack at column
	// 0. Re-seed once the catalog arrives, but only if the user
	// hasn't started editing yet (draft still matches baseline).
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

	// Live-mode seed. Fires once per (topology, savedLayout) when
	// positionOverrides is empty — so reset, fresh-mount, or
	// edit→live-with-other-topology all land their saved positions
	// here. The empty-overrides gate makes this a no-op on every
	// later SSE tick (drags + seeded entries keep it non-empty).
	// Viewport=null batches alongside the seed so SchematicCanvas's
	// autofit-commit hook refits to the new bbox in one render.
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

	// Edit-mode toggle. Entering: snapshot the live parsed as the
	// draft baseline; leaving: pop a confirm modal if the draft has
	// diverged from the (current) live snapshot. The draft is
	// authoritative inside edit mode — SSE pushes don't clobber it.
	const handleModeChange = useCallback(
		( next ) => {
			if ( next === mode ) {
				return;
			}
			if ( next === 'edit' ) {
				// Entering edit mode: auto-load the currently-live
				// topology so the operator continues with what they
				// were just looking at. Falls back to a blank canvas
				// if no live topology is selected, or the fetch fails.
				// Use the NEW button to start blank explicitly.
				setMode( 'edit' );
				setEditingName( '' );
				rateRef.current = new Map();
				setRateVersion( ( v ) => v + 1 );
				// Preserve positionOverrides + viewport so user
				// customizations from a previous edit session of
				// the same topology stick. seedOverridesFromLayout
				// will no-op if overrides exist; Reset Layout is
				// the explicit "start over" affordance.
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
							// Re-seed on catalog load (effect below).
							// Initial seed here in case the catalog
							// is already populated (re-entry into
							// edit mode within the same session).
							seedOverridesFromLayout();
						} )
						.catch( () => {
							// Silent fallback — operator can build
							// from scratch or click OPEN to pick
							// something else.
						} );
				}
				return;
			}
			// Going back to view: dirty iff the draft has diverged from
			// the snapshot taken at edit-mode entry. Live `parsed` keeps
			// changing under SSE (counters, flowing edges, late-arriving
			// nodes) — if we compared against parsed we'd flag every
			// edit-mode session as dirty even if the operator never
			// touched anything.
			const dirty =
				JSON.stringify( draft ) !== JSON.stringify( baseline );
			// Re-fit the live canvas when the edit session leaves stale
			// positions on screen: either the operator just hit Reset
			// (positionOverrides empty → live-mode seed will repopulate
			// from saved layout), or they were editing a different
			// topology than what's live (current overrides match the
			// edit graph, not the live one). Wipe the latter so the
			// live-mode seed gets a clean slate; the former is already
			// empty and just needs a viewport reset. Both branches
			// batch with setViewport(null) so SchematicCanvas's
			// autofit-commit hook fires on the rebuilt bbox.
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

	// View vs edit picks the source of truth for everything downstream:
	// canvas, inspector, node-name lookup. SSE keeps writing `parsed`
	// underneath; the draft is frozen until the user saves or discards.
	const baseCanvasGraph = mode === 'edit' ? draft : parsed;

	// Augmented draft graph: synthesize edges from any verb whose
	// schema declares an arg of type `node_name` (e.g. RequestBuilder's
	// `set_errors_target target=errors:partition` is a logical wire to
	// the named partition). These are visualized on the canvas but
	// don't appear in the draft's edges array — they're derived from
	// verbInvocations + the catalog schema. Marked `virtual: true` so
	// the canvas can paint them dimmer and skip the click-to-delete
	// hit-target (the operator unchecks the verb to remove them).
	const canvasGraph = useMemo( () => {
		if ( mode !== 'edit' ) {
			return baseCanvasGraph;
		}
		return augmentWithVirtualEdges( baseCanvasGraph );
	}, [ baseCanvasGraph, mode, augmentWithVirtualEdges ] );

	// Drop handler — fired by SchematicCanvas when the user releases a
	// palette drag over the SVG. The shellName comes from the
	// dataTransfer payload set by Palette; (x, y) is already projected
	// into SVG-space by the canvas.
	const handleConnect = useCallback( ( from, to ) => {
		setDraft( ( g ) => {
			// Non-Tee nodes have a single target slot — dragging a new
			// wire replaces the existing one. Tees fan out, so new
			// wires accumulate.
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

	// Selecting one clears the other — node and edge selection are
	// mutually exclusive so the Delete key has unambiguous intent. Both
	// re-focus the REPL prompt if it was focused before the click; the
	// browser's default moves focus to the SVG group on click.
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

	// Spends the first canvas click on dismissing the prompt (blur +
	// collapse). Returning true tells the canvas to skip its own
	// deselect-or-autofit action for this click; the next plain canvas
	// click proceeds normally.
	const handleCanvasBackgroundClickConsumed = useCallback( () => {
		if ( ! replExpanded ) {
			return false;
		}
		setReplExpanded( false );
		replInputRef.current?.blur();
		return true;
	}, [ replExpanded ] );

	// Keyboard: Delete/Backspace removes whichever is selected. Only
	// active in edit mode — and skipped when the focus is in a form
	// field so the user can edit text without nuking nodes.
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

	// Save flow — open the PromptModal. Confirm-side runs serializeTsl,
	// POSTs via useSaveTopology, then either toasts success and exits to
	// view mode, or toasts the validation error and stays in edit mode
	// so the operator can fix the issue.
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

	// Whether a DELETE button should appear in the header — true only
	// when the currently-edited topology has a user-saved copy. Stock
	// TSL files are protected (the REST controller returns 404 if asked
	// to delete a stock-only topology). `topologyList.topologies` is
	// the same array OpenTopologyModal renders; we look up the current
	// `editingName` and check its `source` (`user` or `both`).
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
			// Drop the editor back to view mode so the operator isn't
			// staring at a draft of a file that no longer exists.
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
				// Replace the draft AND baseline so the just-loaded
				// topology starts clean — discarding back to view mode
				// won't pop a confirm modal until the operator edits it.
				setDraft( next );
				setBaseline( next );
				setEditingName( resp.name );
				setSelectedId( null );
				setSelectedEdge( null );
				// Seed positionOverrides from the loaded graph's
				// auto-layout so subsequent drops/wires don't reshuffle
				// the rest of the canvas. Viewport reset = autofit on
				// the next render.
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

	// Pass the catalog as a class-name → schema map to serializeTsl so
	// it can fill empty positional slots with schema defaults (e.g.
	// `<config:segment_size>`) instead of stripping them as trailing
	// empties. Without this, a freshly-dragged Partition would save with
	// only its `base_dir` arg — Topology_Loader would then fall through
	// to the PHP class's hard-coded literal defaults instead of
	// resolving the operator's substrate-config values.
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
				// Refresh the picker's list — next "Open" sees the new
				// topology without a page reload. Cheap network call.
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
				// Rewrite node_name verb args on every OTHER node that
				// referenced oldId — keeps the augmented-graph virtual
				// edges in lockstep with the rename.
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
			// Carry the position override onto the new key so the
			// renamed node stays put.
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

	// Grid-snap drop coords to the visible grid lattice. The grid
	// pattern is offset by X_PAD + NODE_W/2 / Y_PAD + NODE_H/2 in
	// SVG-space so its intersections fall on node CENTERS; snap
	// uses the same origin to keep dropped-node centers on grid
	// lines. Returns the top-left position the renderer stores.
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
			// Snap the cursor coords to the auto-layout grid before
			// committing, so dropped nodes line up with the rest of
			// the canvas and dragging one later doesn't reveal
			// sub-pixel drift.
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

	// Pull rate info for the selected node. rateVersion is the
	// "something changed in the rate map" signal that drives the
	// useMemo recompute; the actual data lives in rateRef (mutable so
	// hot-path ls -ct ticks don't trigger a full state update per
	// node).
	const selectedRateInfo = useMemo(
		() => ( selectedId ? rateRef.current.get( selectedId ) : null ),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ selectedId, rateVersion ]
	);

	return (
		<div
			className={ `topology-app${
				selectedId ? ' is-inspector-open' : ''
			}${ mode === 'edit' ? ' is-edit-mode' : '' }` }
		>
			<Header
				topologies={ TOPOLOGIES }
				topology={ topology }
				onTopologyChange={ setTopology }
				partitions={ partitions }
				partition={ partition }
				onPartitionChange={ setPartition }
				streamStatus={ status }
				uptime={ uptime }
				mode={ mode }
				onModeChange={ handleModeChange }
				onSave={ handleSave }
				onOpen={ handleOpen }
				onNew={ handleNew }
				onDelete={ handleDelete }
				canDelete={ canDeleteCurrent }
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
			{ /* Inspector is only mounted when a node is selected — the
			"Select a node to inspect" empty state was a permanent 308px
			of dead pixels. Selecting any node restores the column via
			the `is-inspector-open` class on `.topology-app`. */ }
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
					topology={ topology }
					partition={ partition }
					streamStatus={ status }
					canSend={ status === 'open' && !! ssePid }
					onSubmit={ sendLine }
					onClear={ clearTranscript }
					transcript={ transcript }
					expanded={ replExpanded }
					onExpandedChange={ setReplExpanded }
					inputRef={ replInputRef }
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
					// Pre-fill the current topology name when editing an
					// existing one — Save-as-rename is the rare case, so
					// the default of saving over the same name should
					// be one click. PromptModal's effect auto-selects
					// the text so retyping replaces it.
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
