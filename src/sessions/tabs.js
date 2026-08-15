/**
 * Register the Sessions hub DevTools tab (order 35). Imported for its side
 * effect by the sessions bundle entry, so the tab registers wherever the bundle
 * loads. The descriptor metadata is the shared `./tabMeta` — the same one the
 * hub's lazy placeholder carries.
 */

import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import tabMeta from './tabMeta';
import SessionsAdmin from './SessionsAdmin';
import './nodes/register';

registerDevtoolsTab( { ...tabMeta, component: SessionsAdmin } );
