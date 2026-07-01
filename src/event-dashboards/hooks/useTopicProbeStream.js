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
import { CommandClient } from '../../runtime/command-client';
import '../nodes/register';

const LINK = 'topicprobe:link';
const TEE = 'topicprobe:stream';
const VIEW = 'topicprobe:view';
// Explicit `.p0` so the server's `{type}.p{N}` branch routes through its
// no-worker → log-feed fallback to `logs/topicprobe.p0` (the probe is always
// single-partition, regardless of the global num_partitions).
const SUBSCRIBE = 'topicprobe.p0';

function positionsForMode( mode ) {
	// Flat `{ <concrete-dir>: pos }` seed — the subscription IS the dir name.
	return 'history' === mode ? { [ SUBSCRIBE ]: 'start' } : null;
}

/**
 * @param {Object} [opts]
 * @param {string} [opts.mode]          'history' (24h replay) or 'follow' (tail).
 * @param {Object} [opts.commandClient] CommandClient seam for the link's HttpOut.
 */
export function useTopicProbeStream( { mode = 'follow', commandClient } = {} ) {
	const isPageVisible = usePageVisibility();

	// The shared lifecycle owns close-while-hidden + resume-on-refocus, and it
	// always invokes the latest mountNodes/onConnect — so `mode` / `commandClient`
	// are captured directly (no ref-wrapping needed). Here we only supply the graph
	// and the seek: the FIRST connect uses the mode's seek ('history' → 24h replay,
	// 'follow' → tail); a RECONNECT resumes from the last seen offset so the chart
	// fills the hidden gap without re-replaying the 24h.
	useVisibilityGatedLink( {
		mountNodes: ( interpreter ) => {
			const data =
				( typeof window !== 'undefined' && window.NewspackNodesData ) ||
				{};
			const baseUrl = data.restUrl || '/wp-json/';
			const nonce = data.nonce || '';

			const link = interpreter.makeNode(
				'RemoteLink',
				LINK,
				`${ SUBSCRIBE } ${ baseUrl } ${ nonce }`
			);
			// A pure pass-through Tee on the stream edge: the link re-homes received
			// frames to it, it copies each to the view. `connect topicprobe:stream` in
			// the debug overlay appends a second target to inspect the live stream.
			link.target = TEE;
			link.client =
				commandClient || new CommandClient( { baseUrl, nonce } );

			const tee = interpreter.makeNode( 'Tee', TEE );
			tee.connectNode( VIEW );

			interpreter.makeNode( 'TopicProbeView', VIEW );
			return { link };
		},
		isActive: isPageVisible,
		onConnect: ( link, { isReconnect } ) =>
			link.connect(
				isReconnect ? link.resumePositions() : positionsForMode( mode )
			),
	} );
}
