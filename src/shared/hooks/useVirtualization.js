/**
 * Row-window math for a long list, measured against whichever element actually
 * scrolls — the list itself, an ancestor container, or the window.
 *
 * Rendering every row costs DOM proportional to the data. This returns the
 * slice worth rendering plus the spacer heights that keep the scrollbar the
 * size it would be unvirtualized, so the cost tracks the viewport instead.
 * Scroll geometry lands in state, so the window follows a frame behind the
 * scroll and OVERSCAN rows cover the gap. A list that pulls its rows inside
 * the frame it paints reads the geometry live instead, the way `LogRowList`
 * does.
 */

import { useState, useEffect } from '@wordpress/element';

/**
 * Rows rendered past each edge of the viewport.
 *
 * The window is a state update behind the scroll, so without them a fast
 * scroll shows blank space where the rows have not caught up.
 */
const OVERSCAN = 5;

/**
 * The slice to render and the geometry that places it.
 *
 * `offsetTop` and `paddingTop` carry the same number for the two ways a caller
 * can place the slice: absolute positioning inside a `totalHeight` spacer, or
 * padding above and below the rows.
 *
 * @typedef  {Object} VirtualWindow
 * @property {number} startIndex    First row to render.
 * @property {number} endIndex      One past the last row to render.
 * @property {number} offsetTop     Pixels of rows above the slice.
 * @property {number} totalHeight   Pixels every row would occupy.
 * @property {number} paddingTop    Pixels of rows above the slice.
 * @property {number} paddingBottom Pixels of rows below the slice.
 */

/**
 * Measure the scroll position and return the row window it warrants.
 *
 * `container` picks what is measured. `'self'` reads the list's own
 * `scrollTop` and `clientHeight`. A selector measures the list against its
 * nearest matching ancestor, which must exist — where `closest()` finds
 * nothing, the first measurement throws. `null` measures against the viewport
 * and skips the update while the list sits off screen, so a list nobody is
 * looking at neither re-renders on every scroll event nor loses the window it
 * will scroll back into.
 *
 * Until the first measurement, and for as long as `listRef.current` is null,
 * the window is the top 2160px of the list — a 4K display's height, so the
 * first paint fills any screen the list can land on.
 *
 * Every row must be `rowHeight` tall: the bounds are arithmetic on that
 * height, never a measurement of the rows themselves.
 *
 * @param {Object}      listRef      Ref to the list element.
 * @param {number}      rowHeight    Row height in pixels.
 * @param {number}      totalRows    Rows the caller holds.
 * @param {string|null} container    `'self'`, an ancestor selector, or null for the window.
 * @param {number}      scrollOffset Pixels added to the measured scroll position, advancing the window down the list.
 * @return {VirtualWindow} The slice to render and its geometry.
 */
export default function useVirtualization(
	listRef,
	rowHeight,
	totalRows,
	container = null,
	scrollOffset = 0
) {
	const [ scroll, setScroll ] = useState( { top: 0, height: 2160 } );

	useEffect( () => {
		const el = listRef.current;
		if ( ! el ) {
			return;
		}

		let scrollEl;
		if ( container === 'self' ) {
			scrollEl = el;
		} else if ( container ) {
			scrollEl = el.closest( container );
		} else {
			scrollEl = window;
		}

		const update = () => {
			let top, height;

			if ( container === 'self' ) {
				top = el.scrollTop;
				height = el.clientHeight;
			} else if ( container ) {
				const rect = el.getBoundingClientRect();
				const containerRect = scrollEl.getBoundingClientRect();
				top = Math.max( 0, containerRect.top - rect.top );
				height = containerRect.height;
			} else {
				const rect = el.getBoundingClientRect();
				if ( rect.bottom < 0 || rect.top > window.innerHeight ) {
					return;
				}
				top = Math.max( 0, -rect.top );
				height = window.innerHeight;
			}

			setScroll( { top, height } );
		};

		update();
		scrollEl?.addEventListener( 'scroll', update, { passive: true } );
		window.addEventListener( 'resize', update );

		return () => {
			scrollEl?.removeEventListener( 'scroll', update );
			window.removeEventListener( 'resize', update );
		};
	}, [ listRef, container ] );

	const effectiveTop = scroll.top + scrollOffset;
	const start = Math.max(
		0,
		Math.floor( effectiveTop / rowHeight ) - OVERSCAN
	);
	const count = Math.ceil( scroll.height / rowHeight ) + OVERSCAN * 2;
	const end = Math.min( totalRows, start + count );

	return {
		startIndex: start,
		endIndex: end,
		offsetTop: start * rowHeight,
		totalHeight: totalRows * rowHeight,
		paddingTop: start * rowHeight,
		paddingBottom: ( totalRows - end ) * rowHeight,
	};
}
