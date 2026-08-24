/**
 * useContainerRefit — re-run a callback when an element's box changes.
 *
 * Every chart and canvas in the tree hand-rolled this, and each copy carried
 * the same two defects: a window listener whose every event rebuilt the whole
 * SVG, and a bare `return` where ResizeObserver is missing, leaving the
 * element unable to re-fit at all.
 */

import { useEffect, useRef } from '@wordpress/element';

/**
 * The element's CONTENT box, measured the way an observation reports it.
 *
 * `clientWidth` is the padding box and is integer-rounded, so it is not
 * comparable to a `contentRect` without both corrections.
 *
 * @param {Object} el The observed element.
 * @return {{w: number, h: number}} Content width and height.
 */
const contentBox = ( el ) => {
	const style = window.getComputedStyle( el );
	const trim = ( a, b ) =>
		( parseFloat( style[ a ] ) || 0 ) + ( parseFloat( style[ b ] ) || 0 );
	return {
		w: Math.max(
			0,
			el.clientWidth - trim( 'paddingLeft', 'paddingRight' )
		),
		h: Math.max(
			0,
			el.clientHeight - trim( 'paddingTop', 'paddingBottom' )
		),
	};
};

/**
 * Within a pixel: one side is rounded, the other is not.
 *
 * @param {{w: number, h: number}} a One box.
 * @param {{w: number, h: number}} b The other.
 * @return {boolean} True when they describe the same layout.
 */
const same = ( a, b ) => Math.abs( a.w - b.w ) < 1 && Math.abs( a.h - b.h ) < 1;

/**
 * Debounced refit on container resize, falling back to the window.
 *
 * The container is what matters: a panel or sidebar can resize it while the
 * window never moves. Where ResizeObserver is missing the window is the only
 * signal left, and it is better than none.
 *
 * `observe()` reports the box the caller has just drawn, so acting on it costs
 * a redundant rebuild. Skipping the FIRST observation would be wrong — the
 * spec seeds the reported size to 0x0, so an element still hidden or unlaid
 * gets no initial observation and its real 0-to-N resize would be the one
 * swallowed. Only an UNCHANGED box is ignored — at the seed and at every
 * observation after it, so a callback feeding back into its own container
 * settles rather than looping.
 *
 * @param {Object|Function} ref        Ref to the observed element, or a
 *                                     resolver returning it, for an element
 *                                     reached through the DOM rather than held.
 *                                     Read once, at bind: it is deliberately
 *                                     NOT a dep, so an inline arrow does not
 *                                     rebuild the observer every render. Pass
 *                                     `deps` to re-bind on a new element.
 * @param {Function}        callback   Run after the box settles. Read through
 *                                     a ref, so an inline arrow is free and it
 *                                     never belongs in `deps`.
 * @param {Array}           deps       Re-bind when these change. Pass whatever
 *                                     makes `ref` resolve to a DIFFERENT
 *                                     element — binding is skipped entirely
 *                                     while it resolves to nothing, so a
 *                                     caller that renders null before its data
 *                                     arrives must list something that changes
 *                                     when it stops. Keep the length constant.
 * @param {number}          debounceMs Quiet period. 0 runs the callback in the
 *                                     observation itself, which is after
 *                                     layout and before paint — right for a
 *                                     measurement. A callback that resizes
 *                                     what it observes still runs once per
 *                                     distinct box, so it must converge.
 * @return {void}
 */
export function useContainerRefit(
	ref,
	callback,
	deps = [],
	debounceMs = 150
) {
	// An inline arrow would otherwise rebuild the observer every render.
	const cb = useRef( callback );
	cb.current = callback;

	useEffect( () => {
		const resolve = () =>
			typeof ref === 'function' ? ref() : ref?.current;
		const el = resolve();
		if ( ! el || typeof window === 'undefined' ) {
			return undefined;
		}
		let timer = null;
		const run = () => cb.current();
		const refit = () => {
			// A measurement wants the frame it was observed in.
			if ( ! debounceMs ) {
				run();
				return;
			}
			if ( timer ) {
				clearTimeout( timer );
			}
			timer = setTimeout( run, debounceMs );
		};
		const clear = () => timer && clearTimeout( timer );

		if ( typeof window.ResizeObserver === 'undefined' ) {
			window.addEventListener( 'resize', refit );
			return () => {
				clear();
				window.removeEventListener( 'resize', refit );
			};
		}

		// @longform `observe()` reports the box the caller has just drawn, so
		// acting on it costs a redundant rebuild. It is delivered only when
		// there IS a box: the spec seeds the reported size to 0x0, so a hidden
		// or unlaid element gets nothing, and its reveal is a real resize —
		// which is why an unmeasurable seed starts as no box at all rather
		// than as 0x0. Every LATER observation is compared the same way, so a
		// callback that resizes what it observes settles instead of looping.
		const seed = contentBox( el );
		let last = seed.w > 0 || seed.h > 0 ? seed : null;
		const ro = new window.ResizeObserver( ( entries ) => {
			const rect = entries?.[ 0 ]?.contentRect;
			const box = rect
				? { w: rect.width, h: rect.height }
				: contentBox( resolve() || el );
			if ( last && same( box, last ) ) {
				return;
			}
			last = box;
			refit();
		} );
		ro.observe( el );
		return () => {
			clear();
			ro.disconnect();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ debounceMs, ...deps ] );
}
