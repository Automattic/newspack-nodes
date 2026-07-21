/**
 * useJobstatsStream — mounts a single substrate `RemoteLink` onto the canonical
 * backbone (`_command_interpreter → _router`) tailing the shared `jobstats.p0` log,
 * feeding a `jobstats:view` view-model node:
 *
 *   jobstats:link   (RemoteLink — composes SseIn/HttpOut/Heartbeat + slot bridge)
 *   jobstats:view   (JobstatsView — per-identity rate series + last-run detail)
 *
 * `mode` selects the seek:
 *   - 'history' → positions=start: the server replays the full 24h retention so the
 *     Jobs tab can draw real runs/errors rate graphs (not a thin client-side ring).
 *   - 'follow'  → tail-seek (the default): current + live.
 *
 * The INITIAL connect uses the mode's seek; a visibility-driven RECONNECT resumes
 * from the last seen offset (`link.resumePositions()`) so the chart fills the hidden
 * gap exactly — no dropped span, and no re-replay of the whole 24h.
 *
 * React reads the model via `useNodeState('jobstats:view','view')`.
 */

import usePageVisibility from '@newspack-nodes/shared/hooks/usePageVisibility';
import { useVisibilityGatedLink } from '@newspack-nodes/shared/hooks/useVisibilityGatedLink';
import { CommandClient } from '../../runtime/command-client';
import '../nodes/register';

const LINK = 'jobstats:link';
const TEE = 'jobstats:stream';
const VIEW = 'jobstats:view';
// Explicit .p0 hits the no-worker log-feed fallback (jobstats is 1-part).
const SUBSCRIBE = 'jobstats.p0';

function positionsForMode( mode ) {
	// Flat `{ <concrete-dir>: pos }` seed — the subscription IS the dir name.
	return 'history' === mode ? { [ SUBSCRIBE ]: 'start' } : null;
}

/**
 * @param {Object} [opts]
 * @param {string} [opts.mode]          'history' (24h replay) or 'follow' (tail).
 * @param {Object} [opts.commandClient] CommandClient seam for the link's HttpOut.
 */
export function useJobstatsStream( { mode = 'follow', commandClient } = {} ) {
	const isPageVisible = usePageVisibility();

	// Shared lifecycle owns close-while-hidden + resume-on-refocus.
	useVisibilityGatedLink( {
		mountNodes: ( interpreter ) => {
			// baseUrl/nonce resolve from the localized global, not tokens.
			const link = interpreter.makeNode( 'RemoteLink', LINK, [
				SUBSCRIBE,
			] );
			// Pass-through stream Tee; copies frames to the view.
			link.target = TEE;
			link.client = commandClient || CommandClient.fromGlobal();

			const tee = interpreter.makeNode( 'Tee', TEE );
			tee.connectNode( VIEW );

			interpreter.makeNode( 'JobstatsView', VIEW );
			return { link };
		},
		isActive: isPageVisible,
		onConnect: ( link, { isReconnect } ) =>
			link.connect(
				isReconnect ? link.resumePositions() : positionsForMode( mode )
			),
	} );
}
