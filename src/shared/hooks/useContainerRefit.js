/**
 * useContainerRefit — re-run a callback when an element's box changes.
 *
 * Every chart and canvas refits through this one hook: a debounce, so a drag
 * across a panel edge costs one rebuild rather than one per resize event, and
 * a window listener where ResizeObserver is missing, so the element refits
 * instead of freezing at the width it was first drawn at.
 */

import { useEffect, useRef } from '@wordpress/element';

/**
 * The element's CONTENT box, measured the way an observation reports it.
 *
 * `clientWidth` is the padding box, so the padding comes off here; it is also
 * integer-rounded, which `same()` absorbs. The clamp earns its place because
 * `clientWidth` already excludes the scrollbar gutter, so a padded panel
 * mid-animation measures narrower than its own padding — layout calls that 0,
 * and a negative matches no observation.
 *
 * @param {Element} el The observed element.
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
 * Within a pixel, because a seed read from `clientWidth` is integer-rounded
 * and the `contentRect` it is compared against is not.
 *
 * @param {{w: number, h: number}} a One box.
 * @param {{w: number, h: number}} b The other.
 * @return {boolean} True when they describe the same layout.
 */
const same = ( a, b ) => Math.abs( a.w - b.w ) < 1 && Math.abs( a.h - b.h ) < 1;

/**
 * The observed element: a ref holding it, or a resolver reaching it through
 * the DOM — a sibling or an ancestor no component holds a ref to.
 *
 * @typedef {{current: ?Element}|(() => ?Element)} ElementSource
 */

/**
 * Debounced refit on container resize, falling back to the window.
 *
 * The container is what matters: a panel or sidebar can resize it while the
 * window never moves. Where ResizeObserver is missing the window is the only
 * signal left, and it is better than none. With no window at all — a server
 * render — nothing binds.
 *
 * An unchanged box never reaches the callback. That is what drops the
 * observation `observe()` delivers on bind, reporting the box the caller has
 * just drawn, and what makes a callback that resizes its own container settle
 * instead of loop. Nothing is skipped for being FIRST, so an element hidden
 * at bind still refits when it is revealed.
 *
 * @param {ElementSource} ref          The observed element, held or resolved.
 *                                     Read once, at bind: it is deliberately
 *                                     NOT a dep, so an inline arrow does not
 *                                     rebuild the observer every render. Pass
 *                                     `deps` to re-bind on a new element.
 * @param {() => void}    callback     Run after the box settles. Read through
 *                                     a ref, so an inline arrow is free and it
 *                                     never belongs in `deps`.
 * @param {Array}         [deps]       Re-bind when these change. Pass whatever
 *                                     makes `ref` resolve to a DIFFERENT
 *                                     element — binding is skipped entirely
 *                                     while it resolves to nothing, so a
 *                                     caller that renders null before its data
 *                                     arrives must list something that changes
 *                                     when it stops. Keep the length constant.
 * @param {number}        [debounceMs] Quiet period, 150ms by default. 0 runs
 *                                     the callback in the observation itself,
 *                                     which is after layout and before paint —
 *                                     right for a measurement. A callback that
 *                                     resizes what it observes still runs once
 *                                     per distinct box, so it must converge.
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

		// @longform The seed is what `observe()`'s own observation is compared
		// against, so the box the caller has just drawn costs no rebuild. A
		// measurement of 0x0 means unmeasurable — hidden, unlaid — as often as
		// it means empty, so an unmeasurable element seeds no box at all and
		// the first observation to arrive always runs.
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
