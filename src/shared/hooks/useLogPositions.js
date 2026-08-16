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
 *
 * `useSegmentBrowse` at the foot of the file composes this into the whole
 * browse controller a dashboard mounts: rail maintenance, the seek handlers,
 * and the rail itself.
 */

import { useState, useEffect, useCallback, useRef } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';

import LogBrowser from '../components/LogBrowser';
import { formatBytes } from '../utils/formatters';
import parseOffsetJump from '../utils/parseOffsetJump';
import useRouterTick from './useRouterTick';

// Rail maintenance cadence (segment rotation + size growth).
const SEGMENTS_REFRESH_MS = 10000;

/** A rail with nothing to re-catalog still needs a callable for the tick. */
const NOOP = () => {};

// One array, so "no segments" is the same value every render.
const NO_SEGMENTS = [];

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
 * @param {Object}  link      The RemoteLink, for the cursor it has reached.
 * @param {string}  sub       The subscription being stepped.
 * @param {?Object} positions The pending target's positions, if any.
 * @return {?string} The position argument, or null if there is no cursor.
 */
export function stepPosition( link, sub, positions ) {
	const cursor = positions?.[ sub ] ?? link.cursor( sub );
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

/**
 * The whole browse controller for a segmented stream: it keeps the rail fresh,
 * turns Live / Replay / segment-click / offset-jump into `seek()` calls, and
 * renders the rail. Both log-stream dashboards drive exactly this, so they get
 * it from here instead of writing all three out again — they differ in where
 * the source row COMES FROM (the Log Viewer reads it out of the catalog it
 * already holds; the Partition Viewer fetches `log_status` per partition), not
 * in what browsing one means.
 *
 * The source row rides every seek because it carries the replay boundary, and
 * both of its shapes matter: `segments` for a segmented log, `bytes` for a
 * file-mode source that has none (see `browseControl`).
 *
 * @param {Object}   o                     Controller inputs.
 * @param {string}   o.sub                 The subscription; '' disarms the rail.
 * @param {Object}   o.source              The source row (`{segments, bytes}`).
 * @param {Function} [o.refresh]           Re-catalog the rail, for a source whose
 *                                         segment list is not itself polled. Omit
 *                                         it and no rail timer is mounted.
 * @param {string}   [o.railName]          Timer node name for the refresh tick.
 * @param {string}   o.mode                Displayed 'live' | 'replay' (the view's).
 * @param {?number}  o.lastReceivedSegment Segment the last record arrived from.
 * @param {Function} o.seek                `(sub, positions, source?) => void`.
 * @param {Function} o.setPaused           Pause the stream for time travel.
 * @param {Function} o.step                Deliver one record while paused.
 * @return {{ jump: (text: string) => void, sidebar: import('react').ReactElement }}
 *   The offset-input handler and the configured rail.
 */
export function useSegmentBrowse( {
	sub,
	source,
	refresh,
	railName,
	mode,
	lastReceivedSegment,
	seek,
	setPaused,
	step,
} ) {
	const segments = source.segments ?? NO_SEGMENTS;
	const { segmentId, follow, browseSegment, replay } = useLogPositions( sub );

	useRouterTick( {
		name: railName ?? 'lograil:unused',
		onTick: refresh ?? NOOP,
		intervalMs: SEGMENTS_REFRESH_MS,
		enabled: Boolean( sub ) && Boolean( refresh ),
	} );

	// A record from an unknown segment = rotation; re-catalog once (no loops).
	const staleSegmentRef = useRef( null );
	useEffect( () => {
		if (
			! refresh ||
			null === lastReceivedSegment ||
			staleSegmentRef.current === lastReceivedSegment ||
			0 === segments.length ||
			segments.some( ( s ) => s.id === lastReceivedSegment )
		) {
			return;
		}
		staleSegmentRef.current = lastReceivedSegment;
		refresh?.();
	}, [ lastReceivedSegment, segments, refresh ] );

	// Time-travel: a past segment pauses; Step walks it, Play streams.
	const handleBrowseSegment = ( segment ) => {
		setPaused( true );
		seek( sub, browseSegment( segment.id ), source );
	};

	// A full ID or a bare offset pauses and steps that one message.
	const jump = ( text ) => {
		const position = parseOffsetJump(
			text,
			lastReceivedSegment ??
				( 'number' === typeof segmentId ? segmentId : null )
		);
		if ( ! position ) {
			return;
		}
		setPaused( true );
		browseSegment( position.segment );
		seek( sub, { [ sub ]: position }, source );
		step();
	};

	const sidebar = (
		<LogBrowser
			mode={ mode }
			onFollow={ () => seek( sub, follow() ) }
			onReplay={ () => seek( sub, replay(), source ) }
			items={ segments }
			selectedKey={ segmentId }
			activeKey={ lastReceivedSegment }
			onSelectItem={ handleBrowseSegment }
			itemKey={ ( s ) => s.id }
			itemLabel={ ( s ) =>
				sprintf(
					// translators: %d: log segment number.
					__( 'Segment %d', 'newspack-nodes' ),
					s.id
				)
			}
			itemMeta={ ( s ) => formatBytes( s.size ) }
			title={ __( 'Segments', 'newspack-nodes' ) }
			emptyLabel={ __( 'No segments', 'newspack-nodes' ) }
		/>
	);

	return { jump, sidebar };
}
