/**
 * Register the Topology Console as a `host: 'hub'` DevTools tab. Imported (for
 * its side effect) by the topology-console bundle entry so the tab registers
 * wherever the bundle loads. Order 0 puts the Console FIRST in the hub bar,
 * before the Topology Manager (order 10). `fullBleed` opts the console out of
 * the tab host's default scroll container — it owns its own full-height canvas.
 */

import { __ } from '@wordpress/i18n';
import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import TopologyConsole from './TopologyConsole';

registerDevtoolsTab( {
	id: 'topology-console',
	label: __( 'Console', 'newspack-nodes' ),
	host: 'hub',
	slug: 'console',
	param: 'topology',
	order: 0,
	fullBleed: true,
	component: TopologyConsole,
} );
