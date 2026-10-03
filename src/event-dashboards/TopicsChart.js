/**
 * One Topics panel: the shared `AreaTimeChart` over each topic's aligned
 * series, ranked by peak and coloured by rank.
 *
 * Nothing here knows which metric it draws, so one component serves the
 * Overview dashboard's four panels (message rate, byte rate, backlog, cache
 * size), the Jobs dashboard's four, the Tables tab's five (ops rate, operation
 * rate, miss rate, latency, size), and the debug overlay's two. The metric
 * arrives as data: the `series` to draw, the `yLabel` naming the quantity, the
 * `formatValue` its axis ticks and tooltip rows print through, and the
 * `fillMode` saying how a bucket aggregates its samples and what an empty one
 * holds. `topicChartSeries` builds the series on the dashboards,
 * `overviewChartSeries` in the overlay.
 *
 * `buildAlignedSeries` snaps every topic onto ONE epoch-aligned bucket grid
 * first, because each worker runs its own `Topic_Probe` on an independent 15s
 * phase and the raw union of their sample instants leaves each topic gapped at
 * every other topic's instant. The rank order that comes back indexes the
 * colours and the legend, and each rank's colour is the skin's own `--chart-*`
 * token (`chartColor`), so the panel re-skins with the page through CSS alone.
 */

import { memo, useCallback, useMemo } from '@wordpress/element';
import { chartColor } from '@newspack-nodes/shared/hooks/useTimeChart';
import AreaTimeChart from '@newspack-nodes/shared/components/AreaTimeChart';
import { buildAlignedSeries } from './buildAlignedSeries';
import { fillModeForMetric } from './topicProbeSeries';

/** @typedef {import('@newspack-nodes/shared/utils/axis-ticks').AxisFormatter} AxisFormatter */

/** Total SVG height of one panel, in pixels, axis margins included. */
const HEIGHT = 200;

/**
 * Hard cap on the axis length `buildAlignedSeries` produces.
 *
 * A panel is about 1800px wide, so a denser axis is sub-pixel: the extra points
 * buy nothing but d3 redraw time.
 */
const MAX_POINTS = 1000;

/**
 * The colour a topic takes from its rank in the full list.
 *
 * @param {string} _label The topic; the rank alone decides.
 * @param {number} index  Its place in the ranking.
 * @return {string} A CSS colour value.
 */
const rankColor = ( _label, index ) => chartColor( index );

export const TopicsChart = memo(
	/**
	 * One Topics panel: ranked areas over a shared aligned time axis.
	 *
	 * The JSDoc rides this inner function because `memo()` on the const infers
	 * the props as `{}`. The `memo` keeps the redraw off unrelated renders: a
	 * panel rebuilds its whole SVG from scratch every time, while Overview
	 * re-renders on each poll tick, fold, expand and reorder. Callers hand over
	 * props stable across those renders — a memoized `series`, module-level
	 * formatters, the shared `fillModeForMetric` constants — so a panel whose
	 * own inputs did not move skips the draw entirely.
	 *
	 * @param {Object}        props              Component props.
	 * @param {string}        props.title        Panel heading, e.g. "Topics Message Rate".
	 * @param {string}        props.yLabel       Y-axis title naming the quantity, e.g. "Messages"; the ticks carry the unit.
	 * @param {?Object}       props.series       `{ [topic]: { points:[{ts,value,weight}], max } }` (ts in seconds); empty or absent wipes the panel.
	 * @param {AxisFormatter} props.formatValue  Formats a value for the Y-axis ticks and the tooltip rows; a `tickValues` property on it ticks the axis in its own unit.
	 * @param {Object}        [props.fillMode]   Fill/aggregate mode from `fillModeForMetric`; an omitted mode zero-fills and re-divides per bucket, as a rate wants.
	 * @param {boolean}       [props.stacked]    Stack the series by default, for series that add up into a total; the corner toggle still flips it.
	 * @param {boolean}       [props.stackable]  Offer the stack toggle; `false` for means, which never add up.
	 * @param {string}        [props.totalLabel] Translated label for the stacked tooltip's leading total row; omitted drops the row.
	 * @return {import('react').ReactElement} The rendered panel.
	 */
	function TopicsChart( {
		title,
		yLabel,
		series,
		formatValue,
		fillMode,
		stacked = false,
		stackable = true,
		totalLabel = '',
	} ) {
		const chartState = useMemo(
			() => buildAlignedSeries( series, MAX_POINTS, fillMode ),
			[ series, fillMode ]
		);
		// One unit for the whole panel, whatever the peak.
		const yFormatFor = useCallback( () => formatValue, [ formatValue ] );

		return (
			<div className="newspack-nodes-card nodes-topics">
				<AreaTimeChart
					series={ chartState.series }
					yFormatFor={ yFormatFor }
					colorAt={ rankColor }
					title={ title }
					yLabel={ yLabel }
					height={ HEIGHT }
					stacked={ stacked }
					stackable={ stackable }
					totalLabel={ totalLabel }
				/>
			</div>
		);
	}
);

/**
 * A tab's Topics panels, one `TopicsChart` per declaration.
 *
 * A declaration is `{ title, yLabel, series, formatValue, metric, stacked?,
 * stackable? }`: the `metric` picks the fill mode, and only a stacked panel
 * takes the total label. The array may be rebuilt per render, but each
 * `series` must stay a memoized object, or the chart's memo redraws.
 *
 * @param {Object}        props            Component props.
 * @param {Array<Object>} props.panels     Panel declarations, drawn in order.
 * @param {string}        props.totalLabel Translated label for each stacked panel's total row.
 * @return {import('react').ReactElement[]} One chart per declaration.
 */
export function TopicsPanels( { panels, totalLabel } ) {
	return panels.map( ( { metric, ...panel } ) => (
		<TopicsChart
			key={ panel.title }
			{ ...panel }
			fillMode={ fillModeForMetric( metric ) }
			totalLabel={ panel.stacked ? totalLabel : undefined }
		/>
	) );
}
