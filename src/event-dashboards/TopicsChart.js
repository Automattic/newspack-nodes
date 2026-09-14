/**
 * One Topics panel: a d3 chart overlaying each topic's area on a shared time
 * axis, ranked by peak, with X/Y axes, a hover tooltip and a color legend.
 *
 * Nothing here knows which metric it draws, so one component serves the
 * Overview dashboard's four panels (message rate, byte rate, backlog, cache
 * size), the Jobs dashboard's four, and the debug overlay's two. The metric
 * arrives as data: the `series` to draw, the `formatValue` its axis ticks and
 * tooltip rows print through, and the `fillMode` saying how a bucket aggregates
 * its samples and what an empty one holds. `topicChartSeries` builds the series
 * on the dashboards, `overviewChartSeries` in the overlay.
 *
 * The frame, grid, colours and tooltip belong to the shared
 * `@newspack-nodes/shared/hooks/useTimeChart` every dashboard chart draws
 * through, and the legend beside the plot is the shared `ChartLegend` over
 * `useLegend`, which leaves this file the panel-specific half: the aligned
 * model and the areas. A picked topic is drawn alone, in the colour its rank
 * gave it, and that colour is the skin's own `--chart-*` token (`chartColor`),
 * so the panel re-skins with the page through CSS alone.
 *
 * `buildAlignedSeries` snaps every topic onto ONE epoch-aligned bucket grid
 * first, because each worker runs its own `Topic_Probe` on an independent 15s
 * phase and the raw union of their sample instants leaves each topic gapped at
 * every other topic's instant.
 */

import { memo, useCallback, useMemo } from '@wordpress/element';
import * as d3 from 'd3';
import {
	chartColor,
	drawAxes,
	openFrame,
	setupTooltip,
	useTimeChart,
} from '@newspack-nodes/shared/hooks/useTimeChart';
import ChartLegend from '@newspack-nodes/shared/components/ChartLegend';
import { useLegend } from '@newspack-nodes/shared/hooks/useSeriesSelection';
import { buildAlignedSeries } from './buildAlignedSeries';

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
	 * One Topics panel: ranked overlaid areas over a shared aligned time axis.
	 *
	 * The JSDoc rides this inner function because `memo()` on the const infers
	 * the props as `{}`. The `memo` keeps the redraw off unrelated renders: a
	 * panel rebuilds its whole SVG from scratch every time, while Overview
	 * re-renders on each poll tick, fold, expand and reorder. Callers hand over
	 * props stable across those renders — a memoized `series`, module-level
	 * formatters, the shared `fillModeForMetric` constants — so a panel whose
	 * own inputs did not move skips the draw entirely.
	 *
	 * @param {Object}        props             Component props.
	 * @param {string}        props.title       Panel heading, e.g. "Topics Message Rate".
	 * @param {?Object}       props.series      `{ [topic]: { points:[{ts,value,weight}], max, avg } }` (ts in seconds); empty or absent wipes the panel.
	 * @param {AxisFormatter} props.formatValue Formats a value for the Y-axis ticks and the tooltip rows; a `tickValues` property on it ticks the axis in its own unit.
	 * @param {Object}        [props.fillMode]  Fill/aggregate mode from `fillModeForMetric`; an omitted mode zero-fills and re-divides per bucket, as a rate wants.
	 * @return {import('react').ReactElement} The rendered panel.
	 */
	function TopicsChart( { title, series, formatValue, fillMode } ) {
		const chartState = useMemo(
			() => buildAlignedSeries( series, MAX_POINTS, fillMode ),
			[ series, fillMode ]
		);
		const { legendItems, drawn, selected, onSelect } = useLegend(
			chartState.series,
			rankColor
		);

		/**
		 * Redraw the panel from scratch. `openFrame` wipes the container, then
		 * the scales, areas, axes and tooltip are rebuilt over the aligned
		 * model; d3 holds no update join, so there is nothing to diff against.
		 *
		 * @param {Object} refs The container, tooltip and mouse refs `useTimeChart` owns.
		 */
		const renderFn = useCallback(
			( refs ) => {
				if ( ! refs.containerRef.current ) {
					return;
				}
				// Empty series: wipe the render so a reset clears the panel.
				if ( chartState.series.length === 0 ) {
					d3.select( refs.containerRef.current )
						.selectAll( '*' )
						.remove();
					return;
				}
				const { dates } = chartState;

				const { g, innerW, innerH } = openFrame(
					refs.containerRef.current,
					HEIGHT
				);

				const x = d3
					.scaleTime()
					.domain( d3.extent( dates ) )
					.range( [ 0, innerW ] );
				const maxVal =
					d3.max( drawn, ( s ) =>
						d3.max( s.values, ( v ) => v.value )
					) || 1;
				const y = d3
					.scaleLinear()
					.domain( [ 0, maxVal * 1.1 ] )
					.range( [ innerH, 0 ] );

				drawAxes( g, {
					x,
					y,
					innerH,
					tickCount: dates.length,
					yFormat: formatValue,
				} );

				const area = d3
					.area()
					.x( ( d ) => x( d.date ) )
					.y0( innerH )
					.y1( ( d ) => y( d.value ) )
					.curve( d3.curveMonotoneX );

				drawn.forEach( ( s ) => {
					g.append( 'path' )
						.datum( s.values )
						.style( 'fill', s.color )
						.style( 'stroke', s.color )
						.attr( 'fill-opacity', 0.4 )
						.attr( 'stroke-width', 1 )
						.attr( 'd', area );
				} );

				setupTooltip( g, {
					innerW,
					innerH,
					dates,
					x,
					formatEntry: ( idx ) =>
						drawn
							.map( ( s ) => ( {
								label: s.label,
								value: formatValue(
									s.values[ idx ]?.value || 0
								),
								raw: s.values[ idx ]?.value || 0,
							} ) )
							.filter( ( e ) => e.raw > 0 )
							.sort( ( a, b ) => b.raw - a.raw )
							.slice( 0, 12 ),
					tooltipRef: refs.tooltipRef,
					lastMouseXRef: refs.lastMouseXRef,
					containerRef: refs.containerRef,
				} );
			},
			[ chartState, formatValue, drawn ]
		);

		const { containerRef, tooltipRef } = useTimeChart( renderFn );

		return (
			<div className="newspack-nodes-card nodes-topics">
				<div className="nodes-topics__title">{ title }</div>
				<div className="newspack-nodes-chart">
					<div
						ref={ containerRef }
						className="nodes-topics__chart newspack-nodes-chart__plot"
					/>
					<ChartLegend
						items={ legendItems }
						selected={ selected }
						onSelect={ onSelect }
						height={ HEIGHT }
					/>
				</div>
				<div
					ref={ tooltipRef }
					className="newspack-nodes-card newspack-nodes-card--elevated nodes-topics__tooltip"
				/>
			</div>
		);
	}
);
