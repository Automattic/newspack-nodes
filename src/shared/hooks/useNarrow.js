/**
 * useNarrow — the one read of whether a page is laid out for a narrow screen,
 * so every surface folds at the same width.
 *
 * One module-level MediaQueryList serves every reader: one `change` listener,
 * attached while anyone reads, fans out to a Set of React subscribers.
 */

import { useSyncExternalStore } from '@wordpress/element';

/**
 * The viewport width, in CSS pixels, below which a page is narrow.
 */
export const NARROW_PX = 600;

const NARROW_QUERY = `(width < ${ NARROW_PX }px)`;

/**
 * The cached query and the subscribers its one listener feeds.
 *
 * @type {?{ list: MediaQueryList, listeners: Set<() => void>, notify: () => void }}
 */
let source = null;

/**
 * The cached query, built on first read.
 *
 * @return {?typeof source} The source, or null where there is no matchMedia.
 */
function currentSource() {
	if ( ! source && 'function' === typeof window.matchMedia ) {
		const listeners = new Set();
		source = {
			list: window.matchMedia( NARROW_QUERY ),
			listeners,
			notify: () => listeners.forEach( ( listener ) => listener() ),
		};
	}
	return source;
}

/**
 * Drops the cached query, so the next read builds one from the current
 * `window.matchMedia`.
 *
 * @testonly A suite that installs its own `matchMedia` calls it, through `test-utils/viewportWidth`.
 */
export function resetNarrow() {
	source?.list.removeEventListener( 'change', source.notify );
	source = null;
}

/**
 * Adds a React subscriber, attaching the one listener for the first.
 *
 * @param {() => void} onChange Called when the answer may have changed.
 * @return {() => void} Unsubscribes, detaching the listener after the last.
 */
function subscribe( onChange ) {
	const own = currentSource();
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
 * Reads the cached query's answer now, outside React's render.
 *
 * It can run ahead of the last render: between the viewport crossing and
 * the commit that follows, it already answers the new form.
 *
 * @return {boolean} True while the viewport is under NARROW_PX.
 */
export function isNarrow() {
	return currentSource()?.list.matches ?? false;
}

/**
 * The server has no viewport, so it renders wide.
 *
 * @return {boolean} False.
 */
const getServerSnapshot = () => false;

/**
 * Tracks whether the viewport is under NARROW_PX.
 *
 * The first render reads the live answer, so a narrow page never paints its
 * wide layout first.
 *
 * @return {boolean} True while the viewport is under NARROW_PX.
 */
export default function useNarrow() {
	return useSyncExternalStore( subscribe, isNarrow, getServerSnapshot );
}
