/**
 * Register the five hub DevTools tabs the event-dashboards bundle owns:
 * Overview (order 0), Jobs (10), Partition Viewer (20), Log Viewer (25) and
 * Config Audit (30). The bundle entry imports this module for its side effect
 * alone, so the tabs register wherever the bundle loads.
 *
 * Order 0 makes Overview the hub's landing tab, ahead of the Console at 15,
 * which is why `Admin::enqueue_devtools_tab_bundles()` enqueues this bundle
 * with the page rather than on first activation. These orders interleave with
 * every other bundle's, so Config Audit ties with Vault at 30 and the registry
 * settles that tie alphabetically by label.
 *
 * Partition Viewer and Log Viewer are the two log readers, one over packed
 * partition records and one over plain log files on `GET /log/stream`. Both
 * declare `fullBleed`, owning a full-height split like the Console instead of
 * the host's scroll container, and each claims one query param — `log` and
 * `source` — which the host clears from the URL while another tab is active.
 * Neither renders a debug overlay of its own; the hub renders one around
 * whichever tab is active.
 */

import { __ } from '@wordpress/i18n';
import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import Overview from './Overview';
import Jobs from './Jobs';
import PartitionViewer from './PartitionViewer';
import LogViewer from './LogViewer';
import ConfigAudit from './ConfigAudit';

registerDevtoolsTab( {
	id: 'overview',
	label: __( 'Overview', 'newspack-nodes' ),
	host: 'hub',
	slug: 'overview',
	order: 0,
	component: Overview,
} );

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

registerDevtoolsTab( {
	id: 'config-audit',
	label: __( 'Config Audit', 'newspack-nodes' ),
	host: 'hub',
	slug: 'config-audit',
	order: 30,
	component: ConfigAudit,
} );
