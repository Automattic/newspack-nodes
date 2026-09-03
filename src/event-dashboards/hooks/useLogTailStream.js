/**
 * useLogTailStream — the ONE parameterised log tail behind every dashboard
 * whose subscription is DECLARED: the two probe charts and the Config Audit
 * timeline. A dashboard that PICKS its log from a catalog builds its graph
 * through `useLogReaderGraph` instead.
 *
 * The three node names, the subscription and the opening seek all come from the
 * caller's declaration, so a new log costs a declaration rather than another
 * copy of this graph.
 *
 * `mode` picks the FIRST open's seek and nothing after it. 'history' asks for
 * the start of the log, so the server replays the whole retention and the tab
 * shows real history instead of a thin client-side ring; 'follow' tail-seeks to
 * current and streams live.
 *
 * A visibility-driven RECONNECT resumes from the position the stream reached
 * instead, so the view fills the hidden gap exactly — no dropped span, and no
 * second replay of the retention. A stream that read nothing has no such
 * position and keeps the seed it opened with, which is what lets a history tab
 * refused its SSE slot still replay on its next open.
 *
 * React reads the model via `useNodeState( '<name>:view', 'view' )`.
 */

import { useStreamGraph } from '@newspack-nodes/shared/hooks/useStreamGraph';
import { SEEK_START } from '../../runtime/sse-in-node';
import '../nodes/register';

/**
 * Build the flat `{ <concrete-dir>: position }` seed a mode opens with. A
 * non-glob subscription IS its dir name, so keying the seed on it is exact.
 *
 * An unrecognised mode throws rather than falling through to a tail-seek, which
 * would silently drop the retention replay the caller's view is drawn from.
 *
 * @param {string} mode      'history' (full replay) or 'follow' (tail).
 * @param {string} subscribe The concrete log dir the link tails.
 * @return {?Object<string,number>} The positions seed, or null to tail-seek.
 * @throws {TypeError} On any other mode.
 */
function seekForMode( mode, subscribe ) {
	if ( 'history' === mode ) {
		return { [ subscribe ]: SEEK_START };
	}
	if ( 'follow' === mode ) {
		return null;
	}
	throw new TypeError( `useLogTailStream: unknown mode '${ mode }'` );
}

/**
 * Mount one declared log tail for the calling component's lifetime.
 *
 * The `useStreamGraph` handle is dropped: a declared tail offers no pause, seek
 * or step control, so tab visibility is the whole gate on the SSE connection. A
 * dashboard that drives those controls calls `useStreamGraph` itself.
 *
 * @param {Object} o
 * @param {string} o.name      Stream name; the three node names derive from it.
 * @param {string} o.subscribe The concrete log dir to tail (e.g. `jobstats.p0`).
 * @param {any}    o.viewClass The view-model node's class, handed over rather
 *                             than named (ADR-16).
 * @param {string} [o.mode]    'history' (retention replay) or 'follow' (tail,
 *                             the default). Any other value throws.
 */
export function useLogTailStream( {
	name,
	subscribe,
	viewClass,
	mode = 'follow',
} ) {
	useStreamGraph( {
		prefix: name,
		subscribe,
		viewClass,
		openAt: seekForMode( mode, subscribe ),
	} );
}
