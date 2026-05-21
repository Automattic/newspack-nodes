/* global requestAnimationFrame, cancelAnimationFrame */
/**
 * Shared hook for time-series chart rendering (resize, scroll, tooltip).
 */

import { useCallback, useEffect, useRef } from '@wordpress/element';
import * as d3 from 'd3';

// --- Constants ---

export const RETENTION_SECONDS =
	Number( window.eventLoggerDashboards?.retentionSeconds ) || 86400;
export const BUCKET_MINUTES = 5;
export const BUCKET_SECONDS = BUCKET_MINUTES * 60;
export const BUCKET_MS = BUCKET_SECONDS * 1000;
export const NUM_BUCKETS = Math.ceil( RETENTION_SECONDS / BUCKET_SECONDS );

export const MARGIN = { top: 20, right: 160, bottom: 65, left: 60 };

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

// --- Helpers ---

/**
 * Build 5-minute time slots over the retention window.
 *
 * @return {Array} Array of { date, bucketKey } objects.
 */
export const buildTimeSlots = () => {
	const now = new Date();
	const slots = [];
	for ( let i = NUM_BUCKETS - 1; i >= 0; i-- ) {
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
 * Format X axis tick labels.
 *
 * @param {Date} d Date object.
 * @return {string} Formatted label.
 */
export const formatXTick = ( d ) => {
	const month = d.getMonth() + 1;
	const day = d.getDate();
	const hour = d.getHours();
	const min = String( d.getMinutes() ).padStart( 2, '0' );
	return `${ month }/${ day } ${ hour }:${ min }`;
};

/**
 * Draw vertical legend on right side of chart.
 *
 * @param {Object} svg   D3 SVG selection.
 * @param {Array}  items Legend items with color and label.
 * @param {number} width Chart total width.
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
		legend
			.append( 'text' )
			.attr( 'x', 14 )
			.attr( 'y', ly + 9 )
			.text( label )
			.style( 'font-size', '11px' )
			.style( 'fill', '#888' );
	} );
};

/**
 * Set up interactive tooltip with highlight bar on a chart group.
 *
 * @param {Object}   g                    D3 group selection (inner chart area).
 * @param {Object}   params               Configuration.
 * @param {number}   params.innerW        Chart inner width.
 * @param {number}   params.innerH        Chart inner height.
 * @param {Array}    params.dates         Array of Date objects for each slot.
 * @param {Object}   params.x             D3 x scale.
 * @param {Function} params.formatEntry   Format function: (idx) => Array<{label, value}>.
 * @param {Object}   params.tooltipRef    React ref to tooltip div.
 * @param {Object}   params.lastMouseXRef React ref tracking mouse x.
 * @param {Object}   params.containerRef  React ref to container div.
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
		.attr( 'fill', 'rgba(255,255,255,0.1)' )
		.attr( 'stroke', 'rgba(255,255,255,0.3)' )
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

		// Build tooltip with safe DOM methods.
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

	// Restore tooltip if mouse was over chart before re-render.
	if ( lastMouseXRef.current !== null ) {
		showTooltip( lastMouseXRef.current );
	}
};

// --- Hook ---

/**
 * Hook providing the render/resize/scroll lifecycle for time-series charts.
 * Callers must memoize `renderFn` (else infinite re-renders).
 *
 * @param {Function} renderFn Memoized render fn; receives { containerRef, tooltipRef, lastMouseXRef }.
 * @return {Object} { containerRef, tooltipRef, lastMouseXRef } refs to pass to JSX.
 */
export function useTimeChart( renderFn ) {
	const containerRef = useRef( null );
	const tooltipRef = useRef( null );
	const lastMouseXRef = useRef( null );

	const renderChart = useCallback( () => {
		renderFn( { containerRef, tooltipRef, lastMouseXRef } );
	}, [ renderFn ] );

	// Initial render and data change.
	useEffect( () => {
		renderChart();
	}, [ renderChart ] );

	// Handle resize.
	useEffect( () => {
		const handleResize = () => renderChart();
		window.addEventListener( 'resize', handleResize );
		return () => window.removeEventListener( 'resize', handleResize );
	}, [ renderChart ] );

	// Hide tooltip on scroll.
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
