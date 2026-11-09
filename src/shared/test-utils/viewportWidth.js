/**
 * viewportWidth — a controllable `window.matchMedia`, so a suite can render a
 * component narrow or wide and cross `NARROW_PX` mid-test.
 *
 * Each install and each restore resets `useNarrow`'s cached query, so it reads
 * the stub in place rather than the one an earlier test left behind.
 */

import { resetNarrow } from '../hooks/useNarrow';

/**
 * The controls `installViewport()` hands back.
 *
 * @typedef {Object} Viewport
 * @property {string[]}                  queries   Every query `matchMedia` was asked.
 * @property {number}                    lists     How many MediaQueryLists it built.
 * @property {Set<Function>}             listeners The `change` listeners attached now.
 * @property {(narrow: boolean) => void} setNarrow Answers anew and notifies.
 * @property {(narrow: boolean) => void} answer    Answers anew without notifying, as a viewport does before its `change` event is delivered.
 * @property {() => void}                restore   Puts the earlier `matchMedia` back.
 */

/**
 * Installs a `matchMedia` whose every list answers `narrow`.
 *
 * @param {boolean} narrow The first answer.
 * @return {Viewport} The controls.
 */
export function installViewport( narrow ) {
	const original = window.matchMedia;
	const listeners = new Set();
	const state = { matches: narrow };
	const viewport = {
		queries: [],
		lists: 0,
		listeners,
		setNarrow( next ) {
			state.matches = next;
			listeners.forEach( ( listener ) => listener() );
		},
		answer( next ) {
			state.matches = next;
		},
		restore() {
			window.matchMedia = original;
			resetNarrow();
		},
	};
	window.matchMedia = ( query ) => {
		viewport.queries.push( query );
		viewport.lists += 1;
		return {
			media: query,
			get matches() {
				return state.matches;
			},
			onchange: null,
			addEventListener: ( type, listener ) => {
				listeners.add( listener );
			},
			removeEventListener: ( type, listener ) => {
				listeners.delete( listener );
			},
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => false,
		};
	};
	resetNarrow();
	return viewport;
}
