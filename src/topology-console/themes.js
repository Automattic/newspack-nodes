/**
 * The Topology Console's theme surface: the shared skin contract, plus the
 * storage keys the console shell's two flanking panels persist their collapse
 * state under.
 *
 * The skin catalog and its storage helpers live in `src/shared/theme.js`, so
 * sibling dashboards import the same contract through
 * `@newspack-nodes/shared/theme`. This file re-exports the four entry points
 * the console reaches for and declares the three collapse keys beside them,
 * giving console modules one import for both. Everything else the shared
 * module exports — `THEME_STORAGE_KEY`, `SKIN_EVENT`, `isValidTheme` — is
 * imported from there directly.
 *
 * The debug overlay imports from here as well. It mounts the same
 * ConsoleShell, so it persists its palette and inspector state under the
 * console's keys instead of a parallel set of its own.
 */
export { THEMES, getStoredTheme, applySkin, initSkin } from '../shared/theme';

/**
 * The `localStorage` key the class palette's collapse state persists under in
 * the console's view mode and on the debug overlay's live canvas.
 *
 * View and edit keep separate keys because the two modes want opposite
 * answers: the palette is the source of new nodes in edit mode and opens
 * there, while view mode starts collapsed. Sharing one key would make each
 * mode inherit whatever the other was left at. The default itself belongs to
 * the caller — `TopologyConsole` picks it by mode — and this is only where the
 * reader's own choice is stored.
 */
export const PALETTE_COLLAPSED_STORAGE_KEY_LIVE =
	'newspack-nodes:palette-collapsed:live';

/**
 * The `localStorage` key the class palette's collapse state persists under in
 * the console's edit mode. The LIVE key above carries why the two modes do not
 * share one.
 */
export const PALETTE_COLLAPSED_STORAGE_KEY_EDIT =
	'newspack-nodes:palette-collapsed:edit';

/**
 * The `localStorage` key the node inspector's collapse state persists under.
 *
 * One key covers every surface, unlike the palette's pair, because a reader
 * who opens the inspector wants it open wherever the ConsoleShell appears.
 */
export const INSPECTOR_COLLAPSED_STORAGE_KEY =
	'newspack-nodes:inspector-collapsed';
