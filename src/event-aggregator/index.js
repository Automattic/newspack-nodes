/**
 * Build entry for the `build/event-aggregator` bundle: the side-effecting
 * `./tabs` import registers the Aggregator station tab.
 *
 * `Admin::register_aggregator_tab_bundle()` advertises the bundle through the
 * `newspack_nodes/station_tab_bundles` filter as lazy, so nothing enqueues
 * this file with the station page — the station shell fetches it on first activation
 * of the Aggregator tab.
 */
import './tabs';
