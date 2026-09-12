/**
 * Register the Topology Console as a `host: 'station'` tab. Imported (for
 * its side effect) by the topology-console bundle entry so the tab registers
 * wherever the bundle loads. The descriptor metadata (order 15, `fullBleed`,
 * `?tab=console`) is the shared `./tabMeta` — the same the station's lazy placeholder
 * carries, so the tab bar identity is stable across the on-demand load.
 */

import { registerTab } from '@newspack-nodes/shared/tabs/tabRegistry';
import tabMeta from './tabMeta';
import TopologyConsole from './TopologyConsole';

registerTab( { ...tabMeta, component: TopologyConsole } );
