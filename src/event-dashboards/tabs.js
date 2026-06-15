/**
 * Register the hub DevTools tabs the event-dashboards bundle owns: the Topology
 * Manager (order 10) and Raw Logs (order 20). Imported (for its side effect) by
 * the event-dashboards bundle entry so the tabs register wherever the bundle
 * loads (the Hub page enqueues it via the `newspack_nodes/devtools_tab_bundles`
 * filter). Raw Logs is `fullBleed` — it owns its own full-height canvas/scroll
 * like the Console — and does NOT render its own debug overlay; the hub provides
 * the overlay on every non-console tab.
 */

import { __ } from '@wordpress/i18n';
import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import TopologyManager from './TopologyManager';
import RawLogs from './RawLogs';

registerDevtoolsTab( {
	id: 'topology-manager',
	label: __( 'Topologies', 'newspack-nodes' ),
	host: 'hub',
	order: 10,
	component: TopologyManager,
} );

registerDevtoolsTab( {
	id: 'raw-logs',
	label: __( 'Raw Logs', 'newspack-nodes' ),
	host: 'hub',
	order: 20,
	fullBleed: true,
	component: RawLogs,
} );
