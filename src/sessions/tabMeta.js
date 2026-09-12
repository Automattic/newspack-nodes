/**
 * Sessions station-tab descriptor — every field of the tab except the
 * component. `./tabs` spreads it into the registration the bundle performs;
 * `station/lazyTabs` spreads it into the placeholder that stands in until
 * that bundle arrives, so the label, the sort position and the `?tab=sessions`
 * deep link resolve identically either way. Two spellings would rename,
 * reorder or duplicate the tab the moment the bundle loads.
 *
 * The descriptor sits apart from `./tabs` so that importing it pulls the label
 * string alone and no `SessionsAdmin` tree. The station would otherwise load on
 * every page view the bundle the lazy registration exists to defer.
 *
 * Order 35 places the tab after Vault (30) and before the Aggregator (40).
 * Vault and Sessions are mirrors: Vault holds the credentials this site sends
 * OUT, Sessions the command sessions it hands to callers coming IN.
 */

import { __ } from '@wordpress/i18n';

/**
 * The tab descriptor, minus the `component` each consumer supplies.
 *
 * `id` is the registry key, so the bundle's own `registerTab` shadows
 * the lazy placeholder rather than adding a second tab beside it. `host` keeps
 * the tab on the station and off the debug overlay: every `Sessions_CI` verb behind
 * this view requires the `manage` capability, so the directory is an operator
 * surface rather than a page-level debugging aid.
 */
export default {
	id: 'sessions',
	label: __( 'Sessions', 'newspack-nodes' ),
	host: 'station',
	slug: 'sessions',
	order: 35,
};
