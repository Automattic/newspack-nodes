/**
 * Topology Console skins. The skin catalog and storage helpers live in the
 * shared module (`src/shared/theme.js`) so sibling dashboards can import the
 * same contract via `@newspack-nodes/shared/theme`; this file re-exports the
 * four the console uses and adds the console-only palette/inspector
 * collapse-state keys. Anything else comes straight from the shared module.
 */
export { THEMES, getStoredTheme, applySkin, initSkin } from '../shared/theme';

// Palette collapse is per-mode: live defaults collapsed, edit defaults open.
export const PALETTE_COLLAPSED_STORAGE_KEY_LIVE =
	'newspack-nodes:palette-collapsed:live';
export const PALETTE_COLLAPSED_STORAGE_KEY_EDIT =
	'newspack-nodes:palette-collapsed:edit';

// Inspector collapse is one global preference (not per-mode like palette).
export const INSPECTOR_COLLAPSED_STORAGE_KEY =
	'newspack-nodes:inspector-collapsed';
