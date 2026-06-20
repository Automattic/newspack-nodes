import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';
import { Core } from '../../runtime/core';
import CanvasFrame from '../../topology-console/components/CanvasFrame';
import ConsoleShell from '../../topology-console/components/ConsoleShell';
import { NewNodeModal } from '../../topology-console/components/Modal';
import { useJsCatalog } from '../../topology-console/hooks/useJsCatalog';
import { useClassCatalog } from '../../topology-console/hooks/useClassCatalog';
import { ShellNode } from '../../runtime/shell-node';
import { useNodeState } from '../../runtime/react';
import { useCompletion } from '../../topology-console/hooks/useCompletion';
import { usePanelChrome } from '../../topology-console/hooks/usePanelChrome';
import names from '../../runtime/reserved-node-names.json';
import {
	THEMES,
	PALETTE_COLLAPSED_STORAGE_KEY_LIVE,
} from '../../topology-console/themes';
import { useDebugGraph } from '../useDebugGraph';
import { useCanvasLayout } from '../../topology-console/hooks/useCanvasLayout';
import { useDebugRepl } from '../useDebugRepl';
import { useGraphReset } from '../useGraphReset';

/**
 * Measure the DevtoolsTabHost tab bar (`.nodes-devtools__tabbar`) that the host
 * renders as the sibling BEFORE this tab's content wrapper. Measured (not a
 * hardcoded constant) so it can never drift from DevtoolsTabHost.scss, and
 * returns 0 when there's no bar (single-tab host) or before mount.
 *
 * @param {Element|null} rootEl The inspector body's root element.
 * @return {number} The tab bar's rendered offsetHeight in px, or 0.
 */
export function measureTabBarHeight( rootEl ) {
	const content = rootEl?.closest?.( '.nodes-devtools__tab-content' );
	const bar = content?.previousElementSibling;
	if ( ! bar?.classList?.contains( 'nodes-devtools__tabbar' ) ) {
		return 0;
	}
	return bar.offsetHeight;
}

/**
 * Max height (px) for the REPL transcript: the panel height minus the 64px
 * header row, the 38px always-visible prompt bar (`.topology-repl__bar` in
 * graph-view.scss; the transcript's `bottom: 38px` anchor sits at that bar's
 * top), and the measured tab bar the DevtoolsTabHost renders above this body.
 * The panel is content-box, so frame.h excludes its border — no extra reserve.
 * Floored at 80px so the transcript never collapses on a tiny panel.
 *
 * @param {number} frameHeight  Panel height (frame.h) in px.
 * @param {number} tabBarHeight Measured tab bar height in px (0 if no bar).
 * @return {number} Transcript max-height in px.
 */
export function replMaxHeight( frameHeight, tabBarHeight = 0 ) {
	return Math.max( 80, frameHeight - 64 - 38 - tabBarHeight );
}

/**
 * The Inspector tab — the overlay's live-graph + REPL body, extracted from
 * DebugPanel to run as a registered devtools tab. The host (DebugPanel) owns
 * the outer frame div, the resize handles, the page-scroll lock, and the wheel
 * eater; this component receives the frame geometry and header gestures as props
 * and renders only the inner content.
 *
 * Mounted ONLY while the panel is open, so its graph-building hooks
 * (useDebugRepl / useDebugGraph) construct the overlay's infra in useState lazy
 * initializers that run BEFORE this subtree's first render. The canvas therefore
 * only ever renders + auto-layouts over a complete graph, with shell.sink already
 * bound — no useEffect creates graph nodes here and there is no open-and-type
 * race to paper over at dispatch time.
 *
 * @param {Object}   props
 * @param {string}   props.storageKey          Layout persistence key (per dashboard).
 * @param {Function} props.onClose             Close the panel (host's setOpen(false)).
 * @param {Object}   props.frame               Frame geometry { w, h } from the host.
 * @param {Function} props.onHeaderPointerDown Header drag-start gesture from the host.
 * @param {Function} props.toggleMaximize      Maximize toggle from the host.
 * @return {import('react').ReactElement} The inspector body.
 */
export default function InspectorTab( {
	storageKey,
	onClose,
	frame,
	onHeaderPointerDown,
	toggleMaximize,
} ) {
	const [ replExpanded, setReplExpanded ] = useState( false );
	const replInputRef = useRef( null );
	// Measure the DevtoolsTabHost tab bar that sits above this body so the
	// transcript ceiling reserves exactly its rendered height (it may be absent
	// on a single-tab host). A ResizeObserver keeps it correct if the bar wraps.
	const rootRef = useRef( null );
	const [ tabBarHeight, setTabBarHeight ] = useState( 0 );
	const measureTabBar = useCallback( () => {
		setTabBarHeight( measureTabBarHeight( rootRef.current ) );
	}, [] );
	useEffect( () => {
		measureTabBar();
		const content = rootRef.current?.closest?.(
			'.nodes-devtools__tab-content'
		);
		const bar = content?.previousElementSibling;
		if (
			! bar ||
			typeof window === 'undefined' ||
			! window.ResizeObserver
		) {
			return undefined;
		}
		const ro = new window.ResizeObserver( measureTabBar );
		ro.observe( bar );
		return () => ro.disconnect();
	}, [ measureTabBar ] );
	// Theme + palette are shared with the topology console so a preference picked
	// in either surface applies in both. The overlay is always live (no edit
	// mode), so it uses the live palette key (default collapsed).
	const {
		theme,
		onThemeChange,
		paletteCollapsed,
		togglePaletteCollapsed,
		inspectorCollapsed,
		toggleInspectorCollapsed,
	} = usePanelChrome( { paletteKey: PALETTE_COLLAPSED_STORAGE_KEY_LIVE } );
	// One Shell instance per panel mount, shared by useDebugGraph (handler
	// dispatch) and useDebugRepl (typed-line dispatch). cwd is empty: the overlay
	// is local-only. useDebugRepl binds shell.sink to the page's interpreter
	// during its build-before-render — no separate bind effect, no race.
	const shell = useMemo( () => {
		const s = new ShellNode();
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
		markDirty,
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

	// Shared graph-dirty + Reset Graph logic (identical to the topology console).
	const { resetGraph, canResetGraph } = useGraphReset( {
		shell,
		nodes: graph.nodes,
		isLocalScope: ! cwd,
		canRebuild: !! reinit,
		markDirty,
	} );

	// "Reset Layout" appears only when the user has modified the layout.
	const hasLayoutToReset = isLayoutDirty;

	// Cap the transcript at panel-height minus the header row, prompt bar, and
	// the measured tab bar above this body (the ReplFooter is transcript +
	// always-visible prompt stacked).
	const replMaxHeightPx = replMaxHeight( frame.h, tabBarHeight );

	return (
		<div
			ref={ rootRef }
			className="nodes-debug__inspector"
			data-testid="inspector-tab"
		>
			<div
				className={ `topology-app theme-${ theme } is-inspector-open${
					inspectorCollapsed ? ' is-inspector-collapsed' : ''
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
						onResetLayout: hasLayoutToReset ? resetLayout : null,
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
						onRemoveEdge: handlers.onRemoveEdge,
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
						backgroundClickAutofitsOnly: true,
						inspectorCollapsed,
						onInspectorToggle: toggleInspectorCollapsed,
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
		</div>
	);
}
