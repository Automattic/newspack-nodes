/**
 * Vault hub-tab descriptor — every field of the DevTools tab except the
 * component. `./tabs` spreads it into the registration the bundle performs;
 * `devtools-hub/lazyTabs` spreads it into the placeholder that stands in until
 * that bundle arrives, so the label, the sort position and the `?tab=vault`
 * deep link resolve identically either way. Two spellings would rename,
 * reorder or duplicate the tab the moment the bundle loads.
 *
 * The descriptor sits apart from `./tabs` so that importing it pulls the label
 * string alone and no `VaultAdmin` tree. The hub would otherwise load on every
 * page view the bundle the lazy registration exists to defer.
 *
 * Order 30 ties with Config Audit, which the registry settles alphabetically
 * by label: Config Audit takes the earlier seat, and Sessions follows at 35.
 */

import { __ } from '@wordpress/i18n';

/**
 * The tab descriptor, minus the `component` each consumer supplies.
 *
 * `id` is the registry key, so the bundle's own `registerDevtoolsTab` shadows
 * the lazy placeholder rather than adding a second tab beside it. `host` keeps
 * the tab on the hub and off the debug overlay: every `Vault_CI` verb behind
 * this view gates at `manage`, so the credential store is an operator surface
 * rather than a page-level debugging aid.
 */
export default {
	id: 'vault',
	label: __( 'Vault', 'newspack-nodes' ),
	host: 'hub',
	slug: 'vault',
	order: 30,
};
