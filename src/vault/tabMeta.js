/**
 * Vault hub-tab descriptor — everything but the component. Shared by `./tabs`
 * (full registration when the bundle loads) and the hub's lazy placeholder so
 * the tab bar identity matches before the bundle loads.
 */

import { __ } from '@wordpress/i18n';

export default {
	id: 'vault',
	label: __( 'Vault', 'newspack-nodes' ),
	host: 'hub',
	slug: 'vault',
	order: 30,
};
