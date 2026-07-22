/**
 * Register the hub DevTools tabs the event-dashboards bundle owns: the Overview
 * landing (order 0 — the default first paint, ahead of the Console at order 15;
 * it folds in the per-topology detail tree)
 * and Partition Viewer (order 20). Imported (for its side effect) by the event-dashboards
 * bundle entry so the tabs register wherever the bundle loads (the Hub page
 * enqueues it via the `newspack_nodes/devtools_tab_bundles` filter). Partition Viewer is
 * `fullBleed` — it owns its own full-height canvas/scroll like the Console — and
 * does NOT render its own debug overlay; the hub provides the overlay on every
 * non-console tab.
 */

import { __ } from '@wordpress/i18n';
import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import Overview from './Overview';
import Jobs from './Jobs';
import PartitionViewer from './PartitionViewer';
import LogViewer from './LogViewer';
import ConfigAudit from './ConfigAudit';

// Order 0 → hub's default first paint, ahead of the Console's graph build.
registerDevtoolsTab( {
	id: 'overview',
	label: __( 'Overview', 'newspack-nodes' ),
	host: 'hub',
	slug: 'overview',
	order: 0,
	component: Overview,
} );

// Order 10 → between Overview (0) and the Console (15): the jobs board.
registerDevtoolsTab( {
	id: 'jobs',
	label: __( 'Jobs', 'newspack-nodes' ),
	host: 'hub',
	slug: 'jobs',
	order: 10,
	component: Jobs,
} );

registerDevtoolsTab( {
	id: 'partition-viewer',
	label: __( 'Partition Viewer', 'newspack-nodes' ),
	host: 'hub',
	slug: 'partition-viewer',
	param: 'log',
	order: 20,
	fullBleed: true,
	component: PartitionViewer,
} );

// Order 25 → the sibling Log Viewer: tails plain log FILES over /log/stream.
registerDevtoolsTab( {
	id: 'log-viewer',
	label: __( 'Log Viewer', 'newspack-nodes' ),
	host: 'hub',
	slug: 'log-viewer',
	param: 'source',
	order: 25,
	fullBleed: true,
	component: LogViewer,
} );

// Order 30 → the config-audit timeline: the settings.p0 option-name change log.
registerDevtoolsTab( {
	id: 'config-audit',
	label: __( 'Config Audit', 'newspack-nodes' ),
	host: 'hub',
	slug: 'config-audit',
	order: 30,
	component: ConfigAudit,
} );
