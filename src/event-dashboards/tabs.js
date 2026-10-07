/**
 * Register the five station tabs the event-dashboards bundle owns: Overview
 * (order 0), Jobs (10), Tables (12), Partition Viewer (20) and Config Audit
 * (30). The bundle entry imports this module for its side effect alone, so the
 * tabs register wherever the bundle loads.
 *
 * Order 0 makes Overview the station's landing tab, ahead of the Console at 15,
 * which is why `Admin::enqueue_station_tab_bundles()` enqueues this bundle
 * with the page rather than on first activation. These orders interleave with
 * every other bundle's, so Config Audit ties with Vault at 30 and the registry
 * settles that tie alphabetically by label.
 *
 * The Partition Viewer reads every log the substrate knows: packed partition
 * dirs and plain registry files alike, a file streamed as `sources/<name>`. It
 * declares `fullBleed`, owning a full-height split like the Console instead of
 * the host's scroll container, and claims the `log` query param, which the
 * host clears from the URL while another tab is active. It renders no debug
 * overlay of its own; the station renders one around whichever tab is active.
 */

import { __ } from '@wordpress/i18n';
import { registerTab } from '@newspack-nodes/shared/tabs/tabRegistry';
import Overview from './Overview';
import Jobs from './Jobs';
import Tables from './Tables';
import PartitionViewer from './PartitionViewer';
import ConfigAudit from './ConfigAudit';

registerTab( {
	id: 'overview',
	label: __( 'Overview', 'newspack-nodes' ),
	host: 'station',
	slug: 'overview',
	order: 0,
	component: Overview,
} );

registerTab( {
	id: 'jobs',
	label: __( 'Jobs', 'newspack-nodes' ),
	host: 'station',
	slug: 'jobs',
	order: 10,
	component: Jobs,
} );

registerTab( {
	id: 'tables',
	label: __( 'Tables', 'newspack-nodes' ),
	host: 'station',
	slug: 'tables',
	order: 12,
	component: Tables,
} );

registerTab( {
	id: 'partition-viewer',
	label: __( 'Partition Viewer', 'newspack-nodes' ),
	host: 'station',
	slug: 'partition-viewer',
	param: 'log',
	order: 20,
	fullBleed: true,
	component: PartitionViewer,
} );

registerTab( {
	id: 'config-audit',
	label: __( 'Config Audit', 'newspack-nodes' ),
	host: 'station',
	slug: 'config-audit',
	order: 30,
	component: ConfigAudit,
} );
