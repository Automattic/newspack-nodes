import { useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import GraphView from '../topology-console/components/GraphView';
import Header from '../topology-console/components/Header';
import ReplFooter from '../topology-console/components/ReplFooter';
import { useJsCatalog } from '../topology-console/hooks/useJsCatalog';
import {
	THEMES,
	DEFAULT_THEME,
	isValidTheme,
} from '../topology-console/themes';
import { isDebugEnabled } from './isDebugEnabled';
import { useDebugGraph } from './useDebugGraph';
import { useDebugLayout } from './useDebugLayout';
import { useDebugRepl } from './useDebugRepl';
import './debug-overlay.scss';

// Minimal canvas frame for the overlay — no topology/layout chrome.
const PlainFrame = ( { children } ) => (
	<div className="nodes-debug__canvas">{ children }</div>
);

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
	const { positions, viewport, onPositionChange, onViewportChange } =
		useDebugLayout( storageKey );

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

	return (
		<div className="nodes-debug">
			<button
				type="button"
				className="nodes-debug__fab"
				aria-label={ __( 'Toggle node debugger', 'newspack-nodes' ) }
				onClick={ () => setOpen( ( v ) => ! v ) }
			>
				{ '◉' }
			</button>
			{ open && (
				<div className="nodes-debug__panel" data-testid="debug-panel">
					<div
						className={ `topology-app theme-${ theme }${
							selected ? ' is-inspector-open' : ''
						}${ paletteCollapsed ? ' is-palette-collapsed' : '' }` }
					>
						<Header
							theme={ theme }
							onThemeChange={ onThemeChange }
							themes={ THEMES }
							mode="view"
							pathOptions={ [] }
							path=""
						/>
						<GraphView
							graph={ graph }
							frame={ PlainFrame }
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
							onInspectorAction={ handlers.onInspectorAction }
							onSelectionChange={ setSelected }
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
						/>
					</div>
				</div>
			) }
		</div>
	);
}
