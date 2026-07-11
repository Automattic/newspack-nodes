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
		paletteCollapsed,
		togglePaletteCollapsed,
		inspectorCollapsed,
		setInspectorCollapsed,
		toggleInspectorCollapsed,
	} = usePanelChrome( { paletteKey, defaultCollapsed } );

	// Px the transcript overlay covers the canvas; fed to autofit (fit above).
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

	// canvasProps fragment both consumers spread; memoized for stable identity.
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

	// replProps fragment both consumers spread (expand + overlay-height).
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
		canvasChromeProps,
		replChromeProps,
	};
}
