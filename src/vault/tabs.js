/**
 * Register the Vault hub DevTools tab (order 30). Imported (for its side effect)
 * by the vault bundle entry so the tab registers wherever the bundle loads (the
 * Hub page loads it on demand via the `newspack_nodes/devtools_tab_bundles`
 * filter). The descriptor metadata is the shared `./tabMeta` — the same the hub's
 * lazy placeholder carries.
 */

import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import tabMeta from './tabMeta';
import VaultAdmin from './VaultAdmin';
import './nodes/register';

registerDevtoolsTab( { ...tabMeta, component: VaultAdmin } );
