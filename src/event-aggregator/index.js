/**
 * Build entry for the `build/event-aggregator` bundle: the side-effecting
 * `./tabs` import registers the Aggregator hub tab.
 *
 * `Admin::register_aggregator_tab_bundle()` advertises the bundle through the
 * `newspack_nodes/devtools_tab_bundles` filter as lazy, so nothing enqueues
 * this file with the hub page — the hub shell fetches it on first activation
 * of the Aggregator tab.
 */
import './tabs';
