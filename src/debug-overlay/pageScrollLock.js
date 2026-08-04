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
 * scrollbar gutter is compensated so the page doesn't shift. Singleton: one
 * overlay at a time.
 */

let saved = null;

// WebKit-only CSS lock (ignores wheel PD on SVG); Chromium reflows, so skip it.
function needsCssScrollLock() {
	const ua = window.navigator?.userAgent || '';
	return /AppleWebKit/.test( ua ) && ! /Chrome|Chromium|Edg|OPR/.test( ua );
}

/**
 * Lock the page scroll and remember the styles being overwritten, so the panel
 * can restore them verbatim. Only WebKit-that-isn't-Chromium needs the lock;
 * everywhere else this is a no-op that spares the reflow. It is also a no-op
 * while a lock is already held, so a repeated pointer-enter can't save the
 * hidden values over the originals.
 *
 * @return {void}
 */
export function lockPageScroll() {
	if ( saved || ! needsCssScrollLock() ) {
		return;
	}
	const html = document.documentElement;
	const body = document.body;
	// Scrollbar gutter, clamped 0-40px (jsdom clientWidth 0 blanks the page).
	const rawGutter = window.innerWidth - html.clientWidth;
	const gutter = rawGutter > 0 && rawGutter <= 40 ? rawGutter : 0;
	saved = {
		htmlOverflow: html.style.overflow,
		htmlPaddingRight: html.style.paddingRight,
		bodyOverflow: body ? body.style.overflow : '',
	};
	html.style.overflow = 'hidden';
	if ( body ) {
		body.style.overflow = 'hidden';
	}
	if ( gutter > 0 ) {
		html.style.paddingRight = `${ gutter }px`;
	}
}

/**
 * Restore the overflow and padding saved by `lockPageScroll()` and release the
 * singleton. Safe to call when no lock is held, which is what lets the panel
 * unlock unconditionally on unmount.
 *
 * @return {void}
 */
export function unlockPageScroll() {
	if ( ! saved ) {
		return;
	}
	const html = document.documentElement;
	html.style.overflow = saved.htmlOverflow;
	html.style.paddingRight = saved.htmlPaddingRight;
	if ( document.body ) {
		document.body.style.overflow = saved.bodyOverflow;
	}
	saved = null;
}
