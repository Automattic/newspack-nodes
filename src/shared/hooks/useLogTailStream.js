/**
 * useLogTailStream — the ONE parameterised log tail behind every dashboard
 * whose subscription is DECLARED: the two probe charts, the Config Audit
 * timeline and every stream source. A dashboard that PICKS its log from a
 * catalog builds its graph through `useLogViewerGraph` instead.
 *
 * The two node names, the subscription and the opening seek all come from the
 * caller's declaration, so a new log costs a declaration rather than another
 * copy of this graph.
 *
 * `mode` picks the FIRST open's seek and nothing after it. 'history' asks for
 * the start of the log, so the server replays the whole retention and the tab
 * shows real history instead of a thin client-side ring; 'follow' states no
 * seek, so it streams live from the tail, or from where another graph on the
 * page already follows the same log.
 *
 * A visibility-driven RECONNECT resumes from the position the stream reached
 * instead, so the view fills the hidden gap exactly — no dropped span, and no
 * second replay of the retention. A stream that read nothing has no such
 * position and keeps the seed it opened with, which is what lets a history tab
 * refused its SSE slot still replay on its next open.
 *
 * React reads the model via `useNodeField( '<name>:view', 'view' )`.
 */

import { useStreamGraph } from './useStreamGraph';
import { SEEK_START } from '../../runtime/sse-in-node';

/**
 * The seek a declared tail first opens at, by its `mode`: 'history' asks for
 * the start of the log, so the server replays its whole retention, and
 * 'follow' states none, so it streams from the tail. A non-glob subscription
 * IS its dir name, so keying the seed on it is exact.
 *
 * An unrecognised mode throws rather than falling through to a tail-seek,
 * which would silently drop the replay the caller's view is drawn from.
 *
 * @param {string} mode      'history' (full replay) or 'follow' (tail).
 * @param {string} subscribe The concrete log dir the link tails.
 * @return {(Object<string,number>|undefined)} The positions seed, or none.
 * @throws {TypeError} On any other mode.
 */
function seekForMode( mode, subscribe ) {
	if ( 'history' === mode ) {
		return { [ subscribe ]: SEEK_START };
	}
	if ( 'follow' === mode ) {
		return undefined;
	}
	throw new TypeError( `unknown stream mode '${ mode }'` );
}

/**
 * Mount one declared log tail for the calling component's lifetime.
 *
 * A declared tail offers no seek or step, so a dashboard that drives those
 * calls `useStreamGraph` itself, and one that shows skipped lines hands its
 * subscription to `UnparseableLinesNotice`. The `useStreamGraph` handle it
 * answers pauses, filters and clears the view.
 *
 * @param {Object} o
 * @param {string} o.name      Stream name; the two node names derive from it.
 * @param {string} o.subscribe The concrete log dir to tail (e.g. `jobstats.p0`).
 * @param {any}    o.viewClass The view-model node's class, handed over rather
 *                             than named (ADR-16).
 * @param {string} [o.mode]    'history' (retention replay) or 'follow' (tail,
 *                             the default). Any other value throws.
 * @return {ReturnType<typeof useStreamGraph>} The stream graph's handle.
 */
export function useLogTailStream( {
	name,
	subscribe,
	viewClass,
	mode = 'follow',
} ) {
	return useStreamGraph( {
		prefix: name,
		subscribe,
		viewClass,
		openAt: seekForMode( mode, subscribe ),
	} );
}
