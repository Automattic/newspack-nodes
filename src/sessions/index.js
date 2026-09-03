/**
 * Build entry for the `build/sessions` bundle: the side-effecting `./tabs`
 * import registers the Sessions hub tab.
 *
 * `Admin::register_sessions_tab_bundle()` advertises the bundle through the
 * `newspack_nodes/devtools_tab_bundles` filter as lazy, so nothing enqueues
 * this file with the hub page — the hub shell fetches it on first activation
 * of the Sessions tab.
 */
import './tabs';
