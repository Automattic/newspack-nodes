/**
 * TopicsChart — one Tachikoma-style Topics panel (Message Rate / Byte Rate /
 * Backlog): a d3 multi-series overlaid-area time chart with X/Y axes, an
 * interactive hover tooltip, and a ranked color legend. Built on the SHARED
 * charting infra (`@newspack-nodes/shared/hooks/useTimeChart`) the event-logger
 * dashboards use — same grid/legend/colors/mouseover — so this is a thin
 * renderer modeled on the event-logger's `CategoryTimeChart`.
 *
 * Fed by `topicChartSeries`: `{ [topic]: { points:[{ts,value}], max, avg } }`
 * (ts in seconds), plus a `fillMode` from `fillModeForMetric`. To draw + hover
 * cleanly `buildAlignedSeries` snaps every topic onto ONE epoch-aligned bucket
 * grid and fills empty buckets per that mode (LEVEL gauges hold, rates zero).
 */

import { memo, useCallback, useMemo, useRef } from '@wordpress/element';
import * as d3 from 'd3';
import {
	MARGIN,
	PALETTE,
	drawLegend,
	formatXTick,
	setupTooltip,
	useTimeChart,
} from '@newspack-nodes/shared/hooks/useTimeChart';
import { buildAlignedSeries } from './buildAlignedSeries';
import { resolveChartPalette } from './resolveChartPalette';
import { useThemeToken } from './useThemeToken';

const HEIGHT = 200;
// Panel ~1800px wide; denser than this is sub-pixel. Caps the d3 redraw cost.
const MAX_POINTS = 1000;

// Memoized: d3-driven; Overview re-renders each drag frame, stable series skip.

// JSDoc rides the inner function: on the const, memo() infers props as `{}`.
export const TopicsChart = memo(
	/**
	 * One Topics panel: ranked overlaid areas over a shared aligned time axis.
	 *
	 * @param {Object}                 props             Component props.
	 * @param {string}                 props.title       Panel heading, e.g. "Topics Message Rate".
	 * @param {?Object}                props.series      `{ [topic]: { points:[{ts,value}], max, avg } }` from `topicChartSeries` (ts in seconds).
	 * @param {(value:number)=>string} props.formatValue Formats a value for the Y-axis ticks and the tooltip rows.
	 * @param {Object}                 [props.fillMode]  Fill/aggregate mode from `fillModeForMetric`; RATE zero-fill when omitted.
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
				// Empty series (after a stats reset): wipe prior render, stop.
				if ( chartState.series.length === 0 ) {
					d3.select( refs.containerRef.current )
						.selectAll( '*' )
						.remove();
					return;
				}
				const { series: aligned, dates } = chartState;

				d3.select( refs.containerRef.current )
					.selectAll( '*' )
					.remove();

				const width = refs.containerRef.current.clientWidth || 800;
				const innerW = width - MARGIN.left - MARGIN.right;
				const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

				const svg = d3
					.select( refs.containerRef.current )
					.append( 'svg' )
					.attr( 'width', width )
					.attr( 'height', HEIGHT );
				const g = svg
					.append( 'g' )
					.attr(
						'transform',
						`translate(${ MARGIN.left },${ MARGIN.top })`
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

				g.append( 'g' )
					.attr( 'transform', `translate(0,${ innerH })` )
					.call(
						d3.axisBottom( x ).ticks( 8 ).tickFormat( formatXTick )
					)
					.selectAll( 'text' )
					.attr( 'transform', 'rotate(-45)' )
					.style( 'text-anchor', 'end' );

				g.append( 'g' )
					.call(
						d3
							.axisLeft( y )
							.ticks( 5 )
							.tickFormat( ( v ) => formatValue( v ) )
					)
					.selectAll( 'text' )
					.style( 'font-size', '10px' );

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
			// `theme` is the re-resolution trigger; changes renderFn identity.
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
