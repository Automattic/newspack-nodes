import { useCallback, useMemo, useRef, useState } from '@wordpress/element';
import { usePanelChrome } from './usePanelChrome';

/**
 * The graph-surface chrome the topology console and the debug overlay share —
 * the two consumers that mount ConsoleShell. Holding the inspector, transcript
 * and palette wiring in one hook is what keeps the two surfaces in step:
 * threaded separately, every new canvas or inspector behavior has to be added
 * twice, and the overlay is the copy that gets missed.
 *
 * Composes usePanelChrome (palette + inspector collapse) and adds the two
 * things the REPL contributes to the canvas: the height its transcript overlay
 * covers, which each consumer hands ChromeProvider as `bottomObstructionPx` so
 * autofit fits the graph above it, and the transcript expand state plus the
 * prompt input ref a consumer refocuses through. Consumers spread
 * `replChromeProps` into their ConsoleShell `replProps` and add only what
 * genuinely differs between them — edit mode, drag and maximize, the header
 * controls, the command pipe.
 *
 * @param {Object}  opts                    Options, forwarded to usePanelChrome.
 * @param {string}  opts.paletteKey         localStorage key for palette-collapsed; the console picks it by mode, the overlay passes the LIVE key.
 * @param {boolean} [opts.defaultCollapsed] Palette default when storage is empty.
 * @return {Object} The usePanelChrome palette and inspector values, plus
 * `transcriptOverlayPx`, `replExpanded`, `replInputRef`, their setters,
 * `openInspectorOnSelect` and the `replChromeProps` fragment.
 */
export function useGraphSurface( { paletteKey, defaultCollapsed } ) {
	const {
		paletteCollapsed,
		togglePaletteCollapsed,
		inspectorCollapsed,
		setInspectorCollapsed,
		toggleInspectorCollapsed,
	} = usePanelChrome( { paletteKey, defaultCollapsed } );

	// Px of canvas the transcript overlay covers; autofit fits above it.
	const [ transcriptOverlayPx, setTranscriptOverlayPx ] = useState( 0 );
	// REPL transcript expand state + prompt input (so a parent can refocus).
	const [ replExpanded, setReplExpanded ] = useState( false );
	const replInputRef = useRef( null );

	// Selecting a node auto-opens the inspector; deselect leaves it as-is.
	const openInspectorOnSelect = useCallback(
		( id ) => {
			if ( id ) {
				setInspectorCollapsed( false );
			}
		},
		[ setInspectorCollapsed ]
	);

	// The replProps fragment both consumers spread into ConsoleShell.
	const replChromeProps = useMemo(
		() => ( {
			expanded: replExpanded,
			onExpandedChange: setReplExpanded,
			inputRef: replInputRef,
			onOverlayHeightChange: setTranscriptOverlayPx,
		} ),
		[ replExpanded ]
	);

	return {
		paletteCollapsed,
		togglePaletteCollapsed,
		inspectorCollapsed,
		setInspectorCollapsed,
		toggleInspectorCollapsed,
		transcriptOverlayPx,
		setTranscriptOverlayPx,
		replExpanded,
		setReplExpanded,
		replInputRef,
		openInspectorOnSelect,
		replChromeProps,
	};
}
