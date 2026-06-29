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

import { useEffect, useRef, useState } from '@wordpress/element';
import { mountExospine } from '../../runtime/exospine';
import usePageVisibility from '@newspack-nodes/shared/hooks/usePageVisibility';
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
	const modeRef = useRef( mode );
	modeRef.current = mode;
	const optsRef = useRef( { commandClient } );
	optsRef.current = { commandClient };

	const linkRef = useRef( null );
	// First connect of a link uses the mode's seek; a hide→show reconnect of the
	// SAME link tail-follows. `connectedLinkRef` records which link is currently
	// streaming, so a re-render never reconnects (→ tail) a link already on its
	// seek connection — and a REBUILT link (exospine reinit, e.g. Reset Graph or a
	// co-mounted dashboard's rebuild) is reconnected even though `isPageVisible`
	// never changed. `buildGen` bumps on each build to re-run the connect effect.
	const hasConnectedRef = useRef( false );
	const connectedLinkRef = useRef( null );
	const [ buildGen, bumpBuildGen ] = useState( 0 );

	const isPageVisible = usePageVisibility();

	useEffect( () => {
		const build = ( { interpreter } ) => {
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
				optsRef.current.commandClient ||
				new CommandClient( { baseUrl, nonce } );

			const tee = interpreter.makeNode( 'Tee', TEE );
			tee.connectNode( VIEW );

			interpreter.makeNode( 'TopicProbeView', VIEW );
			linkRef.current = link;

			// A fresh link: re-seek from the mode's position; the connect effect
			// re-runs because buildGen changes.
			hasConnectedRef.current = false;
			bumpBuildGen( ( n ) => n + 1 );

			return () => {
				link.removeNode();
				linkRef.current = null;
				connectedLinkRef.current = null;
			};
		};

		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

	useEffect( () => {
		const link = linkRef.current;
		if ( ! link ) {
			return;
		}
		if ( ! isPageVisible ) {
			link.close();
			connectedLinkRef.current = null;
			return;
		}
		// Already streaming this exact link — a buildGen re-render must NOT tear the
		// seek connection down into a tail reconnect.
		if ( connectedLinkRef.current === link ) {
			return;
		}
		// A reconnect (already connected once) resumes from the last seen offset so
		// the chart fills the hidden gap; the first connect uses the mode's seek.
		const positions = hasConnectedRef.current
			? link.resumePositions()
			: positionsForMode( modeRef.current );
		hasConnectedRef.current = true;
		connectedLinkRef.current = link;
		link.connect( positions );
	}, [ isPageVisible, buildGen ] );
}
