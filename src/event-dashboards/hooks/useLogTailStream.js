/**
 * useLogTailStream — mount ONE substrate `RemoteLink` on the canonical backbone
 * (`_command_interpreter → _router`) tailing a shared probe log, through a
 * pass-through stream Tee, into the view-model node React reads:
 *
 *   <name>:link    (RemoteLink — composes SseIn/HttpOut/Heartbeat + slot bridge)
 *   <name>:stream  (Tee — copies frames to the view)
 *   <name>:view    (the caller's view class)
 *
 * `mode` selects the INITIAL seek, and is read ONCE at connect:
 *   - 'history' → positions=start: the server replays the full retention so a
 *     tab can draw real rate graphs, not a thin client-side ring.
 *   - 'follow'  → tail-seek: current + live.
 *
 * A visibility-driven RECONNECT resumes from the last seen offset
 * (the stream's own cursor) instead, so the chart fills the hidden gap exactly
 * — no dropped span, and no re-replay of the whole retention.
 *
 * React reads the model via `useNodeState( '<name>:view', 'view' )`.
 */

import usePageVisibility from '@newspack-nodes/shared/hooks/usePageVisibility';
import { useVisibilityGatedLink } from '@newspack-nodes/shared/hooks/useVisibilityGatedLink';
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
 * @param {string} o.viewType  The view node class `make_node` resolves.
 * @param {string} [o.mode]    'history' (retention replay) or 'follow' (tail).
 */
export function useLogTailStream( {
	name,
	subscribe,
	viewType,
	mode = 'follow',
} ) {
	const isPageVisible = usePageVisibility();
	const seek = seekForMode( mode, subscribe );

	const link = `${ name }:link`;
	const tee = `${ name }:stream`;
	const view = `${ name }:view`;

	// Shared lifecycle owns close-while-hidden + resume-on-refocus.
	useVisibilityGatedLink( {
		mountNodes: ( interpreter ) => {
			// baseUrl/nonce resolve from the localized global, not tokens.
			const remote = interpreter.makeNode( 'RemoteLink', link, [
				subscribe,
			] );
			remote.target = tee;

			interpreter.makeNode( 'Tee', tee ).connectNode( view );
			interpreter.makeNode( viewType, view );
			return { link: remote };
		},
		isActive: isPageVisible,
		// A reopen states no seek; the stream resumes itself.
		onConnect: ( remote, { isReconnect } ) =>
			isReconnect ? remote.reconnect() : remote.connect( seek ),
	} );
}
