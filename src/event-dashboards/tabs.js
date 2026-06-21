/**
 * Register the hub DevTools tabs the event-dashboards bundle owns: the Overview
 * landing (order 0 — the default first paint, ahead of the Console at order 15;
 * it now folds in the per-topology detail tree the old Topologies tab carried)
 * and Raw Logs (order 20). Imported (for its side effect) by the event-dashboards
 * bundle entry so the tabs register wherever the bundle loads (the Hub page
 * enqueues it via the `newspack_nodes/devtools_tab_bundles` filter). Raw Logs is
 * `fullBleed` — it owns its own full-height canvas/scroll like the Console — and
 * does NOT render its own debug overlay; the hub provides the overlay on every
 * non-console tab.
 */

import { __ } from '@wordpress/i18n';
import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import Overview from './Overview';
import RawLogs from './RawLogs';

// Order 0 → the hub's default first paint, ahead of the Console (order 15): a
// light landing glance instead of the Console's heavy graph build.
registerDevtoolsTab( {
	id: 'overview',
	label: __( 'Overview', 'newspack-nodes' ),
	host: 'hub',
	slug: 'overview',
	order: 0,
	component: Overview,
} );

registerDevtoolsTab( {
	id: 'raw-logs',
	label: __( 'Raw Logs', 'newspack-nodes' ),
	host: 'hub',
	slug: 'raw-logs',
	param: 'log',
	order: 20,
	fullBleed: true,
	component: RawLogs,
} );
