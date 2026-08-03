import {
	createInterpolateElement,
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
import { applySkin } from '@newspack-nodes/shared/theme';
import { useDebugGraph } from '../useDebugGraph';
import { buildComposeTargets } from '../../topology-console/utils/composeTargets';
import { useCanvasLayout } from '../../topology-console/hooks/useCanvasLayout';
import { useDebugRepl } from '../useDebugRepl';
import { useGraphReset } from '../useGraphReset';
import { CatalogProvider } from '../../topology-console/CatalogContext';

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
	// -4 reserves the resize handle so full height doesn't clip it.
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
	// false on hub Console tab — its own graph+REPL would collide on `_output`.
	buildRepl = true,
} ) {
	// Measure the host tab bar so the transcript ceiling reserves its height.
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
	// Palette + skin shared with the topology console; overlay uses live key.
	const {
		paletteCollapsed,
		inspectorCollapsed,
		openInspectorOnSelect,
		canvasChromeProps,
		replChromeProps,
		setReplExpanded,
	} = useGraphSurface( { paletteKey: PALETTE_COLLAPSED_STORAGE_KEY_LIVE } );
	// One Shell per mount; cwd empty (local-only), sink bound before render.
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
	// useDebugGraph runs first (via ref); useCanvasLayout then autolays out.
	const cwdScope = cwd || 'local';
	const onPositionChangeRef = useRef( null );
	// Resolve catalog before useDebugGraph so handler looks up is_interpreter.
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

	// Reachable `cd` targets: top-level substrate names, minus internal-only.
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
	// LOCAL cd targets from the browser registry, not the (maybe remote) graph.
	const pathOptions = [ '' ];
	for ( const id of Core.nodes.keys() ) {
		if ( id.startsWith( '_' ) && ! NON_NAVIGABLE.has( id ) ) {
			pathOptions.push( id );
		}
	}

	// Publish cwd PATH selector to shared Header; ref-wrap setPath (churn).
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

	// Tab-completion: subscribe to _completion candidates via useCompletion.
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

	// Cap the transcript at panel height minus header, prompt bar, and tab bar.
	const replMaxHeightPx = replMaxHeight( frame.h, tabBarHeight );

	// Hub Console tab: no infra (active=false) — point at Console + Overview.
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
		<CatalogProvider
			classCatalog={ schemasByShellName }
			classes={ catalog.classes }
			formatters={ catalog.formatters }
			vaults={ vaultCatalog.vaults }
			composeTargets={ composeTargets }
		>
			<div
				ref={ rootRef }
				className="nodes-debug__inspector"
				data-testid="inspector-tab"
			>
				<div
					className={ `topology-app is-inspector-open${
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
							// null tells CanvasFrame to skip the reset chips.
							onResetLayout: hasLayoutToReset
								? resetLayout
								: null,
							onResetGraph: canResetGraph ? resetGraph : null,
						} }
						buildingClassName="nodes-debug__canvas-building"
						canvasProps={ {
							...canvasChromeProps,
							resetKey: storageKey,
							// No cwd → local; header uses IoTelemetry.
							local: ! cwd,
							// Dumper verbosity; Verbose toggle reads it.
							debugLevel,
							interactive: true,
							editMode: false,
							showPalette: true,
							paletteLoading: catalog.loading,
							positionOverrides: positions,
							onPositionChange,
							viewport,
							viewportDelta,
							onViewportChange,
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
								// Pop transcript footer on an inspector action.
								setReplExpanded( true );
								// Raw REPL line via Shell (special + builtins).
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
	);
}
