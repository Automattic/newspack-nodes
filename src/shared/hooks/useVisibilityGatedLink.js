/**
 * useVisibilityGatedLink — the SSE analog of `useBatchedPoll`: own the
 * connection lifecycle of a mountExospine'd `RemoteLink` so every streaming
 * dashboard shares ONE implementation of "close the stream while inactive, and
 * on refocus RECONNECT the same link instead of tail-dropping the gap that
 * accumulated while hidden."
 *
 * The caller supplies the graph construction (`mountNodes`) and how to (re)open
 * the stream (`onConnect`); this hook owns the refs, the build/teardown via
 * `mountExospine`, the re-render trigger, and the visibility/pause connection
 * effect — including the two guards that make resume correct:
 *
 *   - `hasConnectedRef` (reset per (re)build; a fresh link's SseIn has no tracked
 *     offset) tells `onConnect` whether this is the FIRST connect of a link
 *     (open at the caller's default seek) or a RECONNECT (resume from the last
 *     seen offset). Callers pass `isReconnect ? link.resumePositions() : <first>`.
 *   - `connectedLinkRef` records which link is currently streaming, so a
 *     redundant re-render never tears a live seek down into a tail reconnect
 *     (nor re-runs a pre-connect side effect like the gyroscope view-clear).
 *
 * The Partition/Log Viewers deliberately do NOT use this hook: their
 * catalog-driven, user-selected `setSubscribe([selected], …)` flow is not
 * visibility-gated connect and does not fit the `mountNodes`/`onConnect` shape.
 *
 * @param {Object}   o
 * @param {Function} o.mountNodes `(interpreter) => { link, view? }` — construct the
 *                                RemoteLink (+ Tee + view) and return the live handles. The hook stamps
 *                                `linkRef`/`viewRef`, resets the first-connect flag, and owns `link.removeNode()`.
 * @param {boolean}  o.isActive   Whether the stream should be open right now
 *                                (typically `pageVisible && ! paused`). False closes the stream.
 * @param {Function} o.onConnect  `(link, { isReconnect, view }) => void` — open the
 *                                stream. Typically `link.connect( isReconnect ? link.resumePositions() : first )`.
 * @return {{ viewRef: Object }} The live view-node ref, for the caller's control
 *   callbacks (e.g. setPaused / clear publishing through the view).
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { mountExospine } from '@newspack-nodes/runtime';

export function useVisibilityGatedLink( { mountNodes, isActive, onConnect } ) {
	const linkRef = useRef( null );
	const viewRef = useRef( null );
	const hasConnectedRef = useRef( false );
	const connectedLinkRef = useRef( null );
	const [ buildGen, bumpBuild ] = useState( 0 );

	// Read latest callbacks without re-running the effect on identity change.
	const mountNodesRef = useRef( mountNodes );
	mountNodesRef.current = mountNodes;
	const onConnectRef = useRef( onConnect );
	onConnectRef.current = onConnect;

	// Mount once; cleanup runs FIRST so a rebuild clears connectedLinkRef.
	useEffect( () => {
		const build = ( { interpreter } ) => {
			const { link, view } = mountNodesRef.current( interpreter );
			linkRef.current = link;
			viewRef.current = view ?? null;
			// Fresh link's SseIn has no offset; connect uses the default seek.
			hasConnectedRef.current = false;
			// Re-render so the connection effect runs against the fresh link.
			bumpBuild( ( n ) => n + 1 );
			return () => {
				link.removeNode();
				linkRef.current = null;
				viewRef.current = null;
				connectedLinkRef.current = null;
			};
		};
		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

	// Own the live SSE connection: open while active, else close.
	useEffect( () => {
		const link = linkRef.current;
		if ( ! buildGen || ! link ) {
			return undefined;
		}
		if ( ! isActive ) {
			link.close();
			connectedLinkRef.current = null;
			return undefined;
		}
		// Already streaming this link; a re-render must NOT tear the seek.
		if ( connectedLinkRef.current === link ) {
			return undefined;
		}
		const isReconnect = hasConnectedRef.current;
		hasConnectedRef.current = true;
		connectedLinkRef.current = link;
		onConnectRef.current( link, { isReconnect, view: viewRef.current } );
		return undefined;
	}, [ buildGen, isActive ] );

	return { viewRef };
}
