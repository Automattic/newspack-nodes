/**
 * useLogPositions — the browse-model → SSE `positions` mapping shared by the
 * Partition Viewer and the Log Viewer (both browse segments; only file-MODE
 * log sources have none). Seeks ride the existing `positions` transport
 * verbatim (RemoteLink `setSubscribe(sub, positions)` → SSE `&positions=` →
 * `SSE_Out::position_arg` → `next_offset`):
 *
 *   - Live / follow → `null` positions ⇒ the server defaults each sub to 'end'.
 *   - Browse a segment → `{ [sub]: { segment, offset: 0 } }` (a `{segment,offset}`
 *     seek; in file mode the segment slot simply holds the inode).
 *   - Replay from start → `{ [sub]: 'start' }` (the magic token → offset 0 of the
 *     earliest segment).
 *   - Page back → the previous EXISTING segment id from the segment list.
 *
 * No new server verb is needed — the segment list rides the existing catalog
 * verbs (`log_status` for the Partition Viewer, `taillog sources` for the Log
 * Viewer).
 */

import { useState, useEffect, useMemo, useCallback } from '@wordpress/element';

// Live tail: no positions for the sub ⇒ the server seeks 'end'.
export function tailPositions() {
	return null;
}

// Open a concrete segment at its head.
export function segmentPositions( sub, segmentId ) {
	return { [ sub ]: { segment: segmentId, offset: 0 } };
}

// Replay from the earliest retained record (the magic 'start' seek).
export function replayPositions( sub ) {
	return { [ sub ]: 'start' };
}

// Largest existing segment id below currentId (spans gaps); null at the oldest.
export function previousSegmentId( segments, currentId ) {
	if ( 'number' !== typeof currentId ) {
		return null;
	}
	let prev = null;
	for ( const seg of segments ) {
		const id = seg?.id;
		if ( 'number' === typeof id && id < currentId ) {
			prev = null === prev ? id : Math.max( prev, id );
		}
	}
	return prev;
}

/**
 * @param {string} sub The subscription (partition dir or log-source name).
 * @return {{ mode: string, segmentId: (number|string|null), positions: (Object|null), follow: Function, browseSegment: Function, replay: Function, pageBack: Function }}
 *   Browse state + the derived positions + the actions that mutate it.
 */
export default function useLogPositions( sub ) {
	const [ mode, setMode ] = useState( 'live' );
	// A number seeks that segment; 'start' replays; null tails.
	const [ segmentId, setSegmentId ] = useState( null );

	// Switching subscriptions drops any browse cursor back to the live tail.
	useEffect( () => {
		setMode( 'live' );
		setSegmentId( null );
	}, [ sub ] );

	const follow = useCallback( () => {
		setMode( 'live' );
		setSegmentId( null );
	}, [] );

	const browseSegment = useCallback( ( id ) => {
		setMode( 'browse' );
		setSegmentId( id );
	}, [] );

	const replay = useCallback( () => {
		setMode( 'browse' );
		setSegmentId( 'start' );
	}, [] );

	const pageBack = useCallback( ( segments ) => {
		setSegmentId( ( current ) => {
			const prev = previousSegmentId( segments, current );
			return null === prev ? current : prev;
		} );
	}, [] );

	const positions = useMemo( () => {
		if ( 'live' === mode ) {
			return tailPositions();
		}
		if ( 'start' === segmentId ) {
			return replayPositions( sub );
		}
		return segmentPositions( sub, segmentId );
	}, [ mode, segmentId, sub ] );

	return {
		mode,
		segmentId,
		positions,
		follow,
		browseSegment,
		replay,
		pageBack,
	};
}
