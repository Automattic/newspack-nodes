import { useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { Core } from '../runtime/core';
import { __ } from '@wordpress/i18n';
import CanvasFrame from '../topology-console/components/CanvasFrame';
import GraphView from '../topology-console/components/GraphView';
import { makeReplDismissHandler } from '../topology-console/utils/replDismissHandler';
import Header from '../topology-console/components/Header';
import ReplFooter from '../topology-console/components/ReplFooter';
import { useJsCatalog } from '../topology-console/hooks/useJsCatalog';
import {
	THEMES,
	DEFAULT_THEME,
	isValidTheme,
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
	const themeKey = `${ storageKey }:theme`;
	const paletteKey = `${ storageKey }:palette-collapsed`;
	const [ theme, setTheme ] = useState( () => readStoredTheme( themeKey ) );
	const [ paletteCollapsed, setPaletteCollapsed ] = useState( () => {
		try {
			return window.localStorage.getItem( paletteKey ) === '1';
		} catch ( _err ) {
			return false;
		}
	} );
	const togglePaletteCollapsed = () => {
		setPaletteCollapsed( ( prev ) => {
			const next = ! prev;
			try {
				if ( next ) {
					window.localStorage.setItem( paletteKey, '1' );
				} else {
					window.localStorage.removeItem( paletteKey );
				}
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
			window.localStorage.setItem( themeKey, next );
		} catch ( _err ) {
			// localStorage disabled — in-session only.
		}
	};
	const { graph, handlers } = useDebugGraph( enabled && open );
	const { transcript, sendLine, clear } = useDebugRepl( enabled && open );
	// The overlay's palette must source from the JS-side CommandInterpreter
	// .includeNodes (the only set make_node can instantiate in this realm),
	// NOT the HTTP `classes.list` catalog which returns the PHP substrate's
	// node registry.
	const catalog = useJsCatalog();
	const schemasByShellName = useMemo(
		() =>
			Object.fromEntries(
				( catalog.classes || [] ).map( ( c ) => [ c.shell_name, c ] )
			),
		[ catalog.classes ]
	);
	const {
		positions,
		viewport,
		onPositionChange,
		onViewportChange,
		resetLayout,
	} = useDebugLayout( storageKey );
	const {
		frame,
		style: frameStyle,
		onHeaderPointerDown,
		getResizeHandlers,
		toggleMaximize,
	} = useDebugFrame( `${ storageKey }:frame`, enabled && open );

	// "Reset graph" in the overlay = remove every node the user added via the
	// overlay since the panel first opened, leaving the dashboard's own nodes
	// (and the overlay's spine: _output, _command_interpreter, _router, etc.)
	// in place. Mirrors the console's resetLocalGraph (Core.unregisterNode
	// everything outside a protected set) — except the "protected" set is
	// computed dynamically at first-open since the dashboard's node names
	// vary per page.
	const baselineNamesRef = useRef( null );
	useEffect( () => {
		if ( ! ( enabled && open ) ) {
			return;
		}
		if ( baselineNamesRef.current ) {
			return;
		}
		// Capture after a tick so useDebugGraph + useDebugRepl have registered
		// their nodes (exospine CI/router, _output Dumper). Anything in Core
		// at this point is considered "original" and won't be removed by reset.
		const id = setTimeout( () => {
			baselineNamesRef.current = new Set( Core.nodes.keys() );
		}, 0 );
		return () => clearTimeout( id );
	}, [ enabled, open ] );

	const resetGraph = () => {
		const baseline = baselineNamesRef.current;
		if ( ! baseline ) {
			return;
		}
		for ( const name of [ ...Core.nodes.keys() ] ) {
			if ( ! baseline.has( name ) ) {
				Core.unregisterNode( name );
			}
		}
	};

	// Hide the reset chips when there's nothing to undo. The layout chip
	// keys on positions only — the canvas's autofit-on-mount effect commits
	// a viewport back to the parent immediately after we set it to null,
	// so `viewport !== null` is true for an auto-committed value just like
	// for a real user pan/zoom; we can't tell them apart. Trust positions
	// as the user-intent signal.
	const hasLayoutToReset = Object.keys( positions ).length > 0;
	const baseline = baselineNamesRef.current;
	const hasUserNodes =
		baseline !== null &&
		graph.nodes.some( ( n ) => ! baseline.has( n.id ) );

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
								pathOptions={ [] }
								path=""
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
								onResetGraph: hasUserNodes ? resetGraph : null,
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
							viewport={ viewport }
							onViewportChange={ onViewportChange }
							onConnect={ handlers.onConnect }
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
							prompt="/"
							canSend={ true }
							onSubmit={ sendLine }
							onClear={ clear }
							transcript={ transcript }
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
		</div>
	);
}
