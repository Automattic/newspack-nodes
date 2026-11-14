/**
 * The substrate's six shared blocks, by block name: the views map a consumer
 * spreads into its own when a context it declares admits them, so a page
 * admitting none of these loads none of them. Each source block reads the
 * source its `source` attribute names;
 * `Composition::declare_substrate_blocks()` declares their attributes.
 */

import logStream from './log-stream';
import section from './section';
import sparkline from './sparkline';
import stats from './stats';
import table from './table';
import timeChart from './time-chart';

/**
 * Block name => its View and inspector Controls, for each source block and
 * the section.
 *
 * @type {Object<string,import('../composition/CompositionView').CompositionBlockView>}
 */
export const SUBSTRATE_VIEWS = {
	'newspack-nodes/stats': stats,
	'newspack-nodes/time-chart': timeChart,
	'newspack-nodes/table': table,
	'newspack-nodes/log-stream': logStream,
	'newspack-nodes/sparkline': sparkline,
	'newspack-nodes/section': section,
};
