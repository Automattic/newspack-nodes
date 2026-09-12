/**
 * Build entry for the `build/vault` bundle: the side-effecting `./tabs` import
 * registers the Vault station tab.
 *
 * `Admin::register_vault_tab_bundle()` advertises the bundle through the
 * `newspack_nodes/station_tab_bundles` filter as lazy, so nothing enqueues
 * this file with the station page — the station shell fetches it on first activation
 * of the Vault tab.
 */
import './tabs';
