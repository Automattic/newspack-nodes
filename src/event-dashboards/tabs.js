/**
 * Register the Topology Manager as a `host: 'hub'` DevTools tab. Imported (for
 * its side effect) by the event-dashboards bundle entry so the tab registers
 * wherever the bundle loads (the Hub page enqueues it via the
 * `newspack_nodes/devtools_tab_bundles` filter).
 */

import { __ } from '@wordpress/i18n';
import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import TopologyManager from './TopologyManager';

registerDevtoolsTab( {
	id: 'topology-manager',
	label: __( 'Topologies', 'newspack-nodes' ),
	host: 'hub',
	order: 10,
	component: TopologyManager,
} );
