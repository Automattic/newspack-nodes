/**
 * useTopicProbeStream — mounts a single substrate `RemoteLink` onto the canonical
 * backbone (`_command_interpreter → _router`) tailing the shared `topicprobe.p0`
 * log, feeding a `topicprobe:view` view-model node:
 *
 *   topicprobe:link   (RemoteLink — composes SseIn/HttpOut/Heartbeat + slot bridge)
 *   topicprobe:view   (TopicProbeView — per-offsetlog_dir rate+backlog series)
 *
 * `mode` selects the seek:
 *   - 'history' → positions=start: the server replays the full 24h retention so
 *     the Overview tab can draw real byte-rate + backlog graphs (not a thin
 *     client-side ring).
 *   - 'follow'  → tail-seek (the default): current + live, for the Topologies tab.
 *
 * The INITIAL connect uses the mode's seek; a visibility-driven RECONNECT resumes
 * from the last seen offset (`link.resumePositions()`) so the chart fills the
 * hidden gap exactly — no dropped span, and no re-replay of the whole 24h.
 *
 * React reads the model via `useNodeState('topicprobe:view','view')`.
 */

import usePageVisibility from '@newspack-nodes/shared/hooks/usePageVisibility';
import { useVisibilityGatedLink } from '@newspack-nodes/shared/hooks/useVisibilityGatedLink';
import '../nodes/register';

const LINK = 'topicprobe:link';
const TEE = 'topicprobe:stream';
const VIEW = 'topicprobe:view';
// Explicit .p0 hits the server's no-worker log-feed fallback (probe is 1-part).
const SUBSCRIBE = 'topicprobe.p0';

function positionsForMode( mode ) {
	// Flat `{ <concrete-dir>: pos }` seed — the subscription IS the dir name.
	return 'history' === mode ? { [ SUBSCRIBE ]: 'start' } : null;
}

/**
 * @param {Object} [opts]
 * @param {string} [opts.mode]          'history' (24h replay) or 'follow' (tail).
 * @param {Object} [opts.commandClient] transport seam for the link and the backbone `_http`.
 */
export function useTopicProbeStream( { mode = 'follow', commandClient } = {} ) {
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

			const tee = interpreter.makeNode( 'Tee', TEE );
			tee.connectNode( VIEW );

			interpreter.makeNode( 'TopicProbeView', VIEW );
			return { link };
		},
		isActive: isPageVisible,
		commandClient,
		onConnect: ( link, { isReconnect } ) =>
			link.connect(
				isReconnect ? link.resumePositions() : positionsForMode( mode )
			),
	} );
}
