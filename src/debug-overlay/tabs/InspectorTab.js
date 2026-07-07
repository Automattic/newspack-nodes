import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { Core } from '../../runtime/core';
import CanvasFrame from '../../topology-console/components/CanvasFrame';
import ConsoleShell from '../../topology-console/components/ConsoleShell';
import { NewNodeModal } from '../../topology-console/components/Modal';
import { useJsCatalog } from '../../topology-console/hooks/useJsCatalog';
import { useClassCatalog } from '../../topology-console/hooks/useClassCatalog';
import { useVaults } from '../../topology-console/hooks/useVaults';
import { ShellNode } from '../../runtime/shell-node';
import { useNodeState } from '../../runtime/react';
import { useCompletion } from '../../topology-console/hooks/useCompletion';
import { useGraphSurface } from '../../topology-console/hooks/useGraphSurface';
import names from '../../runtime/reserved-node-names.json';
import { PALETTE_COLLAPSED_STORAGE_KEY_LIVE } from '../../topology-console/themes';
import { useDebugGraph } from '../useDebugGraph';
import { buildComposeTargets } from '../../topology-console/utils/composeTargets';
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
	// -4 reserves the resize handle so it isn't clipped at full height. Unlike the
	// console (which measures its frame exactly and needs 0 — see
	// replCeilingFromAppHeight), this path HARDCODES the header (64) and bar (38)
	// instead of measuring them, and those are ~4px off the panel's real chrome;
	// the 4 absorbs that slop so the transcript top lands at the same spot (handle
	// edge ~1px below the tab bar, hit area extending down).
	return Math.max( 80, frameHeight - 64 - 38 - tabBarHeight - 4 );
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
 * The panel owns the one shared header (above the tab bar), so this body is
 * header-less: it renders ConsoleShell with `showHeader={ false }` and publishes
 * its cwd PATH selector up to the panel via `publishHeader`.
 *
 * @param {Object}   props
 * @param {string}   props.storageKey    Layout persistence key (per dashboard).
 * @param {Object}   props.frame         Frame geometry { w, h } from the host.
 * @param {Function} props.publishHeader Publish header extras (the PATH selector) to the panel's shared Header.
 * @param {boolean}  [props.buildRepl]   When false (Console tab), build no infra — Overview-only.
 * @return {import('react').ReactElement} The inspector body.
 */
export default function InspectorTab( {
	storageKey,
	frame,
	publishHeader,
	// false on the hub Console tab: the overlay rides it ONLY for the Overview tab
	// (browser I/O). Its own graph+REPL would duplicate the Console's AND collide
	// on the shared `_output` infra, so the inspector body builds nothing there
	// (active=false) and points at the Console's own REPL instead.
	buildRepl = true,
} ) {
	// replExpanded / setReplExpanded / replInputRef come from useGraphSurface.
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
		inspectorCollapsed,
		openInspectorOnSelect,
		canvasChromeProps,
		replChromeProps,
		setReplExpanded,
	} = useGraphSurface( { paletteKey: PALETTE_COLLAPSED_STORAGE_KEY_LIVE } );
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
	} = useDebugRepl( buildRepl, shell, onThemeChange );
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
	const vaultCatalog = useVaults( { enabled: !! cwd } );
	const {
		graph,
		ready: graphHasNodes,
		handlers,
		pendingDrop,
		commitDrop,
		cancelDrop,
	} = useDebugGraph( buildRepl, shell, catalog.classes || [], ( id, p ) =>
		onPositionChangeRef.current?.( id, p )
	);
	// Composite readiness: gate layout + the canvas render on BOTH the overlay's
	// own infra being mounted (replReady) AND the graph carrying nodes.
	const ready = replReady && graphHasNodes;
	const {
		positions,
		viewport,
		viewportDelta,
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

	// Compose modal's "To" list: derived from the VIEWED graph (`graph.nodes`),
	// never Core.nodes — at a remote worker cwd the browser's own Core holds
	// only its scaffolding, not the worker's graph.
	const composeTargets = useMemo(
		() => buildComposeTargets( graph.nodes ),
		[ graph.nodes ]
	);

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
				names.CONSOLE_TAP,
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

	// Publish the cwd PATH selector up to the panel's one shared Header (the
	// Console owns it; the Overview publishes nothing). Re-publish when the option
	// set or cwd changes; clear on unmount so switching to the Overview drops it.
	// onPathChange is a ref-stable wrapper so a churning `setPath` identity can't
	// re-fire this setState effect into an infinite render loop.
	const setPathRef = useRef( setPath );
	setPathRef.current = setPath;
	const stableOnPathChange = useCallback(
		( p ) => setPathRef.current( p ),
		[]
	);
	const pathOptionsKey = pathOptions.join( '\n' );
	useEffect( () => {
		publishHeader?.( {
			mode: 'view',
			pathOptions,
			path: cwd,
			onPathChange: stableOnPathChange,
		} );
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ publishHeader, pathOptionsKey, cwd, stableOnPathChange ] );
	useEffect( () => () => publishHeader?.( null ), [ publishHeader ] );

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

	// On the hub Console tab the overlay rides along ONLY for its Overview tab;
	// the graph + REPL are the Console's own job (and would collide on `_output`).
	// Every hook above ran with active=false, so no infra was built — point the
	// user at the Console + the Overview tab instead of a second, empty canvas.
	if ( ! buildRepl ) {
		return (
			<div
				ref={ rootRef }
				className="nodes-debug__inspector nodes-debug__inspector--repl-off"
				data-testid="inspector-tab"
			>
				<p className="nodes-debug__repl-off">
					{ __(
						"The graph and REPL live in the Console tab itself here. Switch to the Overview tab to watch this browser's own I/O.",
						'newspack-nodes'
					) }
				</p>
			</div>
		);
	}

	return (
		<div
			ref={ rootRef }
			className="nodes-debug__inspector"
			data-testid="inspector-tab"
		>
			<div
				className={ `topology-app newspack-nodes-theme theme-${ theme } is-inspector-open${
					inspectorCollapsed ? ' is-inspector-collapsed' : ''
				}${ paletteCollapsed ? ' is-palette-collapsed' : '' }` }
			>
				<ConsoleShell
					ready={ ready }
					graph={ graph }
					// The panel owns the one shared header above the tabs.
					showHeader={ false }
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
					canvasProps={ {
						...canvasChromeProps,
						resetKey: storageKey,
						// No cwd = the page's own (local) graph → the no-node
						// header reads this overlay's IoTelemetry (same source as
						// the Overview tab); a pivoted cwd stays on dump_metadata.
						local: ! cwd,
						interactive: true,
						editMode: false,
						showPalette: true,
						paletteLoading: catalog.loading,
						classCatalog: schemasByShellName,
						catalog: catalog.classes,
						formatters: catalog.formatters,
						vaults: vaultCatalog.vaults,
						positionOverrides: positions,
						onPositionChange,
						viewport,
						viewportDelta,
						onViewportChange,
						onConnect: handlers.onConnect,
						onRemoveEdge: handlers.onRemoveEdge,
						onRemoveNode: handlers.onRemoveNode,
						onDropNode: handlers.onDropNode,
						composeTargets,
						onInspectorAction: (
							action,
							nodeId,
							payload,
							flags
						) => {
							// Pop the transcript footer when the user fires an
							// inspector action — matches the console's UX (the
							// reply lands in _output and the user should see it).
							setReplExpanded( true );
							// No-node command buttons carry a raw REPL line; dispatch
							// it through the Shell's typed-line path so shell-special
							// (ping → TM_PING) AND local builtins (debug_level, …) work,
							// not just interpreter verbs. Structured GUI verbs
							// (dump/tail/trace/tell/…) stay on the handler.
							if ( 'command' === action ) {
								sendLine( payload );
								return;
							}
							handlers.onInspectorAction(
								action,
								nodeId,
								payload,
								flags
							);
						},
						// Selecting a node auto-opens the inspector (rail → panel).
						onSelectionChange: openInspectorOnSelect,
					} }
					replProps={ {
						...replChromeProps,
						prompt: `/${ cwd }`,
						canSend: true,
						onSubmit: sendLine,
						onClear: clear,
						transcript,
						completion,
						onComplete: requestCompletion,
						onShowCandidates: handleShowCandidates,
						maxHeightPx: replMaxHeightPx,
					} }
				/>
			</div>
			{ pendingDrop && (
				// display:contents themed host so the sibling-rendered modal
				// inherits .topology-app's --paper/--ink tokens.
				<div
					className={ `topology-app newspack-nodes-theme theme-${ theme }` }
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
