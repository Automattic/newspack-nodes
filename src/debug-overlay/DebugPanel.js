import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';
import { Core } from '../runtime/core';
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
import { useDebugFrame } from './useDebugFrame';
import { useDebugGraph } from './useDebugGraph';
import { useCanvasLayout } from '../topology-console/hooks/useCanvasLayout';
import { useDebugRepl } from './useDebugRepl';
import { useGraphReset } from './useGraphReset';

/**
 * The overlay's panel — mounted by DebugOverlay ONLY while open, so its
 * graph-building hooks (useDebugRepl / useDebugGraph) construct the overlay's
 * infra in a useState lazy-initializer that runs BEFORE this subtree's first
 * render. The canvas therefore only ever renders + auto-layouts over a complete
 * graph, with shell.sink already bound — no useEffect creates graph nodes here
 * and there is no open-and-type race to paper over at dispatch time. Closing the
 * panel unmounts this component, tearing the infra down via the hooks' cleanup.
 *
 * @param {Object}   props
 * @param {string}   props.storageKey Layout persistence key (per dashboard).
 * @param {Function} props.onClose    Close the panel (parent's setOpen(false)).
 * @return {import('react').ReactElement} The panel.
 */
export default function DebugPanel( { storageKey, onClose } ) {
	const [ selected, setSelected ] = useState( null );
	const [ replExpanded, setReplExpanded ] = useState( false );
	const replInputRef = useRef( null );
	const panelRef = useRef( null );
	// Theme + palette are shared with the topology console so a preference picked
	// in either surface applies in both. The overlay is always live (no edit
	// mode), so it uses the live palette key (default collapsed).
	const { theme, onThemeChange, paletteCollapsed, togglePaletteCollapsed } =
		usePanelChrome( { paletteKey: PALETTE_COLLAPSED_STORAGE_KEY_LIVE } );
	// One Shell instance per panel mount, shared by useDebugGraph (handler
	// dispatch) and useDebugRepl (typed-line dispatch). cwd is empty: the overlay
	// is local-only. useDebugRepl binds shell.sink to the page's interpreter
	// during its build-before-render — no separate bind effect, no race.
	const shell = useMemo( () => {
		const s = new Shell();
		s.path = '';
		return s;
	}, [] );
	// The host graph's rebuild handle, stashed on the per-page Core by
	// mountExospine. Read every render so it's populated once the dashboard's
	// mount effect has run.
	const reinit = Core.reinit;
	const {
		transcript,
		sendLine,
		append,
		clear,
		cwd,
		setPath,
		ready: replReady,
	} = useDebugRepl( true, shell );
	// Layout storage scoped by cwd. useDebugGraph runs first (it needs only
	// `onPositionChange`, threaded via a ref to break the hoist cycle); then
	// useCanvasLayout consumes `graph`/`ready` from it and one-shot autoLayouts
	// the COMPLETE graph once ready.
	const cwdScope = cwd || 'local';
	const onPositionChangeRef = useRef( null );
	// Catalog must be resolved before useDebugGraph so the Inspector handler can
	// look up `is_interpreter` for non-local-scope nodes.
	const jsCatalog = useJsCatalog();
	const phpCatalog = useClassCatalog( { enabled: !! cwd } );
	const catalog = cwd ? phpCatalog : jsCatalog;
	const {
		graph,
		ready: graphHasNodes,
		handlers,
		pendingDrop,
		commitDrop,
		cancelDrop,
	} = useDebugGraph( true, shell, catalog.classes || [], ( id, p ) =>
		onPositionChangeRef.current?.( id, p )
	);
	// Composite readiness: gate layout + the canvas render on BOTH the overlay's
	// own infra being mounted (replReady) AND the graph carrying nodes.
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

	// Reachable path scopes — every top-level substrate-node-name in the current
	// Core registry that's a legitimate `cd` target (peel-and-route). Filter out
	// internal-only names AND bare `_sse`.
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
	// Reachable LOCAL `cd` targets, read from the browser's own registry — NOT
	// the polled `graph`, which reflects the CURRENT cwd's (possibly remote) scope.
	const pathOptions = [ '' ];
	for ( const id of Core.nodes.keys() ) {
		if ( id.startsWith( '_' ) && ! NON_NAVIGABLE.has( id ) ) {
			pathOptions.push( id );
		}
	}

	// Tab-completion: subscribe to _completion's published candidates and expose
	// requestCompletion/handleShowCandidates via the shared useCompletion hook.
	const completion = useNodeState( names.COMPLETION, 'candidates' ) ?? null;
	const { requestCompletion, handleShowCandidates } = useCompletion( {
		cwd,
		fill: ( m ) => Core.node( names.COMMAND_INTERPRETER )?.fill( m ),
		append,
	} );
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
	} = useDebugFrame( 'newspack-nodes:debug:frame', true );

	// Shared graph-dirty + Reset Graph logic (identical to the topology console).
	const { resetGraph, canResetGraph } = useGraphReset( {
		shell,
		nodes: graph.nodes,
		isLocalScope: ! cwd,
		canRebuild: !! reinit,
		markDirty: () => {},
	} );

	// "Reset Layout" appears only when the user has modified the layout.
	const hasLayoutToReset = isLayoutDirty;

	// Eat wheel scrolls inside the panel so they don't scroll the page behind the
	// overlay. preventDefault needs a non-passive listener — attach one directly.
	useEffect( () => {
		const el = panelRef.current;
		if ( ! el ) {
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
	}, [] );

	// Callback ref for the panel: tracks the node AND releases the page-scroll
	// lock the instant the panel detaches (close, unmount, or remount).
	const setPanelRef = useCallback( ( node ) => {
		panelRef.current = node;
		if ( ! node ) {
			unlockPageScroll();
		}
	}, [] );

	// Cap the transcript at panel-height minus the 64px header row minus the 40px
	// prompt bar (the ReplFooter is transcript + always-visible prompt stacked).
	const replMaxHeightPx = Math.max( 80, frame.h - 64 - 40 );
	// Shared canvas-background-click dismiss pattern (mirrors the console).
	const onCanvasBackgroundClick = makeReplDismissHandler( {
		replExpanded,
		setReplExpanded,
		inputRef: replInputRef,
	} );

	return (
		<>
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
						// display:contents wrapper so the inner <header> stays a
						// direct grid child (grid-area: header) while the
						// pointerdown handler still bubbles up.
						wrapHeader={ ( header ) => (
							<div
								className="nodes-debug__header-drag"
								onPointerDown={ onHeaderPointerDown }
								onDoubleClick={ ( e ) => {
									// Skip dbl-click maximize on a header control
									// (select, button) — those have their own behavior.
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
							onClose,
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
							onInspectorAction: ( action, nodeId, payload ) => {
								// Pop the transcript footer when the user fires an
								// inspector action — matches the console's UX (the
								// reply lands in _output and the user should see it).
								setReplExpanded( true );
								handlers.onInspectorAction(
									action,
									nodeId,
									payload
								);
							},
							onSelectionChange: setSelected,
							onBackgroundClickConsumed: onCanvasBackgroundClick,
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
				{ Object.entries( getResizeHandlers() ).map( ( [ key, h ] ) => (
					<div
						key={ key }
						className={ `nodes-debug__resize nodes-debug__resize--${ key }` }
						onPointerDown={ h.onPointerDown }
					/>
				) ) }
			</div>
			{ pendingDrop && (
				// display:contents themed host so the sibling-rendered modal
				// inherits .topology-app's --paper/--ink tokens.
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
		</>
	);
}
