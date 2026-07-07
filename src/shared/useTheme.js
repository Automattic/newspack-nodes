/**
 * Reactive read of the live skin. Every themed `.topology-app.theme-<slug>` root
 * IN THIS BUNDLE that subscribes through this re-renders in the SAME commit on a
 * `set_skin` from any surface — the overlay's outer + inner wrappers (killing the
 * switch-time bleed, where they used to flip a beat apart) and the hub backdrop
 * behind the overlay (killing the stale page-behind).
 *
 * Scope caveat: the store is a per-bundle module singleton, and the
 * `@newspack-nodes/shared` alias inlines it into each consumer's bundle. So a
 * `set_skin` re-skins only the roots in the SAME bundle. A sibling plugin's own
 * dashboard backdrop (e.g. event-logger-nodes) re-skins live only once ITS root
 * wrapper also reads `useThemeValue()` — until then it re-reads the preference
 * on next load (or via its own cross-tab listener), not on the in-window switch.
 *
 * Read-only by design: the surfaces that CHANGE the skin call `setTheme` (via
 * their view-transition wrapper); read consumers never need it.
 *
 * @return {string} The live skin slug; changes trigger a re-render.
 */
import { useSyncExternalStore } from '@wordpress/element';
import { subscribeTheme, readTheme } from './theme';

export function useThemeValue() {
	return useSyncExternalStore( subscribeTheme, readTheme, readTheme );
}
