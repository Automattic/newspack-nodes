/**
 * What the page's chrome takes from the viewport: the scrollbar gutter, and
 * WordPress's admin bar and admin menu, whose space each caller decides how
 * to reserve.
 */

/** No real scrollbar is this wide, so a wider reading is a bogus measurement. */
const MAX_SCROLLBAR_W = 40;

/**
 * Measure the scrollbar as `innerWidth - clientWidth`, refusing any reading
 * that cannot be one.
 *
 * A zero `clientWidth` — jsdom, and a page mid-layout — would otherwise report
 * the whole viewport as gutter and blank the page behind viewport-wide
 * padding. A negative difference is not a gutter at all, and one above
 * `MAX_SCROLLBAR_W` is not a scrollbar any browser draws. Every refusal returns 0,
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

/** A hidden box fixed over the client box, made on first use. */
let sentinel = null;

/**
 * The client box, the viewport less its scrollbar gutters on whichever side
 * the browser draws them, as a hidden fixed box pinned to all four edges sees
 * it.
 *
 * @return {{left:number,top:number,right:number,bottom:number}} Viewport px.
 */
export function clientBox() {
	if ( ! sentinel?.isConnected ) {
		sentinel = document.createElement( 'div' );
		sentinel.className = 'newspack-nodes-client-box';
		sentinel.setAttribute( 'aria-hidden', 'true' );
		sentinel.style.cssText =
			'position:fixed;top:0;right:0;bottom:0;left:0;visibility:hidden;pointer-events:none';
		document.body.appendChild( sentinel );
	}
	const { left, top, right, bottom } = sentinel.getBoundingClientRect();
	return { left, top, right, bottom };
}

/**
 * The viewport rectangles of WordPress's admin bar and admin menu, read fresh,
 * each null where the page lacks it or does not display it, and the side the
 * menu stands on: the right where RTL draws it, else the left.
 *
 * @return {{bar:?DOMRect,menu:?DOMRect,menuSide:?('left'|'right')}} The chrome.
 */
export function adminChromeRects() {
	const rect = ( id ) => {
		const box = document.getElementById( id )?.getBoundingClientRect();
		return box?.width && box.height ? box : null;
	};
	const menu = rect( 'adminmenuwrap' );
	/** @type {?('left'|'right')} */
	let menuSide = null;
	if ( menu ) {
		menuSide =
			menu.left + menu.right > window.innerWidth ? 'right' : 'left';
	}
	return { bar: rect( 'wpadminbar' ), menu, menuSide };
}
