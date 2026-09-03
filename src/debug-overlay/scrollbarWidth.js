/**
 * Measure the page's scrollbar gutter for the debug overlay.
 *
 * The overlay's frame clamp keeps the panel's right edge clear of the gutter,
 * and the page-scroll lock pads that same width back when it hides the page's
 * overflow. Both read this one function, so the plausibility rule below cannot
 * drift into two versions that disagree on how wide the gutter is.
 */

/** No real scrollbar is this wide, so a wider reading is a bogus measurement. */
const MAX_SCROLLBAR_W = 40;

/**
 * Measure the scrollbar as `innerWidth - clientWidth`, refusing any reading
 * that cannot be one.
 *
 * A zero `clientWidth` — jsdom, and a page mid-layout — would otherwise report
 * the whole viewport as gutter and blank the page behind viewport-wide
 * padding. A negative difference is no gutter at all, and one above
 * `MAX_SCROLLBAR_W` is no scrollbar a browser draws. Every refusal returns 0,
 * which lays the page out as if it had none: wrong by at most a gutter's
 * width, where trusting a bad reading is wrong without bound.
 *
 * @return {number} Scrollbar width in px, or 0 when the reading cannot be trusted.
 */
export function scrollbarWidth() {
	const clientW = document.documentElement.clientWidth;
	const raw = window.innerWidth - clientW;
	return clientW > 0 && raw >= 0 && raw <= MAX_SCROLLBAR_W ? raw : 0;
}
