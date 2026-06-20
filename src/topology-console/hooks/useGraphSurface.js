import { useCallback, useMemo, useRef, useState } from '@wordpress/element';
import { usePanelChrome } from './usePanelChrome';

/**
 * The shared graph-surface chrome for the topology console AND the debug overlay
 * — the two consumers that mount ConsoleShell. Both used to assemble their own
 * copy of the inspector / transcript-overlay / palette wiring, so a new
 * canvas-or-inspector behavior had to be threaded twice and the overlay kept
 * getting missed. This hook owns that wiring once and returns ready-to-spread
 * `canvasChromeProps` / `replChromeProps` fragments; consumers spread them into
 * their ConsoleShell `canvasProps` / `replProps` and add only their own,
 * genuinely-different props (edit mode, drag/maximize, headers, the command
 * pipe, etc.).
 *
 * Composes usePanelChrome (theme + palette + inspector-collapse) and adds:
 *  - the transcript→autofit obstruction (`bottomObstructionPx`, fed by the
 *    ReplFooter's reported overlay height), and
 *  - the REPL expand state + input ref,
 * then bundles the bits both consumers wire identically.
 *
 * @param {Object}  opts                    Options (forwarded to usePanelChrome).
 * @param {string}  opts.paletteKey         localStorage key for palette-collapsed.
 * @param {boolean} [opts.defaultCollapsed] Palette default when storage is empty.
 * @return {Object} Chrome values + `canvasChromeProps` / `replChromeProps` fragments + `openInspectorOnSelect`.
 */
export function useGraphSurface( { paletteKey, defaultCollapsed } ) {
	const {
		theme,
		onThemeChange,
		paletteCollapsed,
		togglePaletteCollapsed,
		inspectorCollapsed,
		setInspectorCollapsed,
		toggleInspectorCollapsed,
	} = usePanelChrome( { paletteKey, defaultCollapsed } );

	// Px the expanded transcript overlays the canvas with (reported by ReplFooter)
	// → fed to the autofit so nodes fit ABOVE the transcript.
	const [ transcriptOverlayPx, setTranscriptOverlayPx ] = useState( 0 );
	// REPL transcript expand state + the prompt input (so a parent can refocus).
	const [ replExpanded, setReplExpanded ] = useState( false );
	const replInputRef = useRef( null );

	// Selecting a node auto-opens the inspector (rail → panel); deselect (null)
	// leaves it as-is. Consumers call this from their own onSelectionChange.
	const openInspectorOnSelect = useCallback(
		( id ) => {
			if ( id ) {
				setInspectorCollapsed( false );
			}
		},
		[ setInspectorCollapsed ]
	);

	// The canvasProps fragment both consumers spread (palette + inspector + the
	// transcript obstruction). Memoized so identity is stable per state.
	const canvasChromeProps = useMemo(
		() => ( {
			paletteCollapsed,
			onPaletteToggle: togglePaletteCollapsed,
			inspectorCollapsed,
			onInspectorToggle: toggleInspectorCollapsed,
			bottomObstructionPx: transcriptOverlayPx,
		} ),
		[
			paletteCollapsed,
			togglePaletteCollapsed,
			inspectorCollapsed,
			toggleInspectorCollapsed,
			transcriptOverlayPx,
		]
	);

	// The replProps fragment both consumers spread (expand state + the overlay
	// height report that feeds bottomObstructionPx).
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
		theme,
		onThemeChange,
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
		canvasChromeProps,
		replChromeProps,
	};
}
