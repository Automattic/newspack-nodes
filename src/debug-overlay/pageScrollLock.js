/**
 * Pin the page behind the overlay so it can't scroll while the pointer is inside
 * the panel. The canvas wheel's `preventDefault()` is ignored by Safari when the
 * event target is the SVG canvas (a WebKit quirk — it honours it from an HTML
 * listener but not the svg), so rather than fight it we physically lock the page
 * scroll element. Scrollbar-compensated so the page doesn't shift when the lock
 * toggles. Singleton: one overlay at a time.
 */

let saved = null;

export function lockPageScroll() {
	if ( saved ) {
		return;
	}
	const el = document.scrollingElement || document.documentElement;
	// Width of the scrollbar gutter that disappears when we hide overflow.
	const gutter = window.innerWidth - document.documentElement.clientWidth;
	saved = {
		el,
		overflow: el.style.overflow,
		paddingRight: el.style.paddingRight,
	};
	el.style.overflow = 'hidden';
	if ( gutter > 0 ) {
		el.style.paddingRight = `${ gutter }px`;
	}
}

export function unlockPageScroll() {
	if ( ! saved ) {
		return;
	}
	saved.el.style.overflow = saved.overflow;
	saved.el.style.paddingRight = saved.paddingRight;
	saved = null;
}
