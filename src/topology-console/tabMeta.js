/**
 * Topology Console hub-tab descriptor — everything but the component. Shared by
 * `./tabs` (full registration when the bundle loads) and the hub's lazy
 * placeholder (so the tab bar + `?tab=` identity match before the bundle loads).
 * Importing this pulls no console component tree, only the label string.
 */

import { __ } from '@wordpress/i18n';

export default {
	id: 'topology-console',
	label: __( 'Console', 'newspack-nodes' ),
	host: 'hub',
	slug: 'console',
	param: 'topology',
	order: 15,
	fullBleed: true,
};
