/**
 * Topology Console skins. The skin catalog and storage helpers now live in the
 * shared module (`src/shared/theme.js`) so sibling dashboards can import the
 * same contract via `@newspack-nodes/shared/theme`; this file re-exports them
 * so every existing console importer keeps working unchanged, and adds the
 * console-only palette/inspector collapse-state keys.
 */
export {
	THEME_STORAGE_KEY,
	DEFAULT_THEME,
	THEMES,
	isValidTheme,
	getStoredTheme,
} from '../shared/theme';

// Palette collapse state is stored per-mode (live vs edit) because the
// two surfaces want different defaults: live defaults to collapsed
// (the palette isn't needed when watching), edit defaults to open (you
// drop nodes from it onto the canvas). The DebugOverlay only ever runs
// in live mode and so reads/writes the live key.
export const PALETTE_COLLAPSED_STORAGE_KEY_LIVE =
	'newspack-nodes:palette-collapsed:live';
export const PALETTE_COLLAPSED_STORAGE_KEY_EDIT =
	'newspack-nodes:palette-collapsed:edit';

// Inspector collapse is a single global preference (not per-mode like the
// palette): the user's choice to keep the inspector railed persists across
// mode switches and mounts.
export const INSPECTOR_COLLAPSED_STORAGE_KEY =
	'newspack-nodes:inspector-collapsed';
