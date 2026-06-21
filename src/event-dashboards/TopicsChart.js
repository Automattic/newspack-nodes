/**
 * TopicsChart — one Tachikoma-style Topics panel (Message Rate / Byte Rate /
 * Backlog): a d3 multi-series overlaid-area time chart with X/Y axes, an
 * interactive hover tooltip, and a ranked color legend. Built on the SHARED
 * charting infra (`@newspack-nodes/shared/hooks/useTimeChart`) the event-logger
 * dashboards use — same grid/legend/colors/mouseover — so this is a thin
 * renderer modeled on the event-logger's `CategoryTimeChart`.
 *
 * Fed by `topicChartSeries`: `{ [topic]: { points:[{ts,value}], max, avg } }`
 * (ts in seconds). The topics' samples sweep together, but to draw + hover
 * cleanly we align every topic onto ONE sorted date axis (the union of sample
 * ts), filling gaps with 0.
 */

import { memo, useCallback, useMemo } from '@wordpress/element';
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

const HEIGHT = 200;
// A panel is ~1800px wide, so a denser axis than this is sub-pixel; capping here
// is what keeps the d3 redraw cheap (the 24h union is ~30k points/topic).
const MAX_POINTS = 1000;

// Memoized: d3-driven and re-rendered by Overview on every drag-reorder frame;
// the memoized `series` props are stable mid-drag, so it skips the redraw.
export const TopicsChart = memo( function TopicsChart( {
	title,
	series,
	formatValue,
} ) {
	const chartState = useMemo(
		() => buildAlignedSeries( series, MAX_POINTS ),
		[ series ]
	);

	const renderFn = useCallback(
		( refs ) => {
			if (
				! refs.containerRef.current ||
				chartState.series.length === 0
			) {
				return;
			}
			const { series: aligned, dates } = chartState;

			d3.select( refs.containerRef.current ).selectAll( '*' ).remove();

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
				.call( d3.axisBottom( x ).ticks( 8 ).tickFormat( formatXTick ) )
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
				const color = PALETTE[ i % PALETTE.length ];
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
							value: formatValue( s.values[ idx ]?.value || 0 ),
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
					color: PALETTE[ i % PALETTE.length ],
					label: s.label,
				} ) ),
				width
			);
		},
		[ chartState, formatValue ]
	);

	const { containerRef, tooltipRef } = useTimeChart( renderFn );

	return (
		<div className="nodes-topics">
			<div className="nodes-topics__title">{ title }</div>
			<div ref={ containerRef } className="nodes-topics__chart" />
			<div ref={ tooltipRef } className="nodes-topics__tooltip" />
		</div>
	);
} );
