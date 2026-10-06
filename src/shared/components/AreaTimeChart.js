/**
 * The one area-chart frame every dashboard time chart draws on.
 *
 * Axes, areas, tooltip, legend and the stack toggle over a series list already
 * sampled at the caller's slot resolution: the Topics panels hand it aligned
 * probe series, event-logger-nodes' Aggregate and Category charts request
 * metrics and profile-category timings. `stacked` names the caller's default
 * mark — stacked bands where the series add up, overlaid translucent areas
 * where they do not (averages) — and the button in the chart's corner lets the
 * reader flip it for this chart alone, until the caller's default moves: a pick
 * answers the default it was made against, so a chart switched to a metric with
 * another default follows that metric. A caller whose bands must never be
 * summed, because one counts inside another, declines the toggle with
 * `stackable={ false }`. The legend beside the plot picks series
 * through the shared `useLegend`; a picked series is drawn alone, the axis
 * rescaled to it, in the colour its place in the full list gave it.
 *
 * The expand button beside the stack toggle doubles the chart's height, and
 * the same again restores it; shift+clicking the plot is its mouse shortcut
 * (`useChartExpand`). A click on the plot hands the nearest slot's index to
 * `onSlotClick`, so a caller can map it to its own bucket, with `additive`
 * true when cmd or ctrl was held; without the callback a click does nothing.
 * `selectedSlots` shades the caller's selection beneath the bands.
 *
 * Every label arrives already translated. The component words only its own
 * two toggles, so `__()` keeps its literal arguments at each call site. That is
 * also why the tooltip's column total rides on `totalLabel` rather than on a
 * flag: naming the row is the caller's job, and the row prints only while the
 * bands are stacked, since a sum of overlaid averages is not a total.
 */

import { memo, useCallback, useMemo, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import * as d3 from 'd3';
import {
	drawAxes,
	openFrame,
	setupTooltip,
	shadeSlots,
	useTimeChart,
} from '../hooks/useTimeChart';
import { useChartExpand } from '../hooks/useChartExpand';
import { useLegend } from '../hooks/useSeriesSelection';
import ChartLegend from './ChartLegend';

/** How many series the tooltip lists for a column, largest first. */
const TOOLTIP_ROWS = 12;

/** Pixel radius of the dot marking a measured slot between two gaps. */
const LONE_POINT_RADIUS = 2;

/**
 * One slot's value on one series; a missing or unmeasured (null) slot reads
 * as 0, so it adds nothing to a peak or a tooltip row.
 *
 * @param {{values: Array<{value?: number}>}} s   The series.
 * @param {number}                            idx The slot.
 * @return {number} The value.
 */
const valueAt = ( s, idx ) => s.values[ idx ]?.value || 0;

/**
 * The peak a series list reaches across its slots: the stack's total where
 * the series add up, else the tallest single band. Plain arithmetic rather
 * than `d3.max`, so the formatter this feeds always gets a number.
 *
 * @param {Array<{values: Array<{value?: number}>}>} list    The series, sharing one slot list.
 * @param {boolean}                                  stacked Whether the series add up.
 * @return {number} The peak; 0 for an empty list.
 */
const peakOf = ( list, stacked ) => {
	const slots = list[ 0 ]?.values.length ?? 0;
	let peak = 0;
	for ( let idx = 0; idx < slots; idx++ ) {
		let total = 0;
		for ( const s of list ) {
			const v = valueAt( s, idx );
			total += v;
			if ( ! stacked && v > peak ) {
				peak = v;
			}
		}
		if ( stacked && total > peak ) {
			peak = total;
		}
	}
	return peak;
};

/**
 * The stack glyph: three bands, one on another.
 *
 * @return {import('react').ReactElement} A 12px icon.
 */
const StackIcon = () => (
	<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
		<rect x="1" y="1" width="10" height="3" />
		<rect x="1" y="5" width="10" height="3" opacity="0.7" />
		<rect x="1" y="9" width="10" height="2" opacity="0.4" />
	</svg>
);

/**
 * The expand glyph: a double arrow spanning the chart's height.
 *
 * @return {import('react').ReactElement} A 12px icon.
 */
const ExpandIcon = () => (
	<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
		<path d="M6 0 L10 4 H7 V8 H10 L6 12 L2 8 H5 V4 H2 Z" />
	</svg>
);

/**
 * @param {Object}                                                               props                 Component props.
 * @param {Array<{label: string, values: Array<{date: Date, value?: ?number}>}>} props.series          Every series shares one slot list; a null value is unmeasured and draws as a gap.
 * @param {( peak: number ) => import('../utils/axis-ticks').AxisFormatter}      props.yFormatFor      Builds a formatter for a peak. Called for the DRAWN peak, which the axis and the series rows read, so a picked series takes its own unit; and, where `totalLabel` is set, once more for the whole list's peak, which the tooltip's total row reads.
 * @param {( label: string, index: number ) => string}                           props.colorAt         The colour for a series at its place in the full list: area, stroke and legend swatch.
 * @param {string}                                                               props.title           Translated heading.
 * @param {number}                                                               props.height          Collapsed SVG height in pixels; the expand button doubles it.
 * @param {string}                                                               props.yLabel          Translated Y-axis title naming the quantity; the ticks carry the unit.
 * @param {boolean}                                                              [props.stacked]       Stack the series by default; the corner toggle overrides it until the default moves.
 * @param {boolean}                                                              [props.stackable]     Offer the toggle at all; `false` for bands that must not be summed.
 * @param {string}                                                               [props.totalLabel]    Translated label for the tooltip's leading column-total row, printed while the bands are stacked; omitted drops the row.
 * @param {string}                                                               [props.className]     Class for the chart element, beside the shared role.
 * @param {import('../hooks/useTimeChart').SlotClick}                            [props.onSlotClick]   Takes a click's nearest slot, as an index into `series[0].values`, and whether cmd or ctrl made it additive.
 * @param {ReadonlySet<number>}                                                  [props.selectedSlots] Indexes into `series[0].values` to shade; absent or empty shades none.
 * @return {import('react').ReactElement} Rendered chart.
 */
function AreaTimeChart( {
	series,
	yFormatFor,
	colorAt,
	title,
	height: collapsedHeight,
	yLabel,
	stacked: stackedDefault = false,
	stackable = true,
	totalLabel = '',
	className,
	onSlotClick,
	selectedSlots,
} ) {
	const { height, plotProps, buttonProps } = useChartExpand(
		collapsedHeight,
		title
	);
	// The pick and the default it answered; a moved default retires it.
	const [ pick, setPick ] = useState( null );
	// In render, so the chart never draws once against the stale pick.
	if ( pick && pick.against !== stackedDefault ) {
		setPick( null );
	}
	const stacked = stackable && pick ? pick.stacked : stackedDefault;
	const toggleStack = useCallback(
		() => setPick( { against: stackedDefault, stacked: ! stacked } ),
		[ stackedDefault, stacked ]
	);

	const { legendItems, drawn, selected, onSelect } = useLegend(
		series,
		colorAt
	);
	// The total row's unit follows the whole list, whatever is drawn.
	const totalRow = stacked && totalLabel;
	const totalFormat = useMemo(
		() => ( totalRow ? yFormatFor( peakOf( series, true ) ) : null ),
		[ totalRow, yFormatFor, series ]
	);

	const renderFn = useCallback(
		( refs ) => {
			if ( ! refs.containerRef.current ) {
				return;
			}
			// Empty series: wipe the render so a reset clears the plot.
			if ( 0 === drawn.length ) {
				d3.select( refs.containerRef.current )
					.selectAll( '*' )
					.remove();
				return;
			}

			const { g, innerW, innerH } = openFrame(
				refs.containerRef.current,
				height
			);

			const dates = drawn[ 0 ].values.map( ( v ) => v.date );
			// Over the drawn stack, or the whole bucket for the tooltip.
			const totalAt = ( idx, over ) =>
				over.reduce( ( sum, s ) => sum + valueAt( s, idx ), 0 );

			const x = d3
				.scaleTime()
				.domain( d3.extent( dates ) )
				.range( [ 0, innerW ] );

			// The axis and its unit follow what is drawn.
			const peak = peakOf( drawn, stacked );
			const yFormat = yFormatFor( peak );
			// 10% headroom clears the peak band; an all-zero one gets [0,1].
			const y = d3
				.scaleLinear()
				.domain( [ 0, peak * 1.1 || 1 ] )
				.range( [ innerH, 0 ] );

			drawAxes( g, {
				x,
				y,
				innerH,
				tickCount: dates.length,
				yFormat,
				yLabel,
			} );
			if ( selectedSlots ) {
				shadeSlots( g, { innerW, innerH, dates, x, selectedSlots } );
			}

			// Stacked bands ride on the running baseline; overlaid ones on 0.
			const baseline = dates.map( () => 0 );
			const area = d3
				.area()
				.x( ( d ) => x( d.date ) )
				.y0( ( d ) => y( d.y0 ) )
				.y1( ( d ) => y( d.y1 ) )
				// A null value is a gap: the band splits, never dips to 0.
				.defined( ( d ) => d.defined )
				.curve( d3.curveMonotoneX );

			// The overlaid mark trades fill for outline, so bands stay apart.
			drawn.forEach( ( s ) => {
				const band = s.values.map( ( v, idx ) => {
					const y0 = stacked ? baseline[ idx ] : 0;
					baseline[ idx ] = y0 + ( v.value || 0 );
					return {
						date: v.date,
						y0,
						y1: baseline[ idx ],
						defined: null !== v.value,
					};
				} );
				g.append( 'path' )
					.datum( band )
					.style( 'fill', s.color )
					.style( 'stroke', s.color )
					.attr( 'fill-opacity', stacked ? 0.7 : 0.5 )
					.attr( 'stroke-width', stacked ? 0.5 : 1 )
					.attr( 'd', area );
				// A lone measured slot has a zero-width area, so it gets a dot.
				band.forEach( ( point, idx ) => {
					if (
						point.defined &&
						! band[ idx - 1 ]?.defined &&
						! band[ idx + 1 ]?.defined
					) {
						g.append( 'circle' )
							.attr( 'cx', x( point.date ) )
							.attr( 'cy', y( point.y1 ) )
							.attr( 'r', LONE_POINT_RADIUS )
							.style( 'fill', s.color );
					}
				} );
			} );

			setupTooltip( g, {
				innerW,
				innerH,
				dates,
				x,
				formatEntry: ( idx ) => {
					const entries = drawn
						.map( ( s ) => ( {
							label: s.label,
							value: yFormat( valueAt( s, idx ) ),
							raw: valueAt( s, idx ),
						} ) )
						.filter( ( e ) => e.raw > 0 )
						.sort( ( a, b ) => b.raw - a.raw )
						.slice( 0, TOOLTIP_ROWS );
					return totalRow
						? [
								{
									label: totalLabel,
									value: totalFormat(
										totalAt( idx, series )
									),
								},
								...entries,
						  ]
						: entries;
				},
				tooltipRef: refs.tooltipRef,
				lastMouseXRef: refs.lastMouseXRef,
				containerRef: refs.containerRef,
				onSlotClick,
			} );
		},
		[
			series,
			drawn,
			yFormatFor,
			totalFormat,
			totalRow,
			height,
			yLabel,
			stacked,
			totalLabel,
			onSlotClick,
			selectedSlots,
		]
	);

	const { containerRef, tooltipRef } = useTimeChart( renderFn );

	// `position: relative` makes the chart the tooltip's offset parent.
	return (
		<div
			className={ `newspack-nodes-chart${
				className ? ` ${ className }` : ''
			}` }
			style={ { position: 'relative' } }
		>
			<h3 className="newspack-nodes-chart__title">{ title }</h3>
			<div className="newspack-nodes-chart__corner">
				{ stackable && (
					<button
						type="button"
						className="newspack-nodes-chart__stack"
						aria-pressed={ stacked }
						title={
							stacked
								? __( 'Overlay the series', 'newspack-nodes' )
								: __( 'Stack the series', 'newspack-nodes' )
						}
						onClick={ toggleStack }
					>
						<StackIcon />
					</button>
				) }
				{ 0 < drawn.length && (
					<button
						type="button"
						className="newspack-nodes-chart__expand"
						{ ...buttonProps }
					>
						<ExpandIcon />
					</button>
				) }
			</div>
			<div className="newspack-nodes-chart__row">
				<div
					ref={ containerRef }
					className="newspack-nodes-chart__plot"
					style={ { minHeight: `${ height }px` } }
					{ ...( 0 < drawn.length ? plotProps : {} ) }
				/>
				<ChartLegend
					items={ legendItems }
					selected={ selected }
					onSelect={ onSelect }
					height={ height }
				/>
			</div>
			<div
				ref={ tooltipRef }
				className="newspack-nodes-card newspack-nodes-card--elevated newspack-nodes-chart__tooltip"
			/>
		</div>
	);
}

export default memo( AreaTimeChart );
