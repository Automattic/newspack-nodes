/**
 * Register the Aggregator hub DevTools tab (order 40). Imported (for its side
 * effect) by the aggregator bundle entry so the tab registers wherever the
 * bundle loads (the Hub page enqueues it via the
 * `newspack_nodes/devtools_tab_bundles` filter). The hub supplies the page
 * chrome + DebugOverlay, so the registered component is the inner
 * AggregatorStatus, not a page wrapper.
 */

import { __ } from '@wordpress/i18n';
import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import AggregatorStatus from './AggregatorStatus';
import './nodes/register';

registerDevtoolsTab( {
	id: 'aggregator',
	label: __( 'Aggregator', 'newspack-nodes' ),
	host: 'hub',
	slug: 'aggregator',
	order: 40,
	component: AggregatorStatus,
} );
