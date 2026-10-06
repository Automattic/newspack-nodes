/* global requestAnimationFrame, cancelAnimationFrame */
/**
 * The one d3 frame every dashboard time chart is drawn on.
 *
 * A caller owns its marks and nothing else: `openFrame` wipes the container
 * and hands back the plot box, `drawAxes` dresses it, `setupTooltip` binds
 * the hover column, and `useTimeChart` re-runs the draw whenever the picture
 * would change; the legend is the `ChartLegend` component beside the SVG,
 * picking series through `useSeriesSelection`. Panels across the substrate
 * and its consumers therefore share one set of margins, one tick style, one
 * hover behaviour and one legend, and a fix to any of them lands in all of
 * them at once.
 *
 * Nothing here reads a host global. The retention window, the series and the
 * formatters all arrive as arguments. `retentionSeconds` carries a default, so
 * a consumer built against an older substrate keeps the stock window rather
 * than failing on a signature it has never seen.
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
 * Plot-box insets in pixels, each side sized by what it has to clear:
 * `bottom` the time labels `drawAxes` rotates 45 degrees, `left` the rotated
 * axis title plus value labels as wide as `768 KB/s` or `1000000`, and `right`
 * the last time label's overhang. The legend is not in the SVG: `ChartLegend`
 * sits beside it in the `.newspack-nodes-chart__row`. Marks scale to the inner
 * box, so a chart never draws over them.
 */
export const MARGIN = { top: 20, right: 20, bottom: 65, left: 72 };

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
 * a chart outside a skinned subtree falls back to these (`chartColor`).
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

/** How many `--chart-*` tokens a skin declares. */
const SKIN_COLORS = 8;

/**
 * The colour a series takes from its rank: the skin's `--chart-N` token, with
 * the `PALETTE` entry behind it for a chart outside any skinned subtree.
 *
 * A CSS value rather than a resolved colour, so a d3 fill or a legend swatch
 * painted with it re-skins with the page on its own, the way every other
 * surface does when `applySkin()` swaps the class on `<html>`. Reading the
 * token's computed value instead would hand the chart a colour it keeps until
 * something else happens to redraw it, and cost a second draw on mount to
 * read it at all. Set it through `.style( 'fill', … )`: a presentation
 * attribute does not resolve `var()`.
 *
 * @param {number} index The series' place in the full list, from 0.
 * @return {string} A CSS colour value.
 */
export const chartColor = ( index ) =>
	`var(--chart-${ ( index % SKIN_COLORS ) + 1 }, ${
		PALETTE[ index % PALETTE.length ]
	})`;

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
 * @param {string}                                      params.yLabel    Translated Y-axis title naming the quantity; the ticks carry the unit.
 */
export const drawAxes = ( g, { x, y, innerH, tickCount, yFormat, yLabel } ) => {
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

	g.append( 'text' )
		.attr( 'class', 'y-label' )
		.attr( 'transform', 'rotate(-90)' )
		.attr( 'y', 0 - MARGIN.left )
		.attr( 'x', 0 - innerH / 2 )
		.attr( 'dy', '1em' )
		.style( 'text-anchor', 'middle' )
		.style( 'font-size', '12px' )
		.text( yLabel );
};

/**
 * A slot's column: one bucket wide, the plot tall, centred on the slot. The
 * hover highlight and the selected-slot shading both draw it, so the two
 * cover the same strip.
 *
 * @param {Object} g             D3 group selection (inner chart area).
 * @param {Object} params        Configuration.
 * @param {number} params.innerW Chart inner width.
 * @param {number} params.innerH Chart inner height.
 * @param {Array}  params.dates  One `Date` per slot, ascending.
 * @param {Object} params.x      D3 x scale over `dates`.
 * @return {{append: () => Object, left: (idx: number) => number, width: number}}
 * `append` adds an unplaced column rect to `g`; `left` is slot `idx`'s
 * column's x; `width` is one column's.
 */
const slotColumns = ( g, { innerW, innerH, dates, x } ) => {
	const width = innerW / dates.length;
	return {
		width,
		append: () =>
			g
				.append( 'rect' )
				.attr( 'y', 0 )
				.attr( 'width', width )
				.attr( 'height', innerH ),
		left: ( idx ) => x( dates[ idx ] ) - width / 2,
	};
};

/**
 * Shade the selected slots' columns, in the geometry the hover highlight
 * takes. Draw it before the marks, so the bands stay legible over it; the
 * `newspack-nodes-chart__selected` role paints it, so the accent re-skins with
 * the page.
 *
 * @param {Object}              g                    D3 group selection (inner chart area).
 * @param {Object}              params               Configuration.
 * @param {number}              params.innerW        Chart inner width.
 * @param {number}              params.innerH        Chart inner height.
 * @param {Array}               params.dates         One `Date` per slot, ascending.
 * @param {Object}              params.x             D3 x scale over `dates`.
 * @param {ReadonlySet<number>} params.selectedSlots Indexes into `dates` to shade; one outside it shades nothing.
 */
export const shadeSlots = ( g, { selectedSlots, ...frame } ) => {
	const column = slotColumns( g, frame );
	frame.dates.forEach( ( date, idx ) => {
		if ( selectedSlots.has( idx ) ) {
			column
				.append()
				.attr( 'class', 'newspack-nodes-chart__selected' )
				.attr( 'x', column.left( idx ) );
		}
	} );
};

/**
 * The rows a tooltip lists for the hovered bucket, in display order. Values
 * arrive already formatted, because only the caller knows the unit.
 *
 * @typedef {( index: number ) => Array<{label:string,value:string}>} EntryFormatter
 */

/**
 * Takes a clicked slot's index, and whether cmd or ctrl asked to add it to
 * the caller's selection rather than replace it.
 *
 * @typedef {( index: number, click: {additive: boolean} ) => void} SlotClick
 */

/**
 * Takes the first and last slot a drag crossed, `from <= to`, and whether cmd
 * or ctrl, held at release, asked to add the span to the caller's selection.
 *
 * @typedef {( from: number, to: number, drag: {additive: boolean} ) => void} SlotRange
 */

/**
 * Whether a click ends a drag-selection, as one over the tick labels does.
 *
 * @param {{currentTarget: Element}} event The click, on the element it bound.
 * @return {boolean} True when the document holds a non-collapsed selection.
 */
const isDragSelection = ( event ) => {
	const selection =
		event.currentTarget.ownerDocument.defaultView.getSelection();
	return Boolean( selection && ! selection.isCollapsed );
};

/**
 * Route a pointer's events to `el` until release. A pointer already released
 * cannot be captured, which is no fault of the gesture.
 *
 * @param {Element} el        The element to capture to.
 * @param {number}  pointerId The pointer.
 */
const capture = ( el, pointerId ) => {
	try {
		el.setPointerCapture?.( pointerId );
	} catch {
		// The gesture carries on uncaptured.
	}
};

/**
 * Bind the hover: a highlight column on the nearest bucket, and a tooltip
 * listing that bucket's rows. A click on the plot hands that bucket's index
 * to `onSlotClick`, with `additive` true when cmd or ctrl was held; the click
 * ending a drag-selection reports nothing.
 *
 * With `onSlotRange`, a left-button press dragged at least one column wide,
 * and never under 4px, selects the span of slots it crosses instead: the span
 * shades live as the pointer moves, clamped to the edge slot once it leaves
 * the plot, and the release hands it to `onSlotRange` and swallows the click
 * that follows. The press captures its pointer, so a drag ending off the plot
 * still releases here, and answers that pointer alone. Escape cancels the
 * drag, through the listener `useTimeChart` holds. The
 * press lives in `dragRef` rather than in this draw, so a redraw mid-drag —
 * a poll landing, or the caller's own answer to the span — keeps it.
 *
 * A transparent rectangle over the whole plot takes the pointer, so every
 * column is hoverable, the empty ones included. The move handler records the
 * pointer and schedules a frame rather than drawing in place: d3 reports moves
 * far more often than the display refreshes, and each pass rebuilds the
 * tooltip's children and re-measures the viewport.
 *
 * The tooltip anchors below the chart row — the container's parent, inside
 * the positioned wrapper the tooltip is a child of — and flips above or left
 * when that would carry it past a viewport edge, which is what keeps the last
 * panel on a long dashboard from opening its tooltip off-screen. Flipped, it
 * clears the row's title too, since the wrapper is what it measures against.
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
 * @param {SlotClick}      [params.onSlotClick] Takes the clicked slot's index into `dates`.
 * @param {SlotRange}      [params.onSlotRange] Takes a drag's span of indexes into `dates`; absent, a drag is a click.
 * @param {Object}         [params.dragRef]     React ref holding the press in progress; required with `onSlotRange`.
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
		onSlotClick,
		onSlotRange,
		dragRef,
	}
) => {
	const bisect = d3.bisector( ( d ) => d ).left;
	const frame = { innerW, innerH, dates, x };
	const column = slotColumns( g, frame );

	const highlight = column
		.append()
		// Neutral grey so the hover column reads on light AND dark panels.
		.attr( 'fill', 'rgba(128,128,128,0.18)' )
		.attr( 'stroke', 'rgba(128,128,128,0.4)' )
		.attr( 'stroke-width', 1 )
		.attr( 'opacity', 0 );
	const dragShade = onSlotRange ? g.append( 'g' ) : null;

	const tooltip = tooltipRef.current;

	const slotAt = ( mx ) => {
		const dateAtMouse = x.invert( mx );
		const i1 = Math.min( bisect( dates, dateAtMouse ), dates.length - 1 );
		const i0 = Math.max( 0, i1 - 1 );
		return dateAtMouse - dates[ i0 ] < dates[ i1 ] - dateAtMouse ? i0 : i1;
	};

	const showTooltip = ( mx ) => {
		const idx = slotAt( mx );
		const xPos = x( dates[ idx ] );

		highlight.attr( 'x', column.left( idx ) ).attr( 'opacity', 1 );

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

		const row = containerRef.current.parentElement;
		const left = row.offsetLeft + MARGIN.left + xPos;
		tooltip.style.left = `${ left }px`;
		tooltip.style.top = `${ row.offsetTop + row.offsetHeight }px`;
		const tooltipRect = tooltip.getBoundingClientRect();
		if ( tooltipRect.bottom > window.innerHeight ) {
			tooltip.style.top = `-${ tooltip.offsetHeight + 4 }px`;
		}
		if ( tooltipRect.right > window.innerWidth ) {
			tooltip.style.left = `${ left - tooltip.offsetWidth }px`;
		}
		if ( tooltip.getBoundingClientRect().left < 0 ) {
			tooltip.style.left = '0px';
		}
	};

	let rafId = null;
	const scheduleHover = ( mx ) => {
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
	};
	function hideTooltip() {
		if ( rafId ) {
			cancelAnimationFrame( rafId );
			rafId = null;
		}
		lastMouseXRef.current = null;
		tooltip.style.display = 'none';
		highlight.attr( 'opacity', 0 );
	}

	const overlay = g
		.append( 'rect' )
		.attr( 'width', innerW )
		.attr( 'height', innerH )
		.attr( 'fill', 'none' )
		.attr( 'pointer-events', 'all' )
		.on( 'mousemove', ( event ) =>
			scheduleHover( d3.pointer( event )[ 0 ] )
		)
		.on( 'mouseleave', hideTooltip )
		.on( 'click', ( event ) => {
			// The click a drag's release, or an Escape, already settled.
			if ( onSlotRange && dragRef.current?.done ) {
				dragRef.current = null;
				return;
			}
			if ( onSlotClick && ! isDragSelection( event ) ) {
				onSlotClick( slotAt( d3.pointer( event )[ 0 ] ), {
					additive: Boolean( event.metaKey || event.ctrlKey ),
				} );
			}
		} );
	if ( onSlotRange ) {
		bindDrag( overlay, {
			dragRef,
			onSlotRange,
			slotAt,
			scheduleHover,
			threshold: Math.max( column.width, MIN_DRAG_PX ),
			paint: () => paintDrag( dragShade, frame, dragRef.current ),
		} );
	}

	// Restore the hover this redraw would otherwise have dropped.
	if ( lastMouseXRef.current !== null ) {
		showTooltip( lastMouseXRef.current );
	}
};

/**
 * A press's span as `[ from, to ]`, low to high.
 *
 * @param {{from: number, to: number}} press The press.
 * @return {number[]} The first and last slot it crossed.
 */
const spanOf = ( press ) => [
	Math.min( press.from, press.to ),
	Math.max( press.from, press.to ),
];

/**
 * Redraw a drag's live shading: the span of a live, unsettled press, or none.
 *
 * @param {Object}  shade D3 group the shading owns.
 * @param {Object}  frame The plot's `innerW`, `innerH`, `dates` and `x`.
 * @param {?Object} press The press in progress, or null.
 */
const paintDrag = ( shade, frame, press ) => {
	shade.selectAll( '*' ).remove();
	if ( press?.live && ! press.done ) {
		const [ from, to ] = spanOf( press );
		shadeSlots( shade, {
			...frame,
			selectedSlots: new Set( d3.range( from, to + 1 ) ),
		} );
	}
};

/**
 * The fewest pixels a press travels to become a drag, however narrow a column
 * is, so a click's jitter never selects a span.
 *
 * @type {number}
 */
const MIN_DRAG_PX = 4;

/**
 * Bind the drag gesture to the overlay, and resume a press a redraw cut off.
 *
 * @param {Object}                 overlay              The overlay rect selection.
 * @param {Object}                 params               Configuration.
 * @param {Object}                 params.dragRef       React ref holding the press.
 * @param {SlotRange}              params.onSlotRange   Takes the released span.
 * @param {(mx: number) => number} params.slotAt        The slot nearest a plot x.
 * @param {(mx: number) => void}   params.scheduleHover Moves the hover to a plot x.
 * @param {number}                 params.threshold     Pixels a press travels to become a drag.
 * @param {() => void}             params.paint         Redraws the live shading.
 */
const bindDrag = (
	overlay,
	{ dragRef, onSlotRange, slotAt, scheduleHover, threshold, paint }
) => {
	// A press settled by Escape waits for its click; nothing moves it.
	const pressing = () => dragRef.current && ! dragRef.current.done;
	const pressedBy = ( event ) =>
		pressing() && event.pointerId === dragRef.current.pointerId;
	overlay
		.style( 'touch-action', 'pan-y' )
		.on( 'pointerdown', ( event ) => {
			if ( event.button !== 0 ) {
				return;
			}
			// The press would otherwise start a text selection over the labels.
			event.preventDefault();
			const [ mx ] = d3.pointer( event );
			const at = slotAt( mx );
			dragRef.current = {
				pointerId: event.pointerId,
				x0: mx,
				from: at,
				to: at,
				live: false,
				done: false,
			};
			capture( event.currentTarget, event.pointerId );
		} )
		.on( 'pointermove', ( event ) => {
			if ( ! pressedBy( event ) ) {
				return;
			}
			const press = dragRef.current;
			const [ mx ] = d3.pointer( event );
			// Mouse moves stop while a cancelled press is down; hover here.
			scheduleHover( mx );
			if ( Math.abs( mx - press.x0 ) >= threshold ) {
				press.live = true;
			}
			press.to = slotAt( mx );
			paint();
		} )
		.on( 'pointerup', ( event ) => {
			if ( ! pressedBy( event ) ) {
				return;
			}
			const press = dragRef.current;
			if ( ! press.live ) {
				dragRef.current = null;
				return;
			}
			press.to = slotAt( d3.pointer( event )[ 0 ] );
			press.done = true;
			paint();
			const [ from, to ] = spanOf( press );
			onSlotRange( from, to, {
				additive: Boolean( event.metaKey || event.ctrlKey ),
			} );
		} )
		.on( 'pointercancel', ( event ) => {
			if ( ! pressedBy( event ) ) {
				return;
			}
			dragRef.current = null;
			paint();
		} );
	if ( pressing() ) {
		paint();
		capture( overlay.node(), dragRef.current.pointerId );
	}
};

/**
 * The elements one chart's draw is wired through, plus its pointer state.
 *
 * @typedef  {Object} ChartRefs
 * @property {Object} containerRef  Ref to the element the SVG is drawn into.
 * @property {Object} tooltipRef    Ref to the tooltip element.
 * @property {Object} lastMouseXRef Ref holding the last pointer x, or null.
 * @property {Object} dragRef       Ref holding the drag press in progress, or null.
 */

/**
 * Own a chart's refs, and re-run its draw whenever the picture changes.
 *
 * The hook redraws on the two events that change what a chart shows —
 * `renderFn`'s own identity, which carries its data and theme, and a resize of
 * the container. It also hides the tooltip when the page scrolls, or when the
 * modal body does for a chart opened inside one: the tooltip is positioned
 * against the chart, and a scroll it does not hear about strands it. Escape
 * cancels a drag in progress, ahead of any other Escape handler, so a chart
 * in a modal drops the drag without closing the modal.
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
	const dragRef = useRef( null );

	const renderChart = useCallback( () => {
		renderFn( { containerRef, tooltipRef, lastMouseXRef, dragRef } );
	}, [ renderFn ] );

	// Settled rather than cleared, so the click the release makes is swallowed.
	useEffect( () => {
		const cancelDrag = ( event ) => {
			if (
				'Escape' === event.key &&
				dragRef.current &&
				! dragRef.current.done
			) {
				event.stopPropagation();
				dragRef.current.done = true;
				renderChart();
			}
		};
		window.addEventListener( 'keydown', cancelDrag, true );
		return () => {
			window.removeEventListener( 'keydown', cancelDrag, true );
		};
	}, [ renderChart ] );

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

	return { containerRef, tooltipRef, lastMouseXRef, dragRef };
}
