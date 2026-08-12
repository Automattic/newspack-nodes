/**
 * The page scrollbar's width, measured once and read by both the overlay's
 * frame clamp and the page-scroll lock's gutter compensation — two consumers of
 * one measurement, which is why it is not written twice.
 */

// No real scrollbar is this wide; a wider reading came from a bogus width.
const MAX_SCROLLBAR_W = 40;

/**
 * `innerWidth - clientWidth` is the scrollbar, when the numbers are plausible:
 * a 0 clientWidth (jsdom, and a page mid-layout) would otherwise report the
 * whole viewport as gutter and blank the page behind a viewport-wide padding.
 *
 * @return {number} Scrollbar width in px, or 0 when it cannot be trusted.
 */
export function scrollbarWidth() {
	const clientW = document.documentElement.clientWidth;
	const raw = window.innerWidth - clientW;
	return clientW > 0 && raw >= 0 && raw <= MAX_SCROLLBAR_W ? raw : 0;
}
