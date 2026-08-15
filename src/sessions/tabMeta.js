/**
 * Sessions hub-tab descriptor — everything but the component. Shared by
 * `./tabs` (full registration when the bundle loads) and the hub's lazy
 * placeholder, so the tab bar identity matches before the bundle loads.
 *
 * Order 35 puts it directly after Vault: the two are mirrors — Vault holds the
 * credentials this site sends OUT, Sessions the ones it hands to callers
 * coming IN.
 */

import { __ } from '@wordpress/i18n';

export default {
	id: 'sessions',
	label: __( 'Sessions', 'newspack-nodes' ),
	host: 'hub',
	slug: 'sessions',
	order: 35,
};
