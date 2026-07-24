/**
 * Register the Aggregator hub DevTools tab (order 40). Imported (for its side
 * effect) by the aggregator bundle entry so the tab registers wherever the
 * bundle loads (the Hub page loads it on demand via the
 * `newspack_nodes/devtools_tab_bundles` filter). The hub supplies the page
 * chrome + DebugOverlay, so the registered component is the inner
 * AggregatorStatus, not a page wrapper. Metadata is the shared `./tabMeta`.
 */

import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import tabMeta from './tabMeta';
import AggregatorStatus from './AggregatorStatus';
import './nodes/register';

registerDevtoolsTab( { ...tabMeta, component: AggregatorStatus } );
