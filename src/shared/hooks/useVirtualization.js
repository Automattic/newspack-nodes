/**
 * Virtualization Hook — window / container-selector / 'self' scroll modes.
 */

import { useState, useEffect } from '@wordpress/element';

const OVERSCAN = 5;

/**
 * @param {Object}      listRef      Ref to list element.
 * @param {number}      rowHeight    Row height in pixels.
 * @param {number}      totalRows    Total row count.
 * @param {string|null} container    'self' | selector | null (window).
 * @param {number}      scrollOffset Extra offset added to scroll position.
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
