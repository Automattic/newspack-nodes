/**
 * The time-chart block, and `TimeChart`, the one panel every dashboard time
 * chart draws: the shared `AreaTimeChart` over each series' aligned points,
 * ranked by peak and coloured by rank.
 *
 * Nothing here knows which metric it draws, so one component serves the
 * station's Overview, Jobs and Tables panels, the debug overlay's two and
 * every time-chart block. The metric arrives as data: the `series` to draw,
 * each carrying the `mode` saying how a slot aggregates its points and what
 * an empty one holds, plus the `step` of the bucket grid its points sit on,
 * the `yLabel` naming the quantity, and the formatter its axis ticks and
 * tooltip rows print through: a fixed `formatValue`, or a `formatFor( peak )`
 * that picks one unit for the whole axis from what the panel draws, as
 * `axisDuration` does for a latency. A panel holding a `mean` series never
 * stacks, because means never add up.
 * `topicChartSeries` builds the series on the dashboards,
 * `overviewChartSeries` in the overlay, and a block's source names them as
 * the metrics it declares: each metric's model is a series map, and the
 * block draws the series of every metric it names.
 *
 * `buildAlignedSeries` snaps every topic onto ONE epoch-aligned bucket grid
 * first, because each worker runs its own `Topic_Probe` on an independent 15s
 * phase and the raw union of their sample instants leaves each topic gapped at
 * every other topic's instant. A probe series is folded onto that grid
 * already, 180 seconds to a point, and keeps it. The rank order that comes back
 * indexes the colours and the legend, and each rank's colour is the skin's own
 * `--chart-*` token (`chartColor`), so the panel re-skins with the page
 * through CSS alone.
 */

import {
	memo,
	useCallback,
	useDeferredValue,
	useMemo,
} from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { chartColor } from '../hooks/useTimeChart';
import AreaTimeChart from '../components/AreaTimeChart';
import { buildAlignedSeries } from '../utils/buildAlignedSeries';
import { formatGroupedCount } from '../utils/formatters';
import { fieldValue, sourceBlock } from './sourceBlock';
import './time-chart.scss';

/** @typedef {import('../utils/axis-ticks').AxisFormatter} AxisFormatter */

/** Total SVG height of one panel, in pixels, axis margins included. */
const HEIGHT = 200;

/**
 * Hard cap on the axis length `buildAlignedSeries` produces.
 *
 * A panel is half a row, about 900px wide, so 500 slots keep each nearly two
 * pixels wide; a denser axis buys nothing but d3 redraw time. The 24h window
 * holds at most 481 probe buckets, so a probe panel's axis is never widened.
 */
const MAX_POINTS = 500;

/**
 * The colour a topic takes from its rank in the full list.
 *
 * @param {string} _label The topic; the rank alone decides.
 * @param {number} index  Its place in the ranking.
 * @return {string} A CSS colour value.
 */
const rankColor = ( _label, index ) => chartColor( index );

export const TimeChart = memo(
	/**
	 * One panel: ranked areas over a shared aligned time axis.
	 *
	 * The JSDoc rides this inner function because `memo()` on the const infers
	 * the props as `{}`. The `memo` keeps the redraw off unrelated renders: a
	 * panel rebuilds its whole SVG from scratch every time, while Overview
	 * re-renders on each poll tick, fold, expand and reorder. Callers hand over
	 * props stable across those renders — a memoized `series` and module-level
	 * formatters — so a panel whose own inputs did not move skips the draw
	 * entirely.
	 *
	 * @param {Object}                            props               Component props.
	 * @param {string}                            props.title         Panel heading, e.g. "Topics Messages Read".
	 * @param {string}                            props.storageKey    Unique, untranslated chart name; see AreaTimeChart.
	 * @param {string}                            props.yLabel        Y-axis title naming the quantity, e.g. "Messages"; the ticks carry the unit.
	 * @param {?Object}                           props.series        `{ [topic]: { points:[{ts,value,weight}], max, mode?, step? } }` (ts in seconds); empty or absent wipes the panel.
	 * @param {AxisFormatter}                     [props.formatValue] Formats a value for the Y-axis ticks and the tooltip rows, whatever the peak; a `tickValues` property on it ticks the axis in its own unit.
	 * @param {( peak: number ) => AxisFormatter} [props.formatFor]   Builds that formatter from the peak drawn, in place of `formatValue`.
	 * @param {boolean}                           [props.stacked]     Stack the series by default, for series that add up into a total; the corner toggle still flips it.
	 * @return {import('react').ReactElement} The rendered panel.
	 */
	function TimeChart( {
		title,
		storageKey,
		yLabel,
		series,
		formatValue,
		formatFor,
		stacked = false,
	} ) {
		const chartState = useMemo(
			() => buildAlignedSeries( series, MAX_POINTS ),
			[ series ]
		);
		// Means never add up, so a panel holding one never stacks.
		const stackable = ! Object.values( series ?? {} ).some(
			( one ) => 'mean' === one.mode?.agg
		);
		const fixed = useCallback( () => formatValue, [ formatValue ] );
		const yFormatFor = formatFor ?? fixed;

		return (
			<div className="newspack-nodes-card nodes-topics">
				<AreaTimeChart
					series={ chartState.series }
					yFormatFor={ yFormatFor }
					colorAt={ rankColor }
					title={ title }
					storageKey={ storageKey }
					yLabel={ yLabel }
					height={ HEIGHT }
					stacked={ stackable && stacked }
					stackable={ stackable }
					totalLabel={ __( 'Total', 'newspack-nodes' ) }
				/>
			</div>
		);
	}
);

/**
 * A tab's panels, one `TimeChart` per declaration.
 *
 * A declaration is `{ title, storageKey, yLabel, series, formatValue |
 * formatFor, stacked? }`, keyed by its `storageKey`, since a
 * translated title can repeat. The array may be rebuilt per render, but each
 * `series` must stay a memoized object, and a `formatFor` a module-level
 * function, or the chart's memo redraws.
 *
 * @param {Object}        props        Component props.
 * @param {Array<Object>} props.panels Panel declarations, drawn in order.
 * @return {import('react').ReactElement} The charts, two to a grid row.
 */
export function TimeChartPanels( { panels } ) {
	return (
		<div className="nodes-topics-panels">
			{ panels.map( ( panel ) => (
				<TimeChart key={ panel.storageKey } { ...panel } />
			) ) }
		</div>
	);
}

/**
 * The block: one panel over the series of every metric it names, every
 * declared series when it names nothing, the axis titled by the first
 * metric's `axis`, else its label, and printed through its `formatFor`, else
 * its `format`. The model is deferred, so a redraw stays off the input path. A metric's model is a series map; with
 * more than one metric, each series is named after its metric too, and the
 * panel redraws whenever the model moves.
 *
 * @param {Object}                               props
 * @param {Object}                               props.attributes `{ source, metrics, stacked, title }`.
 * @param {Object}                               props.model      The source's model.
 * @param {import('./sourceBlock').BlockField[]} props.fields     The metrics drawn.
 * @return {import('react').ReactElement} The panel.
 */
function TimeChartBlock( { attributes, model: live, fields } ) {
	const { source, stacked, title } = attributes;
	const model = useDeferredValue( live );
	// One metric's map passes as held, so a moving model redraws nothing.
	const drawn =
		1 === fields.length ? fieldValue( fields[ 0 ], model ) : model;
	const series = useMemo(
		() =>
			1 === fields.length
				? drawn ?? {}
				: Object.fromEntries(
						fields.flatMap( ( field ) =>
							Object.entries(
								fieldValue( field, model ) ?? {}
							).map( ( [ label, one ] ) => [
								`${ field.label }: ${ label }`,
								one,
							] )
						)
				  ),
		[ drawn, fields, model ]
	);
	const [ first ] = fields;
	return (
		<TimeChart
			title={
				title || fields.map( ( field ) => field.label ).join( ' · ' )
			}
			storageKey={ `newspack-nodes:time-chart:${ source }:${ fields
				.map( ( field ) => field.key )
				.join( ',' ) }` }
			yLabel={ first.axis ?? first.label }
			series={ series }
			formatValue={ first.format ?? formatGroupedCount }
			formatFor={ first.formatFor }
			stacked={ stacked }
		/>
	);
}

export default sourceBlock( TimeChartBlock, {
	kind: 'series',
	list: 'metrics',
	settings: [ 'title', 'stacked' ],
} );
