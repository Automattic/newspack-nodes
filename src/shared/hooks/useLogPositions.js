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

import { useState, useEffect, useCallback } from '@wordpress/element';

/**
 * The live-tail positions: none at all. Sending no position for a
 * subscription is what makes the server default its seek to 'end'.
 *
 * @return {null} Always null — the absent seek IS the tail.
 */
function tailPositions() {
	return null;
}

/**
 * Seek a subscription to the head of one concrete segment.
 *
 * @param {string} sub       The subscription (partition dir or log-source name).
 * @param {number} segmentId The segment to open; in file mode, the inode.
 * @return {Object} Positions keyed by subscription, holding a `{segment, offset}` seek.
 */
export function segmentPositions( sub, segmentId ) {
	return { [ sub ]: { segment: segmentId, offset: 0 } };
}

/**
 * Seek a subscription to the earliest retained record, using the magic
 * 'start' token the server resolves to offset 0 of the oldest segment.
 *
 * @param {string} sub The subscription (partition dir or log-source name).
 * @return {Object} Positions keyed by subscription, holding the 'start' token.
 */
export function replayPositions( sub ) {
	return { [ sub ]: 'start' };
}

/**
 * The read-verb position a Step should ask for: the pending seek if there is
 * one, else wherever the live stream left off. A magic token ('start' from
 * Replay) rides through verbatim — the read verbs speak the same vocabulary as
 * the seek transport — and an explicit cursor formats as `<segment>:<offset>`.
 *
 * @param {Object}  link      The RemoteLink (for resumePositions()).
 * @param {string}  sub       The subscription being stepped.
 * @param {?Object} positions The pending target's positions, if any.
 * @return {?string} The position argument, or null if there is no cursor.
 */
export function stepPosition( link, sub, positions ) {
	const cursor = positions?.[ sub ] ?? link.resumePositions()?.[ sub ];
	if ( 'string' === typeof cursor ) {
		return cursor;
	}
	if ( cursor && 'object' === typeof cursor ) {
		return `${ cursor.segment }:${ cursor.offset }`;
	}
	return null;
}

/**
 * The clicked-segment state, plus the actions that move it. Each action RETURNS
 * the SSE positions seed it just selected, because every caller needs that seed
 * in the same tick to hand to `seek()` — derived state arrives a render too
 * late, which is why the previous derived `positions` had no reader.
 *
 * The displayed Live/Replay mode is the VIEW's (`SeekTracker.mode`), not this
 * hook's: a second mode here meant two state machines over one concept, with
 * divergent vocabularies ('browse' vs 'replay').
 *
 * @param {string} sub The subscription (partition dir or log-source name).
 * @return {{ segmentId: (number|string|null), follow: Function, browseSegment: Function, replay: Function }}
 *   The clicked segment + the actions, each returning its positions seed.
 */
export default function useLogPositions( sub ) {
	// A number seeks that segment; 'start' replays; null tails.
	const [ segmentId, setSegmentId ] = useState( null );

	// Switching subscriptions drops any browse cursor back to the live tail.
	useEffect( () => {
		setSegmentId( null );
	}, [ sub ] );

	const follow = useCallback( () => {
		setSegmentId( null );
		return tailPositions();
	}, [] );

	const browseSegment = useCallback(
		( id ) => {
			setSegmentId( id );
			return segmentPositions( sub, id );
		},
		[ sub ]
	);

	const replay = useCallback( () => {
		setSegmentId( 'start' );
		return replayPositions( sub );
	}, [ sub ] );

	return { segmentId, follow, browseSegment, replay };
}
