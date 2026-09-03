/**
 * Pin the page behind the debug overlay so it cannot scroll while the pointer
 * sits inside the panel.
 *
 * Safari ignores the wheel handler's `preventDefault()` when the event target
 * is the SVG canvas — it honors the identical call from an HTML listener — so
 * the panel's own wheel eater leaves the page scrolling underneath. This
 * module locks the scroll physically instead of fighting that.
 *
 * The lock sets `overflow` on BOTH `<html>` and `<body>`: Chrome's scrolling
 * element is `<html>`, while Safari ignores `overflow:hidden` there and keeps
 * scrolling `<body>`, so locking one element leaves the other browser
 * scrolling. Right padding compensates for the scrollbar gutter the lock
 * reclaims, which keeps the page from shifting sideways as it engages.
 *
 * This module is the ONLY writer of those three styles. Two owners saving and
 * restoring the same property under separate bookkeeping leave the page
 * permanently unscrollable: whichever restores last writes the other's
 * `hidden` back, and no lock remains to undo it. So a hold is keyed by REASON
 * — the pointer inside the panel, the panel maximized — and only the last
 * reason to leave restores the saved styles.
 */

import { scrollbarWidth } from './scrollbarWidth';

/** Reason key for the hold the pointer takes on entering the panel. */
const POINTER = 'pointer';

/**
 * Every reason currently holding the lock. Empty means the page scrolls.
 *
 * @type {Set<string>}
 */
const holds = new Set();

/**
 * The inline styles the first hold captures and the last release writes back.
 * Null while no hold stands.
 *
 * @type {?{htmlOverflow:string,htmlPaddingRight:string,bodyOverflow:string}}
 */
let saved = null;

/**
 * Does this browser need the CSS lock?
 *
 * Only WebKit that is not Chromium ignores `preventDefault()` on a wheel event
 * over the SVG canvas; everywhere else the panel's wheel eater suffices and
 * the lock would buy a reflow for nothing. Sniffing the user agent is the only
 * test available, because no feature query reports whether a wheel
 * `preventDefault()` will be honored.
 *
 * @return {boolean} True on WebKit browsers that are not Chromium.
 */
function needsCssScrollLock() {
	const ua = window.navigator?.userAgent || '';
	return /AppleWebKit/.test( ua ) && ! /Chrome|Chromium|Edg|OPR/.test( ua );
}

/**
 * Take a hold on the page-scroll lock, applying it when this is the first one.
 *
 * Re-taking a hold already held is a no-op, so a repeated pointer-enter cannot
 * save the hidden values over the originals and strand the page unscrollable.
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
 * Drop a hold, restoring the saved styles once no reason is left.
 *
 * Dropping a hold that was never taken is a no-op, which is what lets the
 * panel release unconditionally when its ref detaches.
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
 * Hold the lock while the pointer is inside the panel.
 *
 * Only WebKit that is not Chromium needs it; everywhere else this is a no-op
 * that spares the reflow. It takes no arguments because it is wired straight
 * to `onPointerEnter`, which would otherwise hand its event along as the
 * reason.
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
 * It skips the `needsCssScrollLock()` test its counterpart makes: a hold once
 * taken must come off whatever the browser now reports, and a release nobody
 * is holding is already a no-op.
 *
 * @return {void}
 */
export function unlockPageScroll() {
	releasePageScroll( POINTER );
}
