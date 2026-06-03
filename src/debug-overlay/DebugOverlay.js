import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';
import { Core } from '../runtime/core';
import { __ } from '@wordpress/i18n';
import CanvasFrame from '../topology-console/components/CanvasFrame';
import ConsoleShell from '../topology-console/components/ConsoleShell';
import { NewNodeModal } from '../topology-console/components/Modal';
import { makeReplDismissHandler } from '../topology-console/utils/replDismissHandler';
import { lockPageScroll, unlockPageScroll } from './pageScrollLock';
import { useJsCatalog } from '../topology-console/hooks/useJsCatalog';
import { useClassCatalog } from '../topology-console/hooks/useClassCatalog';
import { Shell } from '../topology-console/nodes/shell';
import { useNodeState } from '../runtime/react';
import { useCompletion } from '../topology-console/hooks/useCompletion';
import { usePanelChrome } from '../topology-console/hooks/usePanelChrome';
import names from '../runtime/reserved-node-names.json';
import {
	THEMES,
	PALETTE_COLLAPSED_STORAGE_KEY_LIVE,
} from '../topology-console/themes';
import { isDebugEnabled } from './isDebugEnabled';
import { useDebugFrame } from './useDebugFrame';
import { useDebugGraph } from './useDebugGraph';
import { useCanvasLayout } from '../topology-console/hooks/useCanvasLayout';
import { useDebugRepl } from './useDebugRepl';
import { useGraphReset } from './useGraphReset';
import './debug-overlay.scss';

// (We reuse the topology console's CanvasFrame directly for visual parity —
// reticles, paper background, "kissing the header" border seal — and pass
// only the minimal props it needs. No PlainFrame.)

/**
 * Same-page debug overlay: a debug-gated floating FAB + panel that renders the
 * host page's own live Core.nodes graph in the shared GraphView and lets you
 * poke it (connect/remove/invoke) via the page's own CommandInterpreter.
 *
 * Reset Graph rebuilds the ENTIRE graph in place: it removes every node, then
 * bumps `Core.graphGeneration` so every graph-building effect (each dashboard's
 * mountExospine + this overlay's useDebugRepl) tears down and rebuilds its nodes
 * fresh. `Core.reinit` (the finer-grained build-nodes-only rebuild stashed by
 * mountExospine) only gates whether the chip is offered.
 *
 * @param {Object} props
 * @param {string} [props.search]     Injectable location.search (tests).
 * @param {string} [props.storageKey] Layout persistence key (per dashboard).
 * @return {import('react').ReactElement|null} The overlay, or null when debug is disabled.
 */
export default function DebugOverlay( {
	search,
	storageKey = 'newspack-nodes:debug',
} ) {
	const enabled = isDebugEnabled( search );
	const [ open, setOpen ] = useState( false );
	const [ selected, setSelected ] = useState( null );
	const [ replExpanded, setReplExpanded ] = useState( false );
	const replInputRef = useRef( null );
	const panelRef = useRef( null );
	// Theme + palette are shared with the topology console so a preference
	// picked in either surface applies in both. The overlay is always live
	// (no edit mode), so it uses the live palette key (default collapsed).
	const { theme, onThemeChange, paletteCollapsed, togglePaletteCollapsed } =
		usePanelChrome( { paletteKey: PALETTE_COLLAPSED_STORAGE_KEY_LIVE } );
	// One Shell instance per overlay mount, shared by useDebugGraph (handler
	// dispatch) and useDebugRepl (typed-line dispatch). cwd is empty: the
	// overlay is local-only. Sink resolution is deferred to useEffect because
	// sibling components (e.g. useWorkerStatusGraph) mount the exospine in
	// their own useEffect — Core.node(COMMAND_INTERPRETER) returns null in the
	// render phase, before any sibling's commit-phase effect has run. Reading
	// it in useMemo would freeze sink=null for the lifetime of the overlay.
	const shell = useMemo( () => {
		const s = new Shell();
		s.path = '';
		return s;
	}, [] );
	// Resolve the interpreter at every render and include it in the effect deps:
	// if the dashboard's mount effect ran AFTER the overlay's first render — or
	// the interpreter was unregistered + re-registered — the effect re-fires on
	// the next render and rebinds shell.sink so the REPL doesn't silently drop
	// wire commands (a stale-null shell.sink is what `s.sink?.fill(...)` masks).
	const interpreter = Core.node( names.COMMAND_INTERPRETER );
	// The host graph's rebuild handle, stashed on the per-page Core by
	// mountExospine. Read every render (like `interpreter` above) so it's
	// populated once the dashboard's mount effect has run.
	const reinit = Core.reinit;
	useEffect( () => {
		shell.sink = interpreter;
	}, [ shell, interpreter ] );
	const {
		transcript,
		sendLine,
		append,
		clear,
		cwd,
		setPath,
		ready: replReady,
	} = useDebugRepl( enabled && open, shell );
	// Layout storage scoped by cwd. useDebugGraph runs first (it needs only
	// `onPositionChange`, threaded via a ref to break the hoist cycle); then
	// useCanvasLayout consumes `graph`/`ready` from it and one-shot autoLayouts
	// the COMPLETE graph once ready.
	const cwdScope = cwd || 'local';
	const onPositionChangeRef = useRef( null );
	// Catalog must be resolved before useDebugGraph so the Inspector handler
	// can look up `is_interpreter` for non-local-scope nodes.
	const jsCatalog = useJsCatalog();
	const phpCatalog = useClassCatalog( {
		enabled: enabled && open && !! cwd,
	} );
	const catalog = cwd ? phpCatalog : jsCatalog;
	const {
		graph,
		ready: graphHasNodes,
		handlers,
		pendingDrop,
		commitDrop,
		cancelDrop,
	} = useDebugGraph(
		enabled && open,
		shell,
		catalog.classes || [],
		( id, p ) => onPositionChangeRef.current?.( id, p )
	);
	// Composite readiness: gate layout + the canvas render on BOTH the overlay's
	// own infra being mounted (replReady) AND the graph carrying nodes. replReady
	// is what keeps the partial-graph bug dead — coreToGraph() only returns the
	// COMPLETE local graph (infra included) once useDebugRepl has mounted it.
	const ready = replReady && graphHasNodes;
	const {
		positions,
		viewport,
		canReset: isLayoutDirty,
		onPositionChange,
		onViewportChange,
		resetLayout,
	} = useCanvasLayout( {
		storageKey: `${ storageKey }:${ cwdScope }`,
		graph,
		ready,
		serverLayout: null,
	} );
	// Thread the latest onPositionChange to useDebugGraph's drop recorder.
	onPositionChangeRef.current = onPositionChange;

	// Reachable path scopes — every top-level substrate-node-name in the
	// current Core registry that's a legitimate `cd` target (peel-and-route).
	// Filter out internal-only names AND bare `_sse` (its reply-pivot routing
	// is for `_sse/{worker.partition}` IPC paths; bare `cd /_sse` would POST
	// with TO='' to /command's request-scope, where replies don't make it
	// back through the log-tail SSE channel). Service-CI verbs (workers,
	// performance, etc.) go via `_http`. Worker pivots can be typed by hand.
	const NON_NAVIGABLE = useMemo(
		() =>
			new Set( [
				names.COMMAND_INTERPRETER,
				names.ROUTER,
				names.CWD,
				names.METADATA,
				names.UPTIME,
				names.COMPLETION,
				names.HEARTBEAT,
				names.OUTPUT,
				names.SSE,
			] ),
		[]
	);
	// Reachable LOCAL `cd` targets, read from the browser's own registry — NOT the
	// polled `graph`, which reflects the CURRENT cwd's (possibly remote) scope. A
	// `cd /_http` makes `graph` the remote nodes; sourcing the menu from there
	// drops the local `_http`/`_*` targets and collapses the menu. Recomputed each
	// render (the list is tiny) so a rebuild or new node shows up immediately.
	const pathOptions = [ '' ];
	for ( const id of Core.nodes.keys() ) {
		if ( id.startsWith( '_' ) && ! NON_NAVIGABLE.has( id ) ) {
			pathOptions.push( id );
		}
	}

	// Tab-completion: subscribe to _completion's published candidates and expose
	// requestCompletion/handleShowCandidates via the shared useCompletion hook.
	// The overlay is local-only (no SSE), so it leaves skip at the never-skip
	// default and fills the page's own CommandInterpreter.
	const completion = useNodeState( names.COMPLETION, 'candidates' ) ?? null;
	const { requestCompletion, handleShowCandidates } = useCompletion( {
		cwd,
		fill: ( m ) => Core.node( names.COMMAND_INTERPRETER )?.fill( m ),
		append,
	} );
	// Catalog is resolved above (just below useDebugRepl). schemasByShellName
	// drops the array form into a lookup map for the Inspector's class
	// metadata reads.
	const schemasByShellName = useMemo(
		() =>
			Object.fromEntries(
				( catalog.classes || [] ).map( ( c ) => [ c.shell_name, c ] )
			),
		[ catalog.classes ]
	);
	const {
		frame,
		style: frameStyle,
		onHeaderPointerDown,
		getResizeHandlers,
		toggleMaximize,
		// Global frame key — same overlay dimensions across every dashboard.
	} = useDebugFrame( 'newspack-nodes:debug:frame', enabled && open );

	// Shared graph-dirty + Reset Graph logic (identical to the topology console).
	// The Shell dispatch tap flips structureDirty on any graph-mutating command —
	// GUI gesture OR typed REPL line — so the chip catches them all. Local-scope
	// only (reinit rebuilds the LOCAL host graph, meaningless from a remote view);
	// canRebuild = reinit exists to restore the wiring.
	// A graph rewire no longer dirties the LAYOUT — pass a no-op for markDirty.
	const { resetGraph, canResetGraph } = useGraphReset( {
		shell,
		nodes: graph.nodes,
		isLocalScope: ! cwd,
		canRebuild: !! reinit,
		markDirty: () => {},
	} );

	// "Reset Layout" appears only when the user has modified the layout.
	// `isLayoutDirty` is the renamed `canReset` from useCanvasLayout — set by a
	// drag/drop/tuck, cleared by resetLayout (the one-shot init writes modified=false).
	const hasLayoutToReset = isLayoutDirty;

	// Ctrl+` toggles the panel while enabled.
	useEffect( () => {
		if ( ! enabled ) {
			return undefined;
		}
		const onKey = ( e ) => {
			if ( e.ctrlKey && e.key === '`' ) {
				e.preventDefault();
				setOpen( ( v ) => ! v );
			}
		};
		document.addEventListener( 'keydown', onKey );
		return () => document.removeEventListener( 'keydown', onKey );
	}, [ enabled ] );

	// Eat wheel scrolls inside the panel so they don't scroll the page behind the
	// overlay. An inner scrollable (transcript, canvas) that can still scroll in the
	// gesture's direction keeps it; everything else is consumed. preventDefault needs
	// a non-passive listener — React's onWheel can't guarantee that — so attach one
	// to the panel directly.
	useEffect( () => {
		const el = panelRef.current;
		if ( ! open || ! el ) {
			return undefined;
		}
		const consumedByInnerScroll = ( target, deltaY ) => {
			let node = target;
			while ( node && node !== el ) {
				if ( node.scrollHeight > node.clientHeight ) {
					const oy = window.getComputedStyle( node ).overflowY;
					if ( 'auto' === oy || 'scroll' === oy ) {
						const atTop = node.scrollTop <= 0;
						const atBottom =
							node.scrollTop + node.clientHeight >=
							node.scrollHeight - 1;
						if (
							( deltaY < 0 && ! atTop ) ||
							( deltaY > 0 && ! atBottom )
						) {
							return true;
						}
					}
				}
				node = node.parentNode;
			}
			return false;
		};
		const onWheel = ( e ) => {
			if ( ! consumedByInnerScroll( e.target, e.deltaY ) ) {
				e.preventDefault();
			}
		};
		el.addEventListener( 'wheel', onWheel, { passive: false } );
		return () => el.removeEventListener( 'wheel', onWheel );
	}, [ open ] );

	// Callback ref for the panel: tracks the node AND releases the page-scroll
	// lock the instant the panel detaches (close, unmount, or remount) — more
	// reliable than onPointerLeave (which never fires on unmount) or an
	// open-keyed effect cleanup (which misses a remount while still open).
	const setPanelRef = useCallback( ( node ) => {
		panelRef.current = node;
		if ( ! node ) {
			unlockPageScroll();
		}
	}, [] );

	if ( ! enabled ) {
		return null;
	}

	// Cap the transcript at panel-height minus the 64px header row minus the
	// 40px prompt bar (the ReplFooter is transcript + always-visible prompt
	// stacked; the `height` prop controls the transcript pane only). The
	// canvas can shrink to nothing — that's fine, drag the transcript back
	// down to recover it.
	const replMaxHeightPx = Math.max( 80, frame.h - 64 - 40 );
	// Shared canvas-background-click dismiss pattern (mirrors the console).
	const onCanvasBackgroundClick = makeReplDismissHandler( {
		replExpanded,
		setReplExpanded,
		inputRef: replInputRef,
	} );

	return (
		<div className="nodes-debug">
			{ ! open && (
				<button
					type="button"
					className="nodes-debug__fab"
					aria-label={ __(
						'Toggle node debugger',
						'newspack-nodes'
					) }
					onClick={ () => setOpen( ( v ) => ! v ) }
				>
					{ '◉' }
				</button>
			) }
			{ open && (
				<div
					ref={ setPanelRef }
					className="nodes-debug__panel"
					data-testid="debug-panel"
					style={ frameStyle }
					// Block the page behind the overlay from scrolling whenever the
					// pointer is inside the panel (Safari ignores the canvas wheel's
					// preventDefault, so pin the page physically instead).
					onPointerEnter={ lockPageScroll }
					onPointerLeave={ unlockPageScroll }
				>
					<div
						className={ `topology-app theme-${ theme }${
							selected ? ' is-inspector-open' : ''
						}${ paletteCollapsed ? ' is-palette-collapsed' : '' }` }
					>
						<ConsoleShell
							ready={ ready }
							graph={ graph }
							frame={ CanvasFrame }
							frameProps={ {
								topology: 'debug',
								partition: null,
								isWorker: false,
								editMode: false,
								// Hide the chips when there's nothing to reset:
								// passing null tells CanvasFrame to skip them.
								onResetLayout: hasLayoutToReset
									? resetLayout
									: null,
								onResetGraph: canResetGraph ? resetGraph : null,
							} }
							buildingClassName="nodes-debug__canvas-building"
							// display:contents wrapper so the inner <header> stays
							// a direct grid child (grid-area: header) while the
							// pointerdown handler still bubbles up.
							wrapHeader={ ( header ) => (
								<div
									className="nodes-debug__header-drag"
									onPointerDown={ onHeaderPointerDown }
									onDoubleClick={ ( e ) => {
										// Skip dbl-click maximize on a header
										// control (select, button) — those have
										// their own behavior.
										const tag = e.target?.tagName;
										if (
											tag === 'SELECT' ||
											tag === 'BUTTON' ||
											tag === 'INPUT' ||
											tag === 'OPTION' ||
											e.target?.closest?.(
												'select, button, input'
											)
										) {
											return;
										}
										toggleMaximize();
									} }
								>
									{ header }
								</div>
							) }
							headerProps={ {
								theme,
								onThemeChange,
								themes: THEMES,
								mode: 'view',
								pathOptions,
								path: cwd,
								onPathChange: setPath,
								onClose: () => setOpen( false ),
							} }
							canvasProps={ {
								resetKey: storageKey,
								interactive: true,
								editMode: false,
								showPalette: true,
								paletteLoading: catalog.loading,
								paletteCollapsed,
								onPaletteToggle: togglePaletteCollapsed,
								classCatalog: schemasByShellName,
								catalog: catalog.classes,
								formatters: catalog.formatters,
								positionOverrides: positions,
								onPositionChange,
								viewport,
								onViewportChange,
								onConnect: handlers.onConnect,
								onRemoveNode: handlers.onRemoveNode,
								onDropNode: handlers.onDropNode,
								onInspectorAction: (
									action,
									nodeId,
									payload
								) => {
									// Pop the transcript footer when the user fires an
									// inspector action — matches the console's UX (the
									// reply lands in _output and the user should see it).
									// Graph-mutating actions dirty via the Shell tap.
									setReplExpanded( true );
									handlers.onInspectorAction(
										action,
										nodeId,
										payload
									);
								},
								onSelectionChange: setSelected,
								onBackgroundClickConsumed:
									onCanvasBackgroundClick,
							} }
							replProps={ {
								prompt: `/${ cwd }`,
								canSend: true,
								onSubmit: sendLine,
								onClear: clear,
								transcript,
								completion,
								onComplete: requestCompletion,
								onShowCandidates: handleShowCandidates,
								expanded: replExpanded,
								onExpandedChange: setReplExpanded,
								inputRef: replInputRef,
								maxHeightPx: replMaxHeightPx,
							} }
						/>
					</div>
					{ Object.entries( getResizeHandlers() ).map(
						( [ key, h ] ) => (
							<div
								key={ key }
								className={ `nodes-debug__resize nodes-debug__resize--${ key }` }
								onPointerDown={ h.onPointerDown }
							/>
						)
					) }
				</div>
			) }
			{ pendingDrop && (
				// display:contents themed host so the sibling-rendered modal inherits .topology-app's --paper/--ink tokens (else the dialog is an invisible transparent box).
				<div
					className={ `topology-app theme-${ theme }` }
					style={ { display: 'contents' } }
				>
					<NewNodeModal
						shellName={ pendingDrop.shellName }
						defaultName={ pendingDrop.defaultName }
						argSchema={ pendingDrop.argSchema }
						onConfirm={ commitDrop }
						onCancel={ cancelDrop }
					/>
				</div>
			) }
		</div>
	);
}
