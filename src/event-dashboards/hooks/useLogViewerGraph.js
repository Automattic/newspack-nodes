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
 *     command interpreter), which replies with `[{ name, path, mode, available }]`
 *     — no service CI. Those sources feed the picker; the view's dropdown catalog
 *     is the same names mapped to `{ key, label }`.
 *
 * The rows are raw log-file lines (a `logviewer:view` `LogViewerViewNode` ring),
 * not packed partition envelopes. EVERY node sinks into the interpreter; flow is
 * steered ONLY by each node's `target`.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { mountExospine } from '../../runtime/exospine';
import usePageVisibility from '@newspack-nodes/shared/hooks/usePageVisibility';
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
 * @return {{ selectSource: Function, setPaused: Function, seek: Function, sources: Array }}
 *   Control callbacks + the source catalog for the picker.
 */
export function useLogViewerGraph( opts = {} ) {
	const optsRef = useRef( opts );
	optsRef.current = opts;

	const linkRef = useRef( null );
	const viewRef = useRef( null );

	// A hidden tab throttles the heartbeat; gate the stream on visibility.
	const isPageVisible = usePageVisibility();

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
			bumpBuild( ( n ) => n + 1 );

			// Fetch the source catalog; its reply opens the default source.
			const listId = makeOpId();
			const listFuture = new Promise( ( resolve, reject ) => {
				view.replies.add( listId, resolve, reject );
			} );
			link.send( buildSourcesCommand( listId ) );
			listFuture
				.then( ( catalog ) => {
					if ( ! Array.isArray( catalog ) || 0 === catalog.length ) {
						return;
					}
					setSources( catalog );
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
						link.setSubscribe( [ chosen ] );
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
	}, [] );

	// Visibility gate: close while hidden, reopen the source on refocus.
	useEffect( () => {
		const link = linkRef.current;
		if ( ! link ) {
			return;
		}
		if ( isPageVisible ) {
			const selected = viewRef.current?.setStateCache?.view?.selected;
			if ( selected ) {
				link.setSubscribe( [ selected ], link.resumePositions() );
			}
		} else {
			link.close();
		}
	}, [ isPageVisible ] );

	// selectSource: view records the pick; the link re-opens (tail) for it.
	const selectSource = ( name ) => {
		const view = viewRef.current;
		const link = linkRef.current;
		if ( view ) {
			view.fill( controlMsg( { action: 'select', log: name } ) );
		}
		if ( link ) {
			link.setSubscribe( [ name ] );
		}
	};

	const setPaused = ( paused ) => {
		if ( viewRef.current ) {
			viewRef.current.fill( controlMsg( { action: 'pause', paused } ) );
		}
	};

	// Reposition the source + set the view mode (positions replay, null tails).
	const seek = ( name, positions ) => {
		const view = viewRef.current;
		if ( view ) {
			view.fill(
				controlMsg(
					positions
						? { action: 'browse', endSegment: null, endOffset: 0 }
						: { action: 'follow' }
				)
			);
		}
		if ( linkRef.current ) {
			linkRef.current.setSubscribe( [ name ], positions );
		}
	};

	return { selectSource, setPaused, seek, sources };
}
