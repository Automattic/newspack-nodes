/* global requestAnimationFrame, cancelAnimationFrame */
/**
 * The one d3 frame every dashboard time chart is drawn on.
 *
 * A caller owns its marks and nothing else: `openFrame` wipes the container
 * and hands back the plot box, `drawAxes` and `drawLegend` dress it,
 * `setupTooltip` binds the hover column, and `useTimeChart` re-runs the draw
 * whenever the picture would change. Panels across the substrate and its
 * consumers therefore share one set of margins, one tick style and one hover
 * behaviour, and a fix to any of them lands in all of them at once.
 *
 * Nothing here reads a host global. The retention window, the series and the
 * formatters all arrive as arguments, and a parameter a caller may not pass
 * yet carries a default — `retentionSeconds`, `yLabel` — so a consumer built
 * against an older substrate degrades to the plainer chart rather than
 * failing on a signature it has never seen.
 */

import { useCallback, useEffect, useRef } from '@wordpress/element';
import * as d3 from 'd3';

import { useContainerRefit } from './useContainerRefit';

/**
 * Window `buildTimeSlots()` covers when its caller names none: 24 hours.
 *
 * The substrate knows no host's retention and must not go looking for one.
 * Reading a consumer's localized global here would hand every OTHER consumer
 * this fallback silently, and would freeze the value at bundle-evaluation time
 * whatever the host localizes afterwards. A host owns its own window and
 * passes it to `buildTimeSlots()`; `newspack-event-logger-nodes`'s
 * `src/overview/retention.js` is the worked example.
 */
export const DEFAULT_RETENTION_SECONDS = 86400;

/**
 * Pitch of one bucket, in minutes. It matches the five-minute bucket the
 * server files stats under, so one slot reads exactly one stored record.
 */
export const BUCKET_MINUTES = 5;

/** The bucket pitch in seconds — the divisor a per-second rate uses. */
export const BUCKET_SECONDS = BUCKET_MINUTES * 60;

/** The bucket pitch in milliseconds — the unit `Date` arithmetic takes. */
export const BUCKET_MS = BUCKET_SECONDS * 1000;

/**
 * Slots the default window holds. A chart drawing a window of its own reads
 * `buildTimeSlots( seconds ).length` instead; this constant follows
 * `DEFAULT_RETENTION_SECONDS` alone.
 */
export const NUM_BUCKETS = Math.ceil(
	DEFAULT_RETENTION_SECONDS / BUCKET_SECONDS
);

/**
 * Plot-box insets in pixels, each side sized by what it has to clear: `right`
 * reserves the legend column, `bottom` the time labels `drawAxes` rotates 45
 * degrees, and `left` the value labels plus the rotated axis title. Marks
 * scale to the inner box, so a chart never draws over them.
 */
export const MARGIN = { top: 20, right: 160, bottom: 65, left: 60 };

/**
 * Value-axis ticks asked of d3, which reads the count as a hint. Five is what
 * the 200-280px plots the dashboards draw read comfortably.
 */
const Y_TICKS = 5;

/**
 * Series colors, indexed modulo the length so a chart with more series than
 * colors repeats rather than running out. The first ten are Tableau 10, which
 * stay apart on a dense overlay; the rest extend the run for the long topic
 * and category lists. Each hue has to read on a light and a dark panel, since
 * a chart with no theme tokens falls back to these (`resolveChartPalette`).
 */
export const PALETTE = [
	'#4e79a7',
	'#f28e2b',
	'#e15759',
	'#76b7b2',
	'#59a14f',
	'#edc948',
	'#b07aa1',
	'#ff9da7',
	'#9c755f',
	'#bab0ac',
	'#6b46c1',
	'#2ca02c',
	'#d62728',
	'#1f77b4',
	'#ff7f0e',
	'#8c564b',
	'#7f7f7f',
	'#bcbd22',
	'#17becf',
	'#aec7e8',
];

/**
 * Build the five-minute slots a chart's time axis is drawn over.
 *
 * Each slot carries both readings of one bucket. `date` is local wall clock,
 * which is what the axis labels and the tooltip show; `bucketKey` is the UTC
 * `YYYY-MM-DD-HH-MM` name the server files that bucket under (`gmdate(
 * 'Y-m-d-H-i' )` floored to five minutes), which is what a caller looks its
 * stats up by. Deriving both in one place is what stops the two spellings
 * drifting apart in each consumer.
 *
 * @param {number} [retentionSeconds] Seconds of history to cover; defaults to 24 hours.
 * @return {Array<{date:Date,bucketKey:string}>} One slot per five minutes, oldest first.
 */
export const buildTimeSlots = (
	retentionSeconds = DEFAULT_RETENTION_SECONDS
) => {
	const buckets = Math.ceil( retentionSeconds / BUCKET_SECONDS );
	const now = new Date();
	const slots = [];
	for ( let i = buckets - 1; i >= 0; i-- ) {
		const date = new Date( now.getTime() - i * BUCKET_MS );
		date.setMinutes( Math.floor( date.getMinutes() / 5 ) * 5, 0, 0 );
		const bucketKey = [
			date.getUTCFullYear(),
			String( date.getUTCMonth() + 1 ).padStart( 2, '0' ),
			String( date.getUTCDate() ).padStart( 2, '0' ),
			String( date.getUTCHours() ).padStart( 2, '0' ),
			String( Math.floor( date.getUTCMinutes() / 5 ) * 5 ).padStart(
				2,
				'0'
			),
		].join( '-' );
		slots.push( { date, bucketKey } );
	}
	return slots;
};

/**
 * Label one time-axis tick as `M/D H:MM`, in the reader's own zone.
 *
 * The date rides along because a day-long window crosses midnight, and ticks
 * reading `23:55` then `0:00` need the day to order. The year does not: it
 * doubles the width of a label the axis already rotates to fit.
 *
 * @param {Date} d Instant the tick sits at.
 * @return {string} Tick label.
 */
export const formatXTick = ( d ) => {
	const month = d.getMonth() + 1;
	const day = d.getDate();
	const hour = d.getHours();
	const min = String( d.getMinutes() ).padStart( 2, '0' );
	return `${ month }/${ day } ${ hour }:${ min }`;
};

/**
 * Wipe a chart container and open a fresh frame in it.
 *
 * Every render redraws from scratch; d3 holds no update join. The container's
 * measured width drives the plot box, so a resize is just another render, and
 * an unlaid container falls back to 800px rather than drawing a zero-width
 * chart.
 *
 * @param {Element} container Container element the chart owns; its contents are replaced.
 * @param {number}  height    Total SVG height in pixels, margins included.
 * @return {{svg: Object, g: Object, width: number, innerW: number, innerH: number}} The SVG, the plot-area group translated by `MARGIN`, and the measured box.
 */
export const openFrame = ( container, height ) => {
	const root = d3.select( container );
	// Before the wipe: measuring after it forces a layout flush.
	const width = container.clientWidth || 800;

	root.selectAll( '*' ).remove();
	const svg = root
		.append( 'svg' )
		.attr( 'width', width )
		.attr( 'height', height );
	const g = svg
		.append( 'g' )
		.attr( 'transform', `translate(${ MARGIN.left },${ MARGIN.top })` );

	return {
		svg,
		g,
		width,
		innerW: width - MARGIN.left - MARGIN.right,
		innerH: height - MARGIN.top - MARGIN.bottom,
	};
};

/**
 * Draw the axis frame: rotated time axis, value axis, and Y-axis title.
 *
 * Time labels are rotated 45 degrees and capped at eight ticks, because a
 * day's 288 slots at `M/D H:MM` overprint each other several times over. The
 * value axis ticks through `yFormat`, and through the ladder `yFormat` may
 * carry: a formatter counting in anything but base 10 has to choose its own
 * tick values, or d3's round numbers print as fractions of its unit.
 *
 * @param {Object}                                      g                D3 group selection (inner chart area).
 * @param {Object}                                      params           Configuration.
 * @param {Object}                                      params.x         D3 time scale.
 * @param {Object}                                      params.y         D3 value scale.
 * @param {number}                                      params.innerH    Chart inner height.
 * @param {number}                                      params.tickCount Slot count; the time axis caps ticks at 8.
 * @param {import('../utils/axis-ticks').AxisFormatter} params.yFormat   Formats a value for the Y axis; a `tickValues` property on it ticks the axis in its own unit.
 * @param {string}                                      [params.yLabel]  Translated Y-axis title; omitted leaves the axis unlabelled.
 */
export const drawAxes = (
	g,
	{ x, y, innerH, tickCount, yFormat, yLabel = '' }
) => {
	g.append( 'g' )
		.attr( 'transform', `translate(0,${ innerH })` )
		.call(
			d3
				.axisBottom( x )
				.ticks( Math.min( tickCount, 8 ) )
				.tickFormat( formatXTick )
		)
		.selectAll( 'text' )
		.attr( 'transform', 'rotate(-45)' )
		.style( 'text-anchor', 'end' );

	const yAxis = d3.axisLeft( y ).ticks( Y_TICKS ).tickFormat( yFormat );
	if ( yFormat.tickValues ) {
		yAxis.tickValues( yFormat.tickValues( y, Y_TICKS ) );
	}
	g.append( 'g' ).call( yAxis );

	if ( yLabel ) {
		g.append( 'text' )
			.attr( 'class', 'y-label' )
			.attr( 'transform', 'rotate(-90)' )
			.attr( 'y', 0 - MARGIN.left )
			.attr( 'x', 0 - innerH / 2 )
			.attr( 'dy', '1em' )
			.style( 'text-anchor', 'middle' )
			.style( 'font-size', '12px' )
			.text( yLabel );
	}
};

/**
 * Draw the series legend down the right margin, one row per item.
 *
 * The column is `MARGIN.right` wide and neither wraps nor scrolls, so a label
 * over 20 characters is cut to 18 and an ellipsis instead of running under the
 * next panel. Rows come out 16px apart in the order given, which leaves the
 * ranking to the caller.
 *
 * @param {Object}                             svg   D3 SVG selection.
 * @param {Array<{color:string,label:string}>} items One row per series, in draw order.
 * @param {number}                             width Chart total width; the column hangs off its right edge.
 */
export const drawLegend = ( svg, items, width ) => {
	const legend = svg
		.append( 'g' )
		.attr(
			'transform',
			`translate(${ width - MARGIN.right + 10 }, ${ MARGIN.top })`
		);

	items.forEach( ( item, i ) => {
		const ly = i * 16;
		const label =
			item.label.length > 20
				? item.label.slice( 0, 18 ) + '...'
				: item.label;

		legend
			.append( 'rect' )
			.attr( 'x', 0 )
			.attr( 'y', ly )
			.attr( 'width', 10 )
			.attr( 'height', 10 )
			.attr( 'fill', item.color );
		// 8px clear of the 10px swatch; at 4 the two read as one glyph.
		legend
			.append( 'text' )
			.attr( 'x', 18 )
			.attr( 'y', ly + 9 )
			.text( label )
			.style( 'font-size', '11px' )
			.style( 'fill', '#888' );
	} );
};

/**
 * The rows a tooltip lists for the hovered bucket, in display order. Values
 * arrive already formatted, because only the caller knows the unit.
 *
 * @typedef {( index: number ) => Array<{label:string,value:string}>} EntryFormatter
 */

/**
 * Bind the hover: a highlight column on the nearest bucket, and a tooltip
 * listing that bucket's rows.
 *
 * A transparent rectangle over the whole plot takes the pointer, so every
 * column is hoverable, the empty ones included. The move handler records the
 * pointer and schedules a frame rather than drawing in place: d3 reports moves
 * far more often than the display refreshes, and each pass rebuilds the
 * tooltip's children and re-measures the viewport.
 *
 * The tooltip anchors below the chart and flips above or left when that would
 * carry it past a viewport edge, which is what keeps the last panel on a long
 * dashboard from opening its tooltip off-screen.
 *
 * @param {Object}         g                    D3 group selection (inner chart area).
 * @param {Object}         params               Configuration.
 * @param {number}         params.innerW        Chart inner width.
 * @param {number}         params.innerH        Chart inner height.
 * @param {Array}          params.dates         One `Date` per slot, ascending; the hover snaps to the nearest.
 * @param {Object}         params.x             D3 x scale over `dates`.
 * @param {EntryFormatter} params.formatEntry   Rows to list for the hovered slot.
 * @param {Object}         params.tooltipRef    React ref to tooltip div.
 * @param {Object}         params.lastMouseXRef React ref tracking mouse x.
 * @param {Object}         params.containerRef  React ref to container div.
 */
export const setupTooltip = (
	g,
	{
		innerW,
		innerH,
		dates,
		x,
		formatEntry,
		tooltipRef,
		lastMouseXRef,
		containerRef,
	}
) => {
	const bucketWidth = innerW / dates.length;
	const bisect = d3.bisector( ( d ) => d ).left;

	const highlight = g
		.append( 'rect' )
		.attr( 'y', 0 )
		.attr( 'height', innerH )
		.attr( 'width', bucketWidth )
		// Neutral grey so the hover column reads on light AND dark panels.
		.attr( 'fill', 'rgba(128,128,128,0.18)' )
		.attr( 'stroke', 'rgba(128,128,128,0.4)' )
		.attr( 'stroke-width', 1 )
		.attr( 'opacity', 0 );

	const tooltip = tooltipRef.current;

	const showTooltip = ( mx ) => {
		const dateAtMouse = x.invert( mx );
		const i1 = Math.min( bisect( dates, dateAtMouse ), dates.length - 1 );
		const i0 = Math.max( 0, i1 - 1 );
		const idx =
			dateAtMouse - dates[ i0 ] < dates[ i1 ] - dateAtMouse ? i0 : i1;
		const xPos = x( dates[ idx ] );

		highlight.attr( 'x', xPos - bucketWidth / 2 ).attr( 'opacity', 1 );

		// Labels are wire data: build with textContent, never innerHTML.
		tooltip.textContent = '';
		const header = document.createElement( 'strong' );
		header.textContent = dates[ idx ].toLocaleTimeString();
		tooltip.appendChild( header );

		const entries = formatEntry( idx );
		entries.forEach( ( e ) => {
			tooltip.appendChild( document.createElement( 'br' ) );
			tooltip.appendChild(
				document.createTextNode( `${ e.label }: ${ e.value }` )
			);
		} );
		tooltip.style.display = 'block';

		tooltip.style.left = `${ MARGIN.left + xPos }px`;
		const ttParent = containerRef.current.parentElement;
		tooltip.style.top = `${ ttParent.clientHeight }px`;
		const tooltipRect = tooltip.getBoundingClientRect();
		if ( tooltipRect.bottom > window.innerHeight ) {
			tooltip.style.top = `-${ tooltip.offsetHeight + 4 }px`;
		}
		if ( tooltipRect.right > window.innerWidth ) {
			tooltip.style.left = `${
				MARGIN.left + xPos - tooltip.offsetWidth
			}px`;
		}
		if ( tooltip.getBoundingClientRect().left < 0 ) {
			tooltip.style.left = '0px';
		}
	};

	let rafId = null;
	function hideTooltip() {
		if ( rafId ) {
			cancelAnimationFrame( rafId );
			rafId = null;
		}
		lastMouseXRef.current = null;
		tooltip.style.display = 'none';
		highlight.attr( 'opacity', 0 );
	}

	g.append( 'rect' )
		.attr( 'width', innerW )
		.attr( 'height', innerH )
		.attr( 'fill', 'none' )
		.attr( 'pointer-events', 'all' )
		.on( 'mousemove', ( event ) => {
			const [ mx ] = d3.pointer( event );
			lastMouseXRef.current = mx;
			if ( rafId ) {
				cancelAnimationFrame( rafId );
			}
			rafId = requestAnimationFrame( () => {
				rafId = null;
				if ( lastMouseXRef.current === null ) {
					return;
				}
				showTooltip( lastMouseXRef.current );
			} );
		} )
		.on( 'mouseleave', hideTooltip );

	// Restore the hover this redraw would otherwise have dropped.
	if ( lastMouseXRef.current !== null ) {
		showTooltip( lastMouseXRef.current );
	}
};

/**
 * The elements one chart's draw is wired through, plus its pointer state.
 *
 * @typedef  {Object} ChartRefs
 * @property {Object} containerRef  Ref to the element the SVG is drawn into.
 * @property {Object} tooltipRef    Ref to the tooltip element.
 * @property {Object} lastMouseXRef Ref holding the last pointer x, or null.
 */

/**
 * Own a chart's refs, and re-run its draw whenever the picture changes.
 *
 * The hook redraws on the two events that change what a chart shows —
 * `renderFn`'s own identity, which carries its data and theme, and a resize of
 * the container. It also hides the tooltip when the page scrolls, or when the
 * modal body does for a chart opened inside one: the tooltip is positioned
 * against the chart, and a scroll it does not hear about strands it.
 *
 * Callers must memoize `renderFn`. The drawing effect depends on it, so an
 * unstable one re-renders forever.
 *
 * @param {( refs: ChartRefs ) => void} renderFn Draws one frame into `refs.containerRef`.
 * @return {ChartRefs} Refs to attach to the container and tooltip elements.
 */
export function useTimeChart( renderFn ) {
	const containerRef = useRef( null );
	const tooltipRef = useRef( null );
	const lastMouseXRef = useRef( null );

	const renderChart = useCallback( () => {
		renderFn( { containerRef, tooltipRef, lastMouseXRef } );
	}, [ renderFn ] );

	// Draw on mount, and again each time `renderFn` re-identifies.
	useEffect( () => {
		renderChart();
	}, [ renderChart ] );

	// The dep that binds it: a chart rendering null has no container yet.
	useContainerRefit( containerRef, renderChart, [ renderChart ] );

	// The tooltip is positioned against the chart; a scroll strands it.
	useEffect( () => {
		const el = containerRef.current;
		if ( ! el ) {
			return;
		}
		const scrollParent =
			el.closest( '.components-modal__content' ) || window;
		const hideOnScroll = () => {
			lastMouseXRef.current = null;
			if ( tooltipRef.current ) {
				tooltipRef.current.style.display = 'none';
			}
		};
		scrollParent.addEventListener( 'scroll', hideOnScroll, {
			passive: true,
		} );
		return () => {
			scrollParent.removeEventListener( 'scroll', hideOnScroll );
		};
	}, [] );

	return { containerRef, tooltipRef, lastMouseXRef };
}
