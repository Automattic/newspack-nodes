/**
 * Register the Topology Console as a `host: 'hub'` DevTools tab. Imported (for
 * its side effect) by the topology-console bundle entry so the tab registers
 * wherever the bundle loads. The descriptor metadata (order 15, `fullBleed`,
 * `?tab=console`) is the shared `./tabMeta` — the same the hub's lazy placeholder
 * carries, so the tab bar identity is stable across the on-demand load.
 */

import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import tabMeta from './tabMeta';
import TopologyConsole from './TopologyConsole';

registerDevtoolsTab( { ...tabMeta, component: TopologyConsole } );
