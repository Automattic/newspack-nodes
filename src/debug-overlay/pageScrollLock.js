/**
 * Pin the page behind the overlay so it can't scroll while the pointer is inside
 * the panel. The canvas wheel's `preventDefault()` is ignored by Safari when the
 * event target is the SVG canvas (a WebKit quirk — it honours it from an HTML
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

export function lockPageScroll() {
	if ( saved ) {
		return;
	}
	const html = document.documentElement;
	const body = document.body;
	// Width of the scrollbar gutter that disappears when overflow is hidden.
	const gutter = window.innerWidth - html.clientWidth;
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
