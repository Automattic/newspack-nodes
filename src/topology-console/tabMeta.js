/**
 * Topology Console hub-tab descriptor — every field of the DevTools tab except
 * the component. `./tabs` spreads it into the registration the bundle performs;
 * `devtools-hub/lazyTabs` spreads it into the placeholder that stands in until
 * that bundle arrives, so the label, the sort position, the `?tab=console` deep
 * link and the `fullBleed` flag resolve identically either way. Two spellings
 * would rename, reorder or duplicate the tab the moment the bundle loads.
 *
 * The descriptor sits apart from `./tabs` so that importing it pulls the label
 * string alone and no `TopologyConsole` tree. The hub would otherwise load on
 * every page view the bundle the lazy registration exists to defer.
 */

import { __ } from '@wordpress/i18n';

/**
 * The tab descriptor, minus the `component` each consumer supplies.
 *
 * `id` is the registry key, so the bundle's own `registerDevtoolsTab` shadows
 * the lazy placeholder rather than adding a second tab beside it. `slug` is
 * shorter than that id, keeping the deep link at `?tab=console`. `param` claims
 * `?topology=<name>`, which the Console reads on mount and rewrites as the open
 * topology changes; the host drops it from the URL while another tab shows.
 * Order 15 seats the tab between Jobs (10) and the Partition Viewer (20).
 *
 * `fullBleed` hands the Console the bare tab pane — a flex column with
 * `overflow: hidden` — instead of the host's vertical scroll container. The
 * canvas sizes and scrolls itself, so the default container would wrap it in a
 * second, outer scrollbar.
 */
export default {
	id: 'topology-console',
	label: __( 'Console', 'newspack-nodes' ),
	host: 'hub',
	slug: 'console',
	param: 'topology',
	order: 15,
	fullBleed: true,
};
