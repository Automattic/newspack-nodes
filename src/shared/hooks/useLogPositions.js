/**
 * The browse model both log-stream dashboards share, expressed as the SSE
 * `positions` seed their transport already carries. The Partition Viewer and
 * the Log Viewer both browse segments; only a file-mode log source has none.
 *
 * A seek needs no transport of its own. `RemoteLink.setSubscribe( sub,
 * positions )` puts the seed on the stream URL as `&positions=`, the
 * controller narrows each entry through `SSE_Out::position_arg`, and the
 * Consumer opens there through `next_offset()`. Four seeds cover every
 * control:
 *
 * - Live and follow send no positions at all, which is what makes the server
 *   default each subscription to 'end'.
 * - Browsing a segment sends `{ [sub]: { segment, offset: 0 } }`. In file mode
 *   the segment slot holds the file's inode.
 * - An offset jump sends that same pair carrying the offset that was typed.
 * - Replay sends `{ [sub]: 'start' }`, the token the server resolves to the
 *   earliest retained record.
 *
 * The rail rides the catalog verb each dashboard already calls — `log_status`
 * for the Partition Viewer, `taillog sources` for the Log Viewer — so browsing
 * costs no server verb of its own.
 *
 * `useSegmentBrowse`, at the foot of the file, composes all of this into the
 * one controller a dashboard mounts: rail maintenance, the seek handlers, and
 * the rail itself.
 */

import {
	useState,
	useEffect,
	useCallback,
	useMemo,
	useRef,
} from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';

import LogBrowser from '../components/LogBrowser';
import { formatBytes } from '../utils/formatters';
import parseOffsetJump from '../utils/parseOffsetJump';
import useRouterTick from './useRouterTick';
import { useCommandOnce } from './useCommandOnce';

/**
 * Where one subscription resumes: an exact record boundary, or a token the
 * server resolves for itself ('start').
 *
 * @typedef {{segment:number,offset:number}|string} SeekPosition
 */

/**
 * The one thing `stepPosition` asks of a RemoteLink — where its stream has
 * read to — named so a caller holding any cursor source can supply it.
 *
 * @typedef {{cursor: (sub: string) => ({segment:number,offset:number}|undefined)}} CursorSource
 */

/** The substrate service CI that catalogs and reads the on-disk logs. */
const RAW_LOGS_CI = 'raw-logs';

/**
 * How often the rail re-catalogs, in milliseconds. Segments rotate and grow
 * under a dashboard left open, so a rail nobody refreshes lists the past.
 */
const SEGMENTS_REFRESH_MS = 10000;

/** A rail with nothing to re-catalog still needs a callable for the tick. */
const NOOP = () => {};

/** One array, so "no segments" is the same value every render. */
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
 * @return {Object<string,{segment:number,offset:number}>} Positions keyed by
 *   subscription, holding a `{segment, offset}` seek.
 */
export function segmentPositions( sub, segmentId ) {
	return { [ sub ]: { segment: segmentId, offset: 0 } };
}

/**
 * Seek a subscription to the earliest retained record, through the 'start'
 * token the server resolves for itself. The token beats naming the oldest
 * segment: retention can drop that segment between the catalog reply and the
 * seek, and 'start' is resolved at the moment the reader opens.
 *
 * @param {string} sub The subscription (partition dir or log-source name).
 * @return {Object<string,string>} Positions keyed by subscription, holding the
 *   'start' token.
 */
export function replayPositions( sub ) {
	return { [ sub ]: 'start' };
}

/**
 * The read-verb position a Step should ask for: the pending seek if there is
 * one, else wherever the live stream left off. A token ('start' from Replay)
 * rides through verbatim, because the read verbs speak the same position
 * vocabulary as the seek transport; an explicit cursor formats as
 * `<segment>:<offset>`.
 *
 * @param {CursorSource}                 link      The RemoteLink, for the cursor its stream has reached.
 * @param {string}                       sub       The subscription being stepped.
 * @param {?Object<string,SeekPosition>} positions The pending target's positions, if any.
 * @return {?string} The position argument, or null when there is no cursor.
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
 * in the same tick to hand to `seek()`; derived state arrives a render too late.
 *
 * The displayed Live/Replay mode is the VIEW's (`SeekTracker.mode`), not this
 * hook's — one concept, one state machine.
 *
 * @param {string} sub The subscription (partition dir or log-source name).
 * @return {{segmentId: ?(number|string), follow: () => null, browseSegment: (id: number) => Object<string,{segment:number,offset:number}>, replay: () => Object<string,string>}}
 *   The clicked segment and the three actions, each returning its seed.
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
 * One partition's segment rail, resolved from `log_status` and re-resolvable on
 * demand — the `source` half of `useSegmentBrowse` for every dashboard that has
 * to ASK for its segments. A dashboard whose catalog already carries them (the
 * Log Viewer's `taillog sources` rows) passes its own `source` and skips this.
 *
 * The answer NAMES the dir it is about, so a selection that moved on while the
 * reply was in flight is dropped without a cancellation flag (ADR-7).
 *
 * @param {Object} o       Rail inputs.
 * @param {string} o.sub   The partition dir; '' empties the rail and asks nothing.
 * @param {string} o.scope Names this read's own nodes.
 * @return {{source: {segments: Array<{id:number,size:number}>}, refresh: () => void}}
 *   The source row for `useSegmentBrowse`, and the re-catalog its rail timer
 *   drives.
 */
export function useLogStatusSegments( { sub, scope } ) {
	const [ segments, setSegments ] = useState( NO_SEGMENTS );
	const subRef = useRef( sub );
	subRef.current = sub;

	const { run } = useCommandOnce( {
		ci: RAW_LOGS_CI,
		command: 'log_status',
		scope,
		retry: true,
		onDone: ( { result, subject } ) => {
			if ( subRef.current === subject ) {
				setSegments( result?.segments ?? NO_SEGMENTS );
			}
		},
	} );

	const refresh = useCallback( () => {
		if ( subRef.current ) {
			run( [ subRef.current ] );
		}
	}, [ run ] );

	useEffect( () => {
		if ( ! sub ) {
			setSegments( NO_SEGMENTS );
			return;
		}
		refresh();
	}, [ sub, refresh ] );

	const source = useMemo( () => ( { segments } ), [ segments ] );
	return { source, refresh };
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
 * Every seek that STATES positions carries the source row, because
 * `browseControl` reads the replay boundary out of it, and both of its shapes
 * matter: `segments` for a segmented log, `bytes` for a file-mode source that
 * has none. A follow states no positions and needs no row.
 *
 * @param {Object}                    o                     Controller inputs.
 * @param {string}                    o.sub                 The subscription; '' disarms the rail.
 * @param {Object}                    o.source              The source row (`{segments, bytes}`).
 * @param {() => void}                [o.refresh]           Re-catalog the rail, for a source whose
 *                                                          segment list is not itself polled. Omit
 *                                                          it and no rail timer is armed.
 * @param {string}                    [o.railName]          Timer node name for the refresh tick;
 *                                                          only a rail with a `refresh` arms one.
 * @param {string}                    o.mode                Displayed 'live' | 'replay' (the view's).
 * @param {?number}                   o.lastReceivedSegment Segment the last record arrived from.
 * @param {Function}                  o.seek                `( sub, positions, source? ) => void`.
 * @param {(paused: boolean) => void} o.setPaused           Pause the stream for time travel.
 * @param {() => void}                o.step                Deliver one record while paused.
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

	// An unknown segment means rotation; re-catalog once, never in a loop.
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

	// An empty `sub` would point the stream at an empty subscription.
	const seekWithin = ( positions, row ) => sub && seek( sub, positions, row );

	// Time-travel: a past segment pauses; Step walks it, Play streams.
	const handleBrowseSegment = ( segment ) => {
		if ( ! sub ) {
			return;
		}
		setPaused( true );
		seekWithin( browseSegment( segment.id ), source );
	};

	// A full ID or a bare offset pauses and steps that one message.
	const jump = ( text ) => {
		const position = parseOffsetJump(
			text,
			lastReceivedSegment ??
				( 'number' === typeof segmentId ? segmentId : null )
		);
		if ( ! sub || ! position ) {
			return;
		}
		setPaused( true );
		// browseSegment lights the rail; the jump carries its own offset.
		browseSegment( position.segment );
		seekWithin( { [ sub ]: position }, source );
		step();
	};

	const sidebar = (
		<LogBrowser
			mode={ mode }
			onFollow={ () => seekWithin( follow() ) }
			onReplay={ () => seekWithin( replay(), source ) }
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
