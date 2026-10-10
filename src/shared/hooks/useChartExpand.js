/**
 * The expand toggle every fixed-height time chart shares.
 *
 * A chart draws at `height`; its corner expand button doubles that, and the
 * same again restores it. The button is the only resize control: every
 * pointer gesture on the plot belongs to the chart. The hook returns the
 * effective height for the draw, the plot's minimum height and the legend,
 * and the props for the native button.
 */

import { __, sprintf } from '@wordpress/i18n';
import { usePersistedFlag } from './usePersistedState';

/** The height factor of an expanded chart. */
const EXPANDED_FACTOR = 2;

/**
 * @param {number} height     The chart's collapsed height in pixels.
 * @param {string} title      The chart's translated title, which names the button.
 * @param {string} storageKey The localStorage key holding the expansion; see AreaTimeChart.
 * @return {{height: number, buttonProps: Object}} The effective height, and the props to spread on the expand button.
 */
export function useChartExpand( height, title, storageKey ) {
	const [ expanded, , toggle ] = usePersistedFlag( storageKey, false );
	const label = expanded
		? // translators: %s: the chart's title.
		  sprintf( __( 'Shrink %s', 'newspack-nodes' ), title )
		: // translators: %s: the chart's title.
		  sprintf( __( 'Expand %s', 'newspack-nodes' ), title );

	return {
		height: expanded ? EXPANDED_FACTOR * height : height,
		buttonProps: {
			'aria-expanded': expanded,
			'aria-label': label,
			title: label,
			onClick: toggle,
		},
	};
}
