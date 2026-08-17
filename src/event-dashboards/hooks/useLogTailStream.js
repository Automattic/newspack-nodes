/**
 * useLogTailStream — a `useStreamGraph` tailing one shared probe log, declared
 * by the dashboards that draw charts from it.
 *
 * `mode` selects the INITIAL seek, and is read ONCE at connect:
 *   - 'history' → positions=start: the server replays the full retention so a
 *     tab can draw real rate graphs, not a thin client-side ring.
 *   - 'follow'  → tail-seek: current + live.
 *
 * A visibility-driven RECONNECT resumes from the last seen offset (the stream's
 * own cursor) instead, so the chart fills the hidden gap exactly — no dropped
 * span, and no re-replay of the whole retention.
 *
 * React reads the model via `useNodeState( '<name>:view', 'view' )`.
 */

import { useStreamGraph } from '@newspack-nodes/shared/hooks/useStreamGraph';
import { SEEK_START } from '../../runtime/sse-in-node';
import '../nodes/register';

/**
 * The flat `{ <concrete-dir>: pos }` seed for a mode — the subscription IS the
 * dir name. An unrecognised mode REFUSES: falling through to a tail-seek drops
 * the retention replay the caller's charts are drawn from, silently.
 *
 * @param {string} mode      'history' (full replay) or 'follow' (tail).
 * @param {string} subscribe The concrete log dir the link tails.
 * @return {?Object} The positions seed, or null to tail-seek.
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
 * @param {Object} o
 * @param {string} o.name      Stream name; the three node names derive from it.
 * @param {string} o.subscribe The concrete log dir to tail (e.g. `jobstats.p0`).
 * @param {any}    o.viewClass The view-model node's class.
 * @param {string} [o.mode]    'history' (retention replay) or 'follow' (tail).
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
