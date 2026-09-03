/**
 * Register the Aggregator hub DevTools tab (order 40) and this bundle's two
 * slice-view node classes. The bundle entry imports this module for both side
 * effects.
 *
 * The descriptor is the shared `./tabMeta`, which the hub's lazy placeholder
 * carries as well, so the tab-bar identity holds before the bundle loads. The
 * hub renders the page chrome and the DebugOverlay around whichever tab is
 * active, so the component registered here is AggregatorStatus itself rather
 * than a page wrapper.
 *
 * Importing `./nodes/register` enters AggregatorSummaryView and
 * AggregatorServersView in this bundle's `CommandInterpreterNode` name table,
 * which TSL and the console palette read. `useAggregatorStatusGraph` does not
 * depend on that table: name resolution is a per-bundle static, so a hook hands
 * `makeNode` the exported class itself (ADR-16).
 */

import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import tabMeta from './tabMeta';
import AggregatorStatus from './AggregatorStatus';
import './nodes/register';

registerDevtoolsTab( { ...tabMeta, component: AggregatorStatus } );
