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
import GraphView from '../topology-console/components/GraphView';
import { NewNodeModal } from '../topology-console/components/Modal';
import { makeReplDismissHandler } from '../topology-console/utils/replDismissHandler';
import Header from '../topology-console/components/Header';
import ReplFooter from '../topology-console/components/ReplFooter';
import { useJsCatalog } from '../topology-console/hooks/useJsCatalog';
import { useClassCatalog } from '../topology-console/hooks/useClassCatalog';
import { Shell } from '../topology-console/nodes/shell';
import { useNodeState } from '../runtime/react';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	KEY,
	VALUE,
	LOCAL,
	TM_COMMAND,
} from '../runtime/message';
import names from '../runtime/reserved-node-names.json';
import {
	THEMES,
	DEFAULT_THEME,
	isValidTheme,
	THEME_STORAGE_KEY,
	PALETTE_COLLAPSED_STORAGE_KEY_LIVE,
} from '../topology-console/themes';
import { isDebugEnabled } from './isDebugEnabled';
import { useDebugFrame } from './useDebugFrame';
import { useDebugGraph } from './useDebugGraph';
import { useDebugLayout } from './useDebugLayout';
import { useDebugRepl } from './useDebugRepl';
import './debug-overlay.scss';

// (We reuse the topology console's CanvasFrame directly for visual parity —
// reticles, paper background, "kissing the header" border seal — and pass
// only the minimal props it needs. No PlainFrame.)

// Read the persisted theme; unknown/disabled storage falls back to default.
function readStoredTheme( key ) {
	try {
		const slug = window.localStorage.getItem( key );
		return isValidTheme( slug ) ? slug : DEFAULT_THEME;
	} catch ( _err ) {
		return DEFAULT_THEME;
	}
}

/**
 * Same-page debug overlay: a debug-gated floating FAB + panel that renders the
 * host page's own live Core.nodes graph in the shared GraphView and lets you
 * poke it (connect/remove/invoke) via the page's own CommandInterpreter.
 *
 * Reset Graph uses `Core.reinit` — the host graph's rebuild handle stashed on the
 * per-page Core by mountExospine — to restore the dashboard's default wiring.
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
	// Set when the user rewires a connection in the canvas. Reset Graph can then
	// restore the host's default wiring (via reinit) even with no user nodes.
	const [ graphDirty, setGraphDirty ] = useState( false );
	const replInputRef = useRef( null );
	// Theme + palette keys are global — shared with the topology console
	// so a preference picked in either surface applies in both. Palette
	// defaults to collapsed; storage='0' means the user explicitly opened it.
	const [ theme, setTheme ] = useState( () =>
		readStoredTheme( THEME_STORAGE_KEY )
	);
	// The overlay is always a live view (no edit mode), so it uses the
	// live key. Defaults to collapsed; '0' = user opened it.
	const [ paletteCollapsed, setPaletteCollapsed ] = useState( () => {
		try {
			return (
				window.localStorage.getItem(
					PALETTE_COLLAPSED_STORAGE_KEY_LIVE
				) !== '0'
			);
		} catch ( _err ) {
			return true;
		}
	} );
	const togglePaletteCollapsed = () => {
		setPaletteCollapsed( ( prev ) => {
			const next = ! prev;
			try {
				window.localStorage.setItem(
					PALETTE_COLLAPSED_STORAGE_KEY_LIVE,
					next ? '1' : '0'
				);
			} catch ( _err ) {
				// localStorage disabled — in-session only.
			}
			return next;
		} );
	};
	const onThemeChange = ( slug ) => {
		const next = isValidTheme( slug ) ? slug : DEFAULT_THEME;
		setTheme( next );
		try {
			window.localStorage.setItem( THEME_STORAGE_KEY, next );
		} catch ( _err ) {
			// localStorage disabled — in-session only.
		}
	};
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
	const { transcript, sendLine, clear, cwd, setPath } = useDebugRepl(
		enabled && open,
		shell
	);
	// Layout storage scoped by cwd. Resolved BEFORE useDebugGraph so its
	// `onPositionChange` callback is in scope when a palette drop records the
	// position. Same JS hoisting reason as schemasByShellName lower down.
	const cwdScope = cwd || 'local';
	const {
		positions,
		viewport,
		isDirty: isLayoutDirty,
		onPositionChange,
		onViewportChange,
		onSeedLayout,
		resetLayout,
		markDirty,
	} = useDebugLayout( `${ storageKey }:${ cwdScope }` );
	// Catalog must be resolved before useDebugGraph so the Inspector handler
	// can look up `is_interpreter` for non-local-scope nodes.
	const jsCatalog = useJsCatalog();
	const phpCatalog = useClassCatalog( {
		enabled: enabled && open && !! cwd,
	} );
	const catalog = cwd ? phpCatalog : jsCatalog;
	const { graph, handlers, pendingDrop, commitDrop, cancelDrop } =
		useDebugGraph(
			enabled && open,
			shell,
			catalog.classes || [],
			onPositionChange
		);

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
	const pathOptions = useMemo( () => {
		const opts = [ '' ];
		for ( const { id } of graph.nodes ) {
			if ( id.startsWith( '_' ) && ! NON_NAVIGABLE.has( id ) ) {
				opts.push( id );
			}
		}
		return opts;
	}, [ graph.nodes, NON_NAVIGABLE ] );

	// Tab-completion: subscribe to _completion's published candidates and
	// expose a requestCompletion(line) that builds the `help` (first token)
	// or `ls` (later tokens) query addressed at the cwd. Mirrors
	// TopologyConsole.requestCompletion (Rule #4).
	const completion = useNodeState( names.COMPLETION, 'candidates' ) ?? null;
	const requestCompletion = useCallback(
		( line ) => {
			const onFirstToken = ! /\s/.test( String( line ).trimStart() );
			const verb = onFirstToken ? 'help' : 'ls';
			const m = newMessage();
			m[ TYPE ] = TM_COMMAND;
			m[ FROM ] = names.COMPLETION;
			m[ TO ] = cwd;
			m[ KEY ] = 'completion';
			m[ VALUE ] = { name: verb, arguments: '', payload: '' };
			m[ LOCAL ] = true;
			Core.node( names.COMMAND_INTERPRETER )?.fill( m );
		},
		[ cwd ]
	);
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

	// "Reset graph" = restore the host's default wiring (reinit rebuilds the
	// dashboard's build-registered nodes fresh, undoing in-canvas rewires) THEN
	// drop every node outside the keep-set. The keep-set is sourced from Core,
	// not a first-open snapshot: reserved infra names ∪ Core.reinitNames (the
	// nodes the dashboard build registered). Deterministic — independent of when
	// the panel opened or what was registered before it.
	const reservedNames = useMemo(
		() => new Set( Object.values( names ) ),
		[]
	);
	const resetGraph = () => {
		if ( reinit ) {
			reinit();
		}
		const keep = new Set( [
			...reservedNames,
			...( Core.reinitNames ?? [] ),
		] );
		for ( const name of [ ...Core.nodes.keys() ] ) {
			if ( ! keep.has( name ) ) {
				Core.unregisterNode( name );
			}
		}
		setGraphDirty( false );
	};

	// "Reset Layout" appears only when the user has modified the layout.
	// `isLayoutDirty` is the single source of truth — set by onPositionChange
	// or onViewportChange in useDebugLayout, cleared by resetLayout (and by
	// the initial autoLayout seed via onSeedLayout, which writes dirty=false).
	const hasLayoutToReset = isLayoutDirty;
	// Only meaningful in the local scope — `graph` is remote (server's
	// dump_metadata payload) when cwd is `/_http` etc., and every remote name
	// looks "new" against the local registry. Reset_graph removes nodes from the
	// LOCAL Core, which can't be done from a remote view.
	const isLocalScope = ! cwd;
	const hasUserNodes =
		isLocalScope &&
		graph.nodes.some(
			( n ) =>
				! reservedNames.has( n.id ) &&
				! ( Core.reinitNames ?? [] ).includes( n.id )
		);
	// Reset Graph shows when there's something to restore: user-added nodes, or
	// an in-canvas rewire that `reinit` can undo (a rewire with no host reinit
	// has nothing to restore, so the chip stays hidden). Local-scope only —
	// reinit rebuilds the LOCAL host graph, meaningless from a remote view.
	const canResetGraph =
		isLocalScope && !! reinit && ( graphDirty || hasUserNodes );

	// A connection rewire dirties the layout (surfaces Reset Layout) and flags
	// the graph dirty (surfaces Reset Graph when reinit can restore it).
	const onConnectDirtying = ( from, to ) => {
		handlers.onConnect( from, to );
		markDirty();
		setGraphDirty( true );
	};

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
					className="nodes-debug__panel"
					data-testid="debug-panel"
					style={ frameStyle }
				>
					<div
						className={ `topology-app theme-${ theme }${
							selected ? ' is-inspector-open' : ''
						}${ paletteCollapsed ? ' is-palette-collapsed' : '' }` }
					>
						{ /* display:contents wrapper so the inner <header> stays
						     a direct grid child (preserving grid-area: header)
						     while the pointerdown handler still bubbles up. */ }
						<div
							className="nodes-debug__header-drag"
							onPointerDown={ onHeaderPointerDown }
							onDoubleClick={ ( e ) => {
								// Skip dbl-click maximize when it lands on a
								// header control (select, button) — those have
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
							<Header
								theme={ theme }
								onThemeChange={ onThemeChange }
								themes={ THEMES }
								mode="view"
								pathOptions={ pathOptions }
								path={ cwd }
								onPathChange={ setPath }
								onClose={ () => setOpen( false ) }
							/>
						</div>
						<GraphView
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
							resetKey={ storageKey }
							interactive
							editMode={ false }
							showPalette
							paletteLoading={ catalog.loading }
							paletteCollapsed={ paletteCollapsed }
							onPaletteToggle={ togglePaletteCollapsed }
							classCatalog={ schemasByShellName }
							catalog={ catalog.classes }
							formatters={ catalog.formatters }
							positionOverrides={ positions }
							onPositionChange={ onPositionChange }
							onSeedLayout={ onSeedLayout }
							viewport={ viewport }
							onViewportChange={ onViewportChange }
							onConnect={ onConnectDirtying }
							onRemoveNode={ handlers.onRemoveNode }
							onDropNode={ handlers.onDropNode }
							onInspectorAction={ ( action, nodeId, payload ) => {
								// Pop the transcript footer when the user fires an
								// inspector action — matches the console's UX (the
								// reply lands in _output and the user should see it).
								setReplExpanded( true );
								handlers.onInspectorAction(
									action,
									nodeId,
									payload
								);
							} }
							onSelectionChange={ setSelected }
							onBackgroundClickConsumed={
								onCanvasBackgroundClick
							}
						/>
						<ReplFooter
							prompt={ `/${ cwd }` }
							canSend={ true }
							onSubmit={ sendLine }
							onClear={ clear }
							transcript={ transcript }
							completion={ completion }
							onComplete={ requestCompletion }
							expanded={ replExpanded }
							onExpandedChange={ setReplExpanded }
							inputRef={ replInputRef }
							maxHeightPx={ replMaxHeightPx }
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
