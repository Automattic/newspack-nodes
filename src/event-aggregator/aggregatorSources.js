/**
 * The Aggregator page's sources, its page state and the blocks its layout is
 * composed of, for both the tab bundle and its layout editor, which each
 * import this module, so each bundle declares what it reads.
 *
 * Two polls on the hub's `aggregator` CI, each on its own reply path, so a
 * card list that fails leaves the header counts on screen: `summary`, the
 * counts, the server's clock and what will not read; and `list_servers`, the
 * cards. Both ask at the cadence the reader picked, the `refresh` page-state
 * key, which a first visit reads from the choice the browser kept; a new
 * cadence re-arms the same two polls in place.
 */

import { __ } from '@wordpress/i18n';
import { SUBSTRATE_VIEWS } from '@newspack-nodes/shared/blocks';
import { definePageState } from '@newspack-nodes/shared/composition/page/pageState';
import { registerSource } from '@newspack-nodes/shared/sources';
import { readStorage } from '@newspack-nodes/shared/utils/storage';
import { views } from './nodes/register';
import serverCards, {
	AGGREGATOR_CI,
	AGGREGATOR_GROUP,
} from './blocks/server-cards';

/** The localStorage key the chosen cadence outlives the page under. */
export const REFRESH_KEY = 'aggregator-status-refresh';

/**
 * The cadences the picker offers, milliseconds as strings, each clearing
 * the 1000ms floor below which a Timer leaves the Router's tick.
 */
export const REFRESH_OPTIONS = [
	{ label: '1s', value: '1000' },
	{ label: '2s', value: '2000' },
	{ label: '5s', value: '5000' },
	{ label: '10s', value: '10000' },
];

/** The cadence a first visit polls at. */
const DEFAULT_REFRESH_MS = '2000';

definePageState( {
	refresh: {
		default:
			REFRESH_OPTIONS.find(
				( option ) => option.value === readStorage( REFRESH_KEY )
			)?.value ?? DEFAULT_REFRESH_MS,
	},
} );

registerSource( 'nodes/aggregator-summary', {
	label: __( 'Aggregator summary', 'newspack-nodes' ),
	kind: 'poll',
	group: AGGREGATOR_GROUP,
	ci: AGGREGATOR_CI,
	command: 'summary',
	viewClass: views.AggregatorSummaryView,
	intervalMs: Number( DEFAULT_REFRESH_MS ),
	cadence: 'refresh',
	fields: {
		connected: {
			label: __( 'Spokes connected', 'newspack-nodes' ),
			kind: 'value',
			format: String,
		},
		idle: {
			label: __( 'Spokes idle', 'newspack-nodes' ),
			kind: 'value',
			format: String,
		},
		total: {
			label: __( 'Spokes', 'newspack-nodes' ),
			kind: 'value',
			format: String,
		},
	},
} );

registerSource( 'nodes/aggregator-servers', {
	label: __( 'Aggregator servers', 'newspack-nodes' ),
	kind: 'poll',
	group: AGGREGATOR_GROUP,
	ci: AGGREGATOR_CI,
	command: 'list_servers',
	viewClass: views.AggregatorServersView,
	intervalMs: Number( DEFAULT_REFRESH_MS ),
	cadence: 'refresh',
} );

/**
 * Every block the Aggregator layout may hold, by block name.
 *
 * @type {Object<string,import('@newspack-nodes/shared/composition/CompositionView').CompositionBlockView>}
 */
export const BLOCK_VIEWS = {
	...SUBSTRATE_VIEWS,
	'newspack-nodes/server-cards': serverCards,
};
