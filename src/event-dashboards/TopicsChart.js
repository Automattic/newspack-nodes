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
 * The frame, grid, palette, legend and tooltip belong to the shared
 * `@newspack-nodes/shared/hooks/useTimeChart` every dashboard chart draws
 * through, which leaves this file the panel-specific half: the aligned model,
 * the areas and the themed colors.
 *
 * `buildAlignedSeries` snaps every topic onto ONE epoch-aligned bucket grid
 * first, because each worker runs its own `Topic_Probe` on an independent 15s
 * phase and the raw union of their sample instants leaves each topic gapped at
 * every other topic's instant.
 */

import { memo, useCallback, useMemo, useRef } from '@wordpress/element';
import * as d3 from 'd3';
import {
	PALETTE,
	drawAxes,
	drawLegend,
	openFrame,
	setupTooltip,
	useTimeChart,
} from '@newspack-nodes/shared/hooks/useTimeChart';
import { buildAlignedSeries } from './buildAlignedSeries';
import { resolveChartPalette } from './resolveChartPalette';
import { useThemeToken } from './useThemeToken';

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

		// Anchor in the themed cascade so series colors re-skin with the theme.
		const themeRef = useRef( null );
		const theme = useThemeToken();

		/**
		 * Redraw the panel from scratch. `openFrame` wipes the container, then
		 * the scales, areas, axes, tooltip and legend are rebuilt over the
		 * aligned model; d3 holds no update join, so there is nothing to diff
		 * against. The theme's `--chart-*` tokens are resolved per pass rather
		 * than captured, which is why re-running this is all a skin needs.
		 *
		 * @param {Object} refs The container, tooltip and mouse refs `useTimeChart` owns.
		 */
		const renderFn = useCallback(
			( refs ) => {
				if ( ! refs.containerRef.current ) {
					return;
				}
				const el = themeRef.current;
				const palette = el
					? resolveChartPalette( ( name ) =>
							window
								.getComputedStyle( el )
								.getPropertyValue( name )
					  )
					: PALETTE;
				// Empty series: wipe the render so a reset clears the panel.
				if ( chartState.series.length === 0 ) {
					d3.select( refs.containerRef.current )
						.selectAll( '*' )
						.remove();
					return;
				}
				const { series: aligned, dates } = chartState;

				const { svg, g, width, innerW, innerH } = openFrame(
					refs.containerRef.current,
					HEIGHT
				);

				const x = d3
					.scaleTime()
					.domain( d3.extent( dates ) )
					.range( [ 0, innerW ] );
				const maxVal =
					d3.max( aligned, ( s ) =>
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

				aligned.forEach( ( s, i ) => {
					const color = palette[ i % palette.length ];
					g.append( 'path' )
						.datum( s.values )
						.attr( 'fill', color )
						.attr( 'fill-opacity', 0.4 )
						.attr( 'stroke', color )
						.attr( 'stroke-width', 1 )
						.attr( 'd', area );
				} );

				setupTooltip( g, {
					innerW,
					innerH,
					dates,
					x,
					formatEntry: ( idx ) =>
						aligned
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

				drawLegend(
					svg,
					aligned.map( ( s, i ) => ( {
						color: palette[ i % palette.length ],
						label: s.label,
					} ) ),
					width
				);
			},
			// Unused below: `theme` re-identifies renderFn on a skin change.
			// eslint-disable-next-line react-hooks/exhaustive-deps
			[ chartState, formatValue, theme ]
		);

		const { containerRef, tooltipRef } = useTimeChart( renderFn );

		return (
			<div ref={ themeRef } className="newspack-nodes-card nodes-topics">
				<div className="nodes-topics__title">{ title }</div>
				<div ref={ containerRef } className="nodes-topics__chart" />
				<div
					ref={ tooltipRef }
					className="newspack-nodes-card newspack-nodes-card--elevated nodes-topics__tooltip"
				/>
			</div>
		);
	}
);
