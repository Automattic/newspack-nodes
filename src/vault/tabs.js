/**
 * Register the Vault hub DevTools tab (order 30). Imported (for its side effect)
 * by the vault bundle entry so the tab registers wherever the bundle loads (the
 * Hub page enqueues it via the `newspack_nodes/devtools_tab_bundles` filter).
 */

import { __ } from '@wordpress/i18n';
import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import VaultAdmin from './VaultAdmin';
import './nodes/register';

registerDevtoolsTab( {
	id: 'vault',
	label: __( 'Vault', 'newspack-nodes' ),
	host: 'hub',
	slug: 'vault',
	order: 30,
	component: VaultAdmin,
} );
