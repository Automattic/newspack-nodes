/**
 * Pin the page behind the overlay so it can't scroll while the pointer is inside
 * the panel. The canvas wheel's `preventDefault()` is ignored by Safari when the
 * event target is the SVG canvas (a WebKit quirk — it honors it from an HTML
 * listener but not the svg), so rather than fight it we physically lock the page
 * scroll.
 *
 * We lock overflow on BOTH `<html>` and `<body>`: Chrome's scrolling element is
 * `<html>`, but Safari ignores `overflow:hidden` on `<html>` and keeps scrolling
 * `<body>`, so locking only one element leaves Safari still scrolling. The
 * scrollbar gutter is compensated so the page doesn't shift.
 *
 * This module is the ONLY writer of those styles. Two owners saving and
 * restoring the same property under separate bookkeeping is how the page ended
 * up permanently unscrollable: whichever restored last wrote back the other's
 * `hidden`, with nobody left holding a lock to undo it. So the lock is held by
 * REASON — the pointer inside the panel, the panel being maximized — and only
 * the last reason to leave restores the saved styles.
 */

import { scrollbarWidth } from './scrollbarWidth';

const POINTER = 'pointer';
const holds = new Set();
let saved = null;

// WebKit-only CSS lock (ignores wheel PD on SVG); Chromium reflows, so skip it.
function needsCssScrollLock() {
	const ua = window.navigator?.userAgent || '';
	return /AppleWebKit/.test( ua ) && ! /Chrome|Chromium|Edg|OPR/.test( ua );
}

/**
 * Take a hold on the page-scroll lock, applying it if this is the first one.
 * Re-taking a hold already held is a no-op, so a repeated pointer-enter can't
 * save the hidden values over the originals.
 *
 * @param {string} reason Who is holding the lock.
 * @return {void}
 */
export function holdPageScroll( reason ) {
	if ( holds.has( reason ) ) {
		return;
	}
	holds.add( reason );
	if ( 1 !== holds.size ) {
		return;
	}
	const html = document.documentElement;
	const body = document.body;
	const gutter = scrollbarWidth();
	saved = {
		htmlOverflow: html.style.overflow,
		htmlPaddingRight: html.style.paddingRight,
		bodyOverflow: body.style.overflow,
	};
	html.style.overflow = 'hidden';
	body.style.overflow = 'hidden';
	if ( gutter > 0 ) {
		html.style.paddingRight = `${ gutter }px`;
	}
}

/**
 * Drop a hold, restoring the saved styles once no reason is left. Safe to call
 * for a hold that was never taken, which is what lets the panel release
 * unconditionally on unmount.
 *
 * @param {string} reason Who is releasing.
 * @return {void}
 */
export function releasePageScroll( reason ) {
	if ( ! holds.delete( reason ) || holds.size ) {
		return;
	}
	const html = document.documentElement;
	html.style.overflow = saved.htmlOverflow;
	html.style.paddingRight = saved.htmlPaddingRight;
	document.body.style.overflow = saved.bodyOverflow;
	saved = null;
}

/**
 * Hold the lock while the pointer is inside the panel. Only
 * WebKit-that-isn't-Chromium needs it — everywhere else the panel's own wheel
 * handler suffices, and this is a no-op that spares the reflow.
 *
 * Takes no arguments: it is wired straight to `onPointerEnter`, which would
 * otherwise hand its event along as the reason.
 *
 * @return {void}
 */
export function lockPageScroll() {
	if ( needsCssScrollLock() ) {
		holdPageScroll( POINTER );
	}
}

/**
 * Release the pointer hold. Wired straight to `onPointerLeave`, and to the
 * panel ref's detach.
 *
 * @return {void}
 */
export function unlockPageScroll() {
	releasePageScroll( POINTER );
}
