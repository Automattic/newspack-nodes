/**
 * Aggregator hub-tab descriptor — everything but the component. Shared by
 * `./tabs` (full registration when the bundle loads) and the hub's lazy
 * placeholder, so the tab bar identity matches before the bundle loads. A
 * second spelling of it would rename, reorder or duplicate the tab the moment
 * the bundle arrives.
 *
 * Order 40 lands it after Sessions (35), at the end of the substrate's hub
 * bar: every tab before it reads this install, while the Aggregator reads the
 * spokes.
 */

import { __ } from '@wordpress/i18n';

export default {
	id: 'aggregator',
	label: __( 'Aggregator', 'newspack-nodes' ),
	host: 'hub',
	slug: 'aggregator',
	order: 40,
};
