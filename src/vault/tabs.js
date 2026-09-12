/**
 * Register the Vault station tab (order 30) and this bundle's slice-view
 * node class. The bundle entry imports this module for both side effects.
 *
 * Admin contributes this bundle to `newspack_nodes/station_tab_bundles` as
 * lazy, so it arrives only once someone opens the tab. The descriptor is the
 * shared `./tabMeta`, which the station's lazy placeholder carries as well, so the
 * label, the order and the `?tab=vault` deep link hold before the bundle
 * loads. The station renders the page chrome and the DebugOverlay around whichever
 * tab is active, so the component registered here is VaultAdmin itself rather
 * than a page wrapper.
 *
 * Importing `./nodes/register` enters VaultListView in this bundle's
 * `CommandInterpreterNode` name table, which TSL and the console palette read.
 * `useVaultGraph` does not depend on that table: name resolution is a
 * per-bundle static, so the hook hands `makeNode` the exported class itself
 * (ADR-16).
 */

import { registerTab } from '@newspack-nodes/shared/tabs/tabRegistry';
import tabMeta from './tabMeta';
import VaultAdmin from './VaultAdmin';
import './nodes/register';

registerTab( { ...tabMeta, component: VaultAdmin } );
