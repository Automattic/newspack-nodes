/**
 * useNarrow — the one read of whether a page is laid out for a narrow screen,
 * so every surface folds at the same width, and `useWidthBelow( px )`, the
 * same read at another width.
 *
 * One module-level MediaQueryList per width serves every reader of it: one
 * `change` listener, attached while anyone reads, fans out to a Set of React
 * subscribers.
 */

import { useCallback, useSyncExternalStore } from '@wordpress/element';

/**
 * The viewport width, in CSS pixels, below which a page is narrow.
 */
export const NARROW_PX = 600;

/**
 * One width's cached query and the subscribers its one listener feeds.
 *
 * @typedef {{ list: MediaQueryList, listeners: Set<() => void>, notify: () => void }} WidthSource
 */

/**
 * Each width's source, keyed by its px, built on first read.
 *
 * @type {Map<number, WidthSource>}
 */
const sources = new Map();

/**
 * The cached query for a width, built on first read.
 *
 * @param {number} px The width, in CSS pixels.
 * @return {?WidthSource} The source, or null where there is no matchMedia.
 */
function sourceFor( px ) {
	if ( ! sources.has( px ) && 'function' === typeof window.matchMedia ) {
		const listeners = new Set();
		sources.set( px, {
			list: window.matchMedia( `(width < ${ px }px)` ),
			listeners,
			notify: () => listeners.forEach( ( listener ) => listener() ),
		} );
	}
	return sources.get( px ) ?? null;
}

/**
 * Drops every cached query, so the next read builds one from the current
 * `window.matchMedia`.
 *
 * @testonly A suite that installs its own `matchMedia` calls it, through `test-utils/viewportWidth`.
 */
export function resetNarrow() {
	sources.forEach( ( own ) =>
		own.list.removeEventListener( 'change', own.notify )
	);
	sources.clear();
}

/**
 * Adds a React subscriber to a width, attaching its one listener for the first.
 *
 * @param {number}     px       The width, in CSS pixels.
 * @param {() => void} onChange Called when the answer may have changed.
 * @return {() => void} Unsubscribes, detaching the listener after the last.
 */
function subscribe( px, onChange ) {
	const own = sourceFor( px );
	if ( ! own ) {
		return () => {};
	}
	if ( 0 === own.listeners.size ) {
		own.list.addEventListener( 'change', own.notify );
	}
	own.listeners.add( onChange );
	return () => {
		own.listeners.delete( onChange );
		if ( 0 === own.listeners.size ) {
			own.list.removeEventListener( 'change', own.notify );
		}
	};
}

/**
 * Reads a width's cached query now, outside React's render.
 *
 * It can run ahead of the last render: between the viewport crossing and
 * the commit that follows, it already answers the new form.
 *
 * @param {number} px The width, in CSS pixels.
 * @return {boolean} True while the viewport is under `px`.
 */
export function isWidthBelow( px ) {
	return sourceFor( px )?.list.matches ?? false;
}

/**
 * The server has no viewport, so it renders wide.
 *
 * @return {boolean} False.
 */
const getServerSnapshot = () => false;

/**
 * Tracks whether the viewport is under `px`.
 *
 * The first render reads the live answer, so a narrow page never paints its
 * wide layout first.
 *
 * @param {number} px The width, in CSS pixels.
 * @return {boolean} True while the viewport is under `px`.
 */
export function useWidthBelow( px ) {
	const subscribeWidth = useCallback(
		( onChange ) => subscribe( px, onChange ),
		[ px ]
	);
	const read = useCallback( () => isWidthBelow( px ), [ px ] );
	return useSyncExternalStore( subscribeWidth, read, getServerSnapshot );
}

/**
 * Reads the narrow query now, outside React's render.
 *
 * @return {boolean} True while the viewport is under NARROW_PX.
 */
export function isNarrow() {
	return isWidthBelow( NARROW_PX );
}

/**
 * Tracks whether the viewport is under NARROW_PX.
 *
 * @return {boolean} True while the viewport is under NARROW_PX.
 */
export default function useNarrow() {
	return useWidthBelow( NARROW_PX );
}
