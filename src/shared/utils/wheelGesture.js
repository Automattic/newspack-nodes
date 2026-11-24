/**
 * The wheel gestures every canvas shares: which events pan and which zoom,
 * how far a wheel event travelled, and the one step a notch or a key zooms by.
 */

/**
 * Multiplicative zoom per wheel notch, applied around the cursor, and per
 * press of the zoom keys, applied around the canvas centre.
 */
export const ZOOM_STEP = 1.12;

/**
 * Pixels of wheel travel that count as one notch. A mouse notch arrives as
 * one event of a whole notch; a touchpad swipe as dozens of small ones, each
 * moving the view by its own share.
 */
const WHEEL_NOTCH_PX = 100;

/**
 * Lines of wheel travel that count as one notch, for a wheel the browser
 * reports in lines.
 */
const WHEEL_NOTCH_LINES = 3;

/**
 * What a pinch's deltas are scaled by. A browser delivers a touchpad pinch as
 * a wheel event with `ctrlKey` set and a few pixels of delta per step, so at
 * face value a pinch would crawl; d3-zoom applies the same factor.
 */
const PINCH_GAIN = 10;

/**
 * Zoom keys and the factor each applies; `+` and `_` are the shifted spellings
 * of `=` and `-` on the keyboards where they share a key.
 */
export const KEY_ZOOM = {
	'=': 1 / ZOOM_STEP,
	'+': 1 / ZOOM_STEP,
	'-': ZOOM_STEP,
	_: ZOOM_STEP,
};

/**
 * How many notches a wheel event travelled, capped at one either way.
 *
 * @param {WheelEvent} e The wheel event.
 * @return {number} Notches in -1..1; positive scrolls down.
 */
export const wheelNotches = ( e ) => {
	if ( window.WheelEvent.DOM_DELTA_PAGE === e.deltaMode ) {
		return Math.sign( e.deltaY );
	}
	const unit =
		window.WheelEvent.DOM_DELTA_LINE === e.deltaMode
			? WHEEL_NOTCH_LINES
			: WHEEL_NOTCH_PX;
	const gain = e.ctrlKey ? PINCH_GAIN : 1;
	return Math.max( -1, Math.min( 1, ( gain * e.deltaY ) / unit ) );
};

/**
 * Milliseconds without a wheel event that end a stream. A swipe keeps
 * sending events for its momentum long after the fingers lift, and those
 * trailing ones carry none of the signs that marked it a swipe.
 */
const STREAM_GAP_MS = 150;

/**
 * Whether a wheel event is a two-finger trackpad swipe, which pans, rather
 * than a wheel notch, which zooms.
 *
 * No browser says which device sent a wheel event, so this reads the signs a
 * trackpad leaves: any sideways travel, or the legacy `wheelDeltaY` Chrome and
 * Safari report on macOS as exactly -3 times `deltaY` for a trackpad and as
 * whole notches of 120 for a wheel. Elsewhere a swipe with no sideways travel
 * reads as a wheel and zooms. A line- or page-mode delta is a wheel. A held
 * Ctrl (a pinch) or command key zooms whatever the event looks like, which is
 * how a smooth-scrolling mouse the heuristic mistakes for a trackpad zooms.
 *
 * @param {WheelEvent} e The wheel event.
 * @return {boolean} True for a swipe.
 */
const isSwipe = ( e ) => {
	if ( e.ctrlKey || e.metaKey ) {
		return false;
	}
	if ( window.WheelEvent.DOM_DELTA_PIXEL !== e.deltaMode ) {
		return false;
	}
	if ( 0 !== e.deltaX ) {
		return true;
	}
	// Non-standard, so the DOM types do not declare it.
	const legacy = /** @type {WheelEvent & {wheelDeltaY?: number}} */ ( e )
		.wheelDeltaY;
	return (
		'number' === typeof legacy && 0 !== e.deltaY && legacy === -3 * e.deltaY
	);
};

/**
 * A canvas's wheel stream. Its verdict is latched: the first event of a
 * stream decides it, so momentum cannot flip it, and a pause or a changed
 * modifier starts a new one.
 *
 * @return {(e: WheelEvent) => 'pan'|'zoom'} The verdict for each event.
 */
export function createWheelStream() {
	const stream = { swipe: false, zooming: false, at: -Infinity };
	return ( e ) => {
		const zooming = e.ctrlKey || e.metaKey;
		if (
			zooming !== stream.zooming ||
			e.timeStamp - stream.at > STREAM_GAP_MS
		) {
			stream.swipe = isSwipe( e );
			stream.zooming = zooming;
		}
		stream.at = e.timeStamp;
		return stream.swipe ? 'pan' : 'zoom';
	};
}
