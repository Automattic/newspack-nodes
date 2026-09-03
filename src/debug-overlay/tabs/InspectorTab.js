/**
 * The debug overlay's Console tab: the host page's own live node graph on the
 * shared canvas, beside a REPL that fills that page's own CommandInterpreter,
 * so any dashboard can be read and rewired without leaving it. `tabs/index.js`
 * registers it under the `console` id and DebugPanel hosts it.
 *
 * The two exported geometry helpers are what hold the transcript inside the
 * panel. They take a number and an element rather than reading either from the
 * component, so the arithmetic can be asserted without mounting the tab.
 */

import {
	createInterpolateElement,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { useContainerRefit } from '../../shared/hooks/useContainerRefit';
import {
	subscribeDevtoolsTabs,
	getDevtoolsTabsVersion,
} from '../../shared/devtools/tabRegistry';
import { Core } from '../../runtime/core';
import CanvasFrame from '../../topology-console/components/CanvasFrame';
import ConsoleShell from '../../topology-console/components/ConsoleShell';
import { NewNodeModal } from '../../topology-console/components/Modal';
import { useJsCatalog } from '../../topology-console/hooks/useJsCatalog';
import { useClassCatalog } from '../../topology-console/hooks/useCatalogs';
import { ShellNode } from '../../runtime/shell-node';
import { useNodeState } from '../../runtime/react';
import { useCompletion } from '../../topology-console/hooks/useCompletion';
import { useGraphSurface } from '../../topology-console/hooks/useGraphSurface';
import names from '../../runtime/reserved-node-names.json';
import { PALETTE_COLLAPSED_STORAGE_KEY_LIVE } from '../../topology-console/themes';
import { applySkin } from '@newspack-nodes/shared/theme';
import { useDebugGraph } from '../useDebugGraph';
import { buildComposeTargets } from '../../topology-console/utils/composeTargets';
import { useCanvasLayout } from '../../topology-console/hooks/useCanvasLayout';
import { useDebugRepl } from '../useDebugRepl';
import { useGraphReset } from '../useGraphReset';
import { CatalogProvider } from '../../topology-console/CatalogContext';
import { LayoutProvider } from '../../topology-console/LayoutContext';
import { ChromeProvider } from '../../topology-console/ChromeContext';

/**
 * Measure the DevtoolsTabHost tab bar (`.nodes-devtools__tabbar`) that the host
 * renders as the sibling BEFORE this tab's content wrapper. Measured (not a
 * hardcoded constant) so it can never drift from DevtoolsTabHost.scss, and
 * returns 0 when there's no bar (single-tab host) or before mount.
 *
 * @param {Element|null} rootEl The inspector body's root element.
 * @return {number} The tab bar's rendered offsetHeight in px, or 0.
 * @testonly Exported for its own unit tests; InspectorTab is the caller.
 */
export function measureTabBarHeight( rootEl ) {
	const content = rootEl?.closest?.( '.nodes-devtools__tab-content' );
	const bar = /** @type {HTMLElement|null|undefined} */ (
		content?.previousElementSibling
	);
	if ( ! bar?.classList?.contains( 'nodes-devtools__tabbar' ) ) {
		return 0;
	}
	return bar.offsetHeight;
}

/**
 * Max height (px) for the REPL transcript: the panel height minus the panel's
 * own 64px header row (`.topology-header` in debug-overlay.scss), the 38px
 * always-visible prompt bar (`.topology-repl__bar` in graph-view.scss; the
 * transcript's `bottom: 38px` anchor sits at that bar's top), and the measured
 * tab bar DevtoolsTabHost renders above this body. The panel is content-box,
 * so frame.h excludes its border and needs no further reserve. Floored at 80px
 * so the transcript never collapses on a tiny panel.
 *
 * @param {number} frameHeight  Panel height (frame.h) in px.
 * @param {number} tabBarHeight Measured tab bar height in px (0 if no bar).
 * @return {number} Transcript max-height in px.
 * @testonly Exported for its own unit tests; InspectorTab is the caller.
 */
export function replMaxHeight( frameHeight, tabBarHeight = 0 ) {
	// -4 reserves the resize handle so full height doesn't clip it.
	return Math.max( 80, frameHeight - 64 - 38 - tabBarHeight - 4 );
}

/**
 * The tab body. DebugPanel owns the floating-window concerns — the frame div,
 * the resize handles, the page-scroll lock and the wheel eater — so this
 * component takes the frame geometry and the header gestures as props and
 * renders only the inner content: one ConsoleShell inside the three context
 * providers the canvas reads its chrome, layout and catalogs from.
 *
 * The panel mounts it ONLY while open, which is what lets its graph-building
 * hooks (useDebugRepl, useDebugGraph) build the overlay's infra in useState
 * lazy initializers running BEFORE this subtree's first render. The canvas
 * therefore only ever renders and auto-layouts over a complete graph with
 * `shell.sink` already bound. No effect here creates a graph node, so a line
 * typed the instant the panel opens cannot outrun the sink it dispatches into.
 *
 * The panel also owns the one shared header above the tab bar, so this body is
 * header-less: it renders ConsoleShell with `showHeader={ false }` and pushes
 * its cwd PATH selector up through `publishHeader`.
 *
 * @param {Object}                 props
 * @param {string}                 props.storageKey    Canvas-layout persistence key (per dashboard); the live cwd is appended, so each scope keeps its own node positions.
 * @param {{w: number, h: number}} props.frame         Panel geometry from the host. Only the height is read, to cap the transcript.
 * @param {Function}               props.publishHeader Publish this tab's header extras (the PATH selector) into the panel's shared Header; called with null on unmount to retract them.
 * @param {boolean}                [props.buildRepl]   False while the hub's own Console tab is showing, where a second graph and REPL would collide on `_output`; this body then builds neither and points back at that tab.
 * @return {import('react').ReactElement} The Console tab body.
 */
export default function InspectorTab( {
	storageKey,
	frame,
	publishHeader,
	buildRepl = true,
} ) {
	// Measure the host tab bar so the transcript ceiling reserves its height.
	const rootRef = useRef( null );
	const [ tabBarHeight, setTabBarHeight ] = useState( 0 );
	const measureTabBar = useCallback( () => {
		setTabBarHeight( measureTabBarHeight( rootRef.current ) );
	}, [] );
	// Tabs register lazily, so a late one must re-resolve the bar.
	const tabsVersion = useSyncExternalStore(
		subscribeDevtoolsTabs,
		getDevtoolsTabsVersion,
		getDevtoolsTabsVersion
	);
	useEffect( measureTabBar, [ measureTabBar, tabsVersion ] );
	useContainerRefit(
		// The tab bar is the content pane's previous sibling, not a ref.
		() =>
			rootRef.current?.closest?.( '.nodes-devtools__tab-content' )
				?.previousElementSibling,
		measureTabBar,
		[ measureTabBar, tabsVersion ],
		0
	);
	// Chrome shared with the console; the overlay is live-only (LIVE key).
	const {
		paletteCollapsed,
		togglePaletteCollapsed,
		inspectorCollapsed,
		toggleInspectorCollapsed,
		transcriptOverlayPx,
		openInspectorOnSelect,
		replChromeProps,
		setReplExpanded,
	} = useGraphSurface( { paletteKey: PALETTE_COLLAPSED_STORAGE_KEY_LIVE } );
	// One Shell per mount; path starts local, useDebugRepl binds its sink.
	const shell = useMemo( () => {
		const s = new ShellNode();
		s.path = '';
		return s;
	}, [] );
	// Host Reset-Graph capability flag from mountExospine; read each render.
	const canReinit = !! Core.rebuildable;
	const {
		transcript,
		sendLine,
		append,
		clear,
		cwd,
		setPath,
		ready: replReady,
		debugLevel,
	} = useDebugRepl( buildRepl, shell, applySkin );
	// Layout and rate history are per-cwd: a remote cwd is another graph.
	const cwdScope = cwd || 'local';
	const onPositionChangeRef = useRef( null );
	// Catalog before useDebugGraph: its handlers read is_interpreter.
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
	} = useDebugGraph(
		buildRepl,
		shell,
		catalog.classes || [],
		( id, p ) => onPositionChangeRef.current?.( id, p ),
		sendLine
	);
	// Gate layout + render on both infra mounted AND the graph carrying nodes.
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

	// Compose "To" from the VIEWED graph, not Core.nodes (remote cwd differs).
	const composeTargets = useMemo(
		() => buildComposeTargets( graph.nodes ),
		[ graph.nodes ]
	);

	// @longform LOCAL cd targets, from the browser registry rather than the
	// (maybe remote) graph. `_http` is the only one worth offering: a cwd is
	// useful when commands prefixed with it reach something, and every other
	// reserved `_` node is a sink or plumbing. Naming what IS navigable keeps
	// a node added later off the menu until someone decides it belongs.
	const pathOptions = Core.nodes.has( names.HTTP )
		? [ '', names.HTTP ]
		: [ '' ];

	// setPath changes on every cd; the ref keeps onPathChange stable.
	const setPathRef = useRef( setPath );
	setPathRef.current = setPath;
	const stableOnPathChange = useCallback(
		( p ) => setPathRef.current( p ),
		[]
	);
	// pathOptions is rebuilt each render; compare by value, not identity.
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

	// Tab-completion: _completion publishes candidates; useCompletion asks.
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

	// Shared graph-dirty + Reset Graph logic (same as the topology console).
	const { resetGraph, canResetGraph } = useGraphReset( {
		shell,
		nodes: graph.nodes,
		isLocalScope: ! cwd,
		canRebuild: canReinit,
		markDirty,
	} );

	// "Reset Layout" appears only when the user has modified the layout.
	const hasLayoutToReset = isLayoutDirty;

	const replMaxHeightPx = replMaxHeight( frame.h, tabBarHeight );

	// Hub Console tab: buildRepl=false made the hooks above inert.
	if ( ! buildRepl ) {
		return (
			<div
				ref={ rootRef }
				className="nodes-debug__inspector nodes-debug__inspector--repl-off"
				data-testid="inspector-tab"
			>
				<p className="nodes-debug__repl-off">
					{ createInterpolateElement(
						__(
							"The graph and REPL live in this page's own Console tab. Switch to Overview to watch this browser's <nb>I/O</nb>.",
							'newspack-nodes'
						),
						{ nb: <span className="nodes-debug__nowrap" /> }
					) }
				</p>
			</div>
		);
	}

	return (
		<ChromeProvider
			paletteCollapsed={ paletteCollapsed }
			onPaletteToggle={ togglePaletteCollapsed }
			bottomObstructionPx={ transcriptOverlayPx }
		>
			<LayoutProvider
				positionOverrides={ positions }
				onPositionChange={ onPositionChange }
				viewport={ viewport }
				onViewportChange={ onViewportChange }
			>
				<CatalogProvider
					classCatalog={ schemasByShellName }
					classes={ catalog.classes }
					formatters={ catalog.formatters }
					composeTargets={ composeTargets }
				>
					<div
						ref={ rootRef }
						className="nodes-debug__inspector"
						data-testid="inspector-tab"
					>
						<div
							className={ `topology-app is-inspector-open${
								inspectorCollapsed
									? ' is-inspector-collapsed'
									: ''
							}${
								paletteCollapsed ? ' is-palette-collapsed' : ''
							}` }
						>
							<ConsoleShell
								ready={ ready }
								graph={ graph }
								// The panel owns the header.
								showHeader={ false }
								frame={ CanvasFrame }
								frameProps={ {
									// No .tsl backs the browser's graph.
									topology: 'debug',
									partition: null,
									isWorker: false,
									editMode: false,
									// null skips the reset chips.
									onResetLayout: hasLayoutToReset
										? resetLayout
										: null,
									onResetGraph: canResetGraph
										? resetGraph
										: null,
								} }
								buildingClassName="nodes-debug__canvas-building"
								canvasProps={ {
									inspectorCollapsed,
									onInspectorToggle: toggleInspectorCollapsed,
									// A PATH change is a different graph.
									resetKey: `${ storageKey }|${ cwdScope }`,
									// Local: no-node header reads IoTelemetry.
									local: ! cwd,
									// Verbose toggle reads it.
									debugLevel,
									interactive: true,
									editMode: false,
									showPalette: true,
									paletteLoading: catalog.loading,
									viewportDelta,
									onConnect: handlers.onConnect,
									onRemoveEdge: handlers.onRemoveEdge,
									onRemoveNode: handlers.onRemoveNode,
									onDropNode: handlers.onDropNode,
									onInspectorAction: (
										action,
										nodeId,
										payload,
										flags
									) => {
										// Pop the transcript footer.
										setReplExpanded( true );
										// A whole REPL line; send it as typed.
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
									// Selecting auto-opens the inspector.
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
							<div style={ { display: 'contents' } }>
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
				</CatalogProvider>
			</LayoutProvider>
		</ChromeProvider>
	);
}
