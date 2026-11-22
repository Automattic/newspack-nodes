/**
 * viewportWidth — a controllable `window.matchMedia`, so a suite can render a
 * component narrow or wide and cross `NARROW_PX` mid-test.
 *
 * Each query answers on its own terms. A width query answers from the
 * viewport, `narrow` until `setNarrow` or `answer` moves it.
 * `(prefers-reduced-motion: reduce)` answers `reducedMotion`, false unless the
 * test opts in, so a narrow test still sees a dialog's exit play. Any other
 * query answers false.
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

/** The one non-width query a shared component asks. */
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * Installs a `matchMedia` whose width lists answer `narrow`.
 *
 * @param {boolean} narrow                  The width queries' first answer.
 * @param {Object}  [options]
 * @param {boolean} [options.reducedMotion] What the reduced-motion query answers.
 * @return {Viewport} The controls.
 */
export function installViewport( narrow, { reducedMotion = false } = {} ) {
	const original = window.matchMedia;
	const listeners = new Set();
	const state = { matches: narrow };
	const answerOf = ( query ) => {
		if ( REDUCED_MOTION === query ) {
			return reducedMotion;
		}
		return /\bwidth\b/.test( query ) && state.matches;
	};
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
				return answerOf( query );
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
