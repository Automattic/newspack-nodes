/**
 * useLogViewerGraph — the Log Viewer dashboard graph. Same canonical backbone as
 * the Partition Viewer (a single substrate `RemoteLink` → stream `Tee` → view),
 * differing only in what it streams:
 *
 *   - The `RemoteLink` opens the substrate's `GET /log/stream` (the `endpoint`
 *     override) instead of `/messages/stream`; on the wire the two are identical
 *     (packed `msg` frames, connected/heartbeat, slot pool), the source resolves
 *     to a `Tail` reader over a log FILE (or segmented Log) by registry NAME.
 *   - The catalog is the interpreter builtin `taillog sources` (empty TO → the
 *     command interpreter), which replies with `[{ name, path, mode, available,
 *     bytes, segments }]` — no service CI. Those rows feed the toolbar picker
 *     and the segment sidebar; `bytes`/`segments` are the replay boundary.
 *
 * The rows are raw log-file lines (a `logviewer:view` `LogViewerViewNode` ring),
 * not packed partition envelopes. EVERY node sinks into the interpreter; flow is
 * steered ONLY by each node's `target`.
 */

import { markLocal } from '../../runtime/command-auth';
import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { mountExospine } from '../../runtime/exospine';
import { endPosition } from '../../shared/nodes/seekTracker';
import { useGatedSubscription } from './useGatedSubscription';
import { CommandClient } from '../../runtime/command-client';
import {
	newMessage,
	TYPE,
	FROM,
	ID,
	VALUE,
	TM_COMMAND,
	TM_STRUCT,
} from '../../runtime/message';
import '../nodes/register';

const LINK = 'logviewer:link';
const TEE = 'logviewer:stream';
const VIEW = 'logviewer:view';
const LOG_STREAM_ENDPOINT = 'newspack-nodes/v1/log/stream';

// Monotonic per-hook-instance ID counter for the taillog-sources correlator.
let nextOpId = 0;
function makeOpId() {
	nextOpId += 1;
	return `logviewer-op-${ Date.now() }-${ nextOpId }`;
}

// TM_STRUCT control message routed by the view's fill() on action; FROM=VIEW.
const controlMsg = ( value ) => {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ FROM ] = VIEW;
	m[ VALUE ] = value;
	return m;
};

// taillog-sources command: empty TO → interpreter builtin; FROM=view for reply.
function buildSourcesCommand( id ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = VIEW;
	m[ ID ] = id;
	m[ VALUE ] = { name: 'taillog', arguments: [ 'sources' ] };
	markLocal( m );
	return m;
}

// taillog-read command: one line at <segment>:<offset> (empty TO → builtin).
function buildReadCommand( id, source, cursor ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = VIEW;
	m[ ID ] = id;
	m[ VALUE ] = {
		name: 'taillog',
		arguments: [ 'read', source, `${ cursor.segment }:${ cursor.offset }` ],
	};
	markLocal( m );
	return m;
}

// Prefer the first available source; else fall back to the first listed.
function defaultSourceName( sources ) {
	const first = sources.find( ( s ) => s.available ) ?? sources[ 0 ];
	return first?.name ?? '';
}

/**
 * @param {Object} [opts]               Options (testing seams).
 * @param {Object} [opts.commandClient] CommandClient seam assigned to the link's
 *                                      HttpOut; defaults to a freshly-constructed
 *                                      CommandClient.
 * @return {{ selectSource: Function, setPaused: Function, seek: Function, sources: Array, fetchSources: Function }}
 *   Control callbacks + the source catalog (name/mode/availability/segments)
 *   for the picker and segment sidebar; fetchSources refreshes that catalog.
 */
export function useLogViewerGraph( opts = {} ) {
	const optsRef = useRef( opts );
	optsRef.current = opts;

	const linkRef = useRef( null );
	const viewRef = useRef( null );

	// One-line fetch behind the paused single-step (reply → VIEW future).
	const fetchMessage = useCallback( ( sub, cursor ) => {
		const view = viewRef.current;
		const link = linkRef.current;
		if ( ! view || ! link ) {
			return Promise.reject( new Error( 'graph not ready' ) );
		}
		const id = makeOpId();
		const future = new Promise( ( resolve, reject ) => {
			view.replies.add( id, resolve, reject );
		} );
		link.send( buildReadCommand( id, sub, cursor ) );
		return future.then( ( payload ) =>
			payload && 'object' === typeof payload ? payload : null
		);
	}, [] );

	// Pause/visibility gating + the record-then-reopen subscription control.
	const { isPausedRef, resubscribe, setPaused, step } = useGatedSubscription(
		{
			linkRef,
			viewRef,
			fetchMessage,
		}
	);

	// Bumped per (re)build so the view rebinds; monotonic, not a boolean latch.
	const [ , bumpBuild ] = useState( 0 );
	// The source catalog (for the picker), set when taillog sources replies.
	const [ sources, setSources ] = useState( [] );

	useEffect( () => {
		const build = ( { interpreter } ) => {
			// 'php' is a builtin source placeholder; the catalog repoints it.
			const link = interpreter.makeNode( 'RemoteLink', LINK, [ 'php' ] );
			link.endpoint = LOG_STREAM_ENDPOINT;
			link.target = TEE;
			link.client =
				optsRef.current.commandClient || CommandClient.fromGlobal();

			const tee = interpreter.makeNode( 'Tee', TEE );
			tee.connectNode( VIEW );

			const view = interpreter.makeNode( 'LogViewerView', VIEW );

			linkRef.current = link;
			viewRef.current = view;

			// Re-publish a surviving pause to the fresh view on reinit.
			if ( isPausedRef.current ) {
				view.fill( controlMsg( { action: 'pause', paused: true } ) );
			}

			bumpBuild( ( n ) => n + 1 );

			// Fetch the source catalog; its reply opens the default source.
			fetchSources()
				.then( ( catalog ) => {
					if ( ! Array.isArray( catalog ) || 0 === catalog.length ) {
						return;
					}
					const logs = catalog.map( ( s ) => ( {
						key: s.name,
						label: s.name,
					} ) );
					view.fill( controlMsg( { action: 'logs', logs } ) );
					const chosen = defaultSourceName( catalog );
					if ( chosen ) {
						view.fill(
							controlMsg( { action: 'select', log: chosen } )
						);
						// Record the default; open only while active.
						resubscribe( [ chosen ], null );
					}
				} )
				.catch( () => {
					// taillog-sources failure is silent; picker stays empty.
				} );

			return () => {
				link.removeNode();
				linkRef.current = null;
				viewRef.current = null;
			};
		};

		const { teardown } = mountExospine( build );
		return teardown;
		// Mount once; the shared-hook deps are stable.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [] );

	// Record the pick, re-open if active, re-catalog for fresh segments.
	const selectSource = ( name ) => {
		viewRef.current?.fill( controlMsg( { action: 'select', log: name } ) );
		resubscribe( [ name ], null );
		fetchSources().catch( () => {} );
	};

	// Fetch a FRESH catalog + republish, so segments track rotation.
	const fetchSources = useCallback( () => {
		const view = viewRef.current;
		const link = linkRef.current;
		if ( ! view || ! link ) {
			return Promise.reject( new Error( 'graph not ready' ) );
		}
		const id = makeOpId();
		const future = new Promise( ( resolve, reject ) => {
			view.replies.add( id, resolve, reject );
		} );
		link.send( buildSourcesCommand( id ) );
		return future.then( ( catalog ) => {
			if ( Array.isArray( catalog ) ) {
				setSources( catalog );
			}
			return catalog;
		} );
	}, [] );

	/**
	 * Reposition the source + set the view mode. Live tail (null positions)
	 * follows; Replay (positions) captures the source's CURRENT live boundary
	 * for the Replay→Live flip: the newest segment for a segmented source, the
	 * byte size (null segment) for a file. An empty source flips straight to
	 * Live; a fetch failure replays with no boundary (never flips — the user
	 * clicks Live).
	 *
	 * @param {string}  name      The source name to (re)open.
	 * @param {?Object} positions The SSE positions seed; null tails live.
	 */
	const seek = useCallback(
		( name, positions ) => {
			const apply = ( control ) => {
				// Stale seek: the selection moved on while the fetch ran.
				if ( viewRef.current?.selected !== name ) {
					return;
				}
				viewRef.current?.fill( controlMsg( control ) );
				resubscribe( [ name ], positions );
			};
			if ( ! positions ) {
				apply( { action: 'follow' } );
				return;
			}
			return fetchSources()
				.then( ( catalog ) => {
					const source = Array.isArray( catalog )
						? catalog.find( ( s ) => s.name === name )
						: null;
					const end = endPosition( source?.segments ?? [] );
					if ( end ) {
						apply( {
							action: 'browse',
							endSegment: end.segment,
							endOffset: end.offset,
						} );
						return;
					}
					const bytes = source?.bytes ?? 0;
					apply(
						bytes > 0
							? {
									action: 'browse',
									endSegment: null,
									endOffset: bytes,
							  }
							: { action: 'follow' }
					);
				} )
				.catch( () =>
					apply( {
						action: 'browse',
						endSegment: null,
						endOffset: 0,
					} )
				);
		},
		[ fetchSources, resubscribe ]
	);

	return { selectSource, setPaused, seek, sources, fetchSources, step };
}
