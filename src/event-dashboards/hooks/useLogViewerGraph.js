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
 *
 * The catalog, the selection and the open stream are ONE reconciled loader
 * (`establish`), so a refusal at mount and a Reset Graph rebuild both recover
 * through the same path — the graph build fetches nothing for itself.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import useReconcile from '@newspack-nodes/shared/hooks/useReconcile';
import { mountExospine } from '../../runtime/exospine';
import { browseControl } from '../../shared/nodes/seekTracker';
import { useGatedSubscription } from './useGatedSubscription';
import '../nodes/register';
import useRequestNode from '@newspack-nodes/shared/hooks/useRequestNode';
import { controlMsg } from '../../shared/helpers/controlMsg';

const LINK = 'logviewer:link';
const TEE = 'logviewer:stream';
const VIEW = 'logviewer:view';
const READ_NODE = 'logviewer:read';
const SOURCES_NODE = 'logviewer:list';
const LOG_STREAM_ENDPOINT = 'newspack-nodes/v1/log/stream';

// Prefer the first available source; else fall back to the first listed.
function defaultSourceName( sources ) {
	const first = sources.find( ( s ) => s.available ) ?? sources[ 0 ];
	return first?.name ?? '';
}

/**
 * @return {{ selectSource: Function, setPaused: Function, seek: Function, sources: Array, fetchSources: Function, step: () => void, clear: () => void, setFilter: (term: string) => void }}
 *   Control callbacks + the source catalog (name/mode/availability/segments)
 *   for the picker and segment sidebar; fetchSources refreshes that catalog,
 *   step (paused only) delivers one record from the cursor, and clear empties
 *   the ring.
 */
export function useLogViewerGraph() {
	const linkRef = useRef( null );
	const viewRef = useRef( null );

	// Two reads, two nodes; each reply lands on the node that asked.
	const readOne = useRequestNode( READ_NODE, '' );
	const readSources = useRequestNode( SOURCES_NODE, '' );

	// One-line fetch behind the paused single-step, through its own node.
	const fetchMessage = useCallback(
		( sub, position ) =>
			readOne( 'taillog', [ 'read', sub, position ] ).then(
				( payload ) =>
					payload && 'object' === typeof payload ? payload : null
			),
		[ readOne ]
	);

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
			const tee = interpreter.makeNode( 'Tee', TEE );
			tee.connectNode( VIEW );

			const view = interpreter.makeNode( 'LogViewerView', VIEW );
			// The view applies controls from this FROM; records never match.
			view.controlFrom = VIEW;

			linkRef.current = link;
			viewRef.current = view;

			// Re-publish a surviving pause to the fresh view on reinit.
			if ( isPausedRef.current ) {
				view.fill(
					controlMsg( view, { action: 'pause', paused: true } )
				);
			}

			bumpBuild( ( n ) => n + 1 );

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

	// Read a FRESH catalog + republish, so segments track rotation.
	const readCatalog = useCallback(
		() =>
			readSources( 'taillog', [ 'sources' ] ).then( ( catalog ) => {
				if ( Array.isArray( catalog ) ) {
					setSources( catalog );
				}
				return catalog;
			} ),
		[ readSources ]
	);

	// @longform
	// The DESIRED STATE, in one loader: a catalog, a selection, and a stream
	// open on it. The catalog half used to be fetched inside the graph build
	// with its failure swallowed as "picker stays empty", so a refusal at
	// mount — or a session that expired while the tab slept — left the
	// dashboard dead with no way back but a reload; the reconciled half that
	// replaced it restored only the picker, which is the same dead dashboard
	// with a populated dropdown. Selection is established ONLY when there is
	// none, so re-establishing never overrides the user's pick.
	const establish = useCallback( () => {
		const view = viewRef.current;
		if ( ! view ) {
			// The gate: keep trying until the exospine graph has mounted.
			return Promise.reject( new Error( 'graph not ready' ) );
		}
		return readCatalog().then( ( catalog ) => {
			if ( ! Array.isArray( catalog ) || view.selected ) {
				return catalog;
			}
			const chosen = defaultSourceName( catalog );
			if ( chosen ) {
				view.fill(
					controlMsg( view, { action: 'select', log: chosen } )
				);
				// Record the default; open only while active.
				resubscribe( [ chosen ], null );
			}
			return catalog;
		} );
	}, [ readCatalog, resubscribe ] );

	const { reconcileNow } = useReconcile( { load: establish } );

	// Rail maintenance; a failure re-opens the convergence window.
	const fetchSources = useCallback(
		() => readCatalog().catch( () => reconcileNow() ),
		[ readCatalog, reconcileNow ]
	);

	// Record the pick, re-open if active, re-catalog for fresh segments.
	const selectSource = useCallback(
		( name ) => {
			viewRef.current?.fill(
				controlMsg( viewRef.current, {
					action: 'select',
					log: name,
				} )
			);
			resubscribe( [ name ], null );
			fetchSources();
		},
		[ resubscribe, fetchSources ]
	);

	// Ingest gate: only matching rows enter the ring from here on.
	const setFilter = useCallback( ( term ) => {
		viewRef.current?.fill(
			controlMsg( viewRef.current, { action: 'filter', term } )
		);
	}, [] );

	// Clear as a control, so the view's ONE reset runs (rows, counter, rate).
	const clear = useCallback( () => {
		viewRef.current?.fill(
			controlMsg( viewRef.current, { action: 'clear' } )
		);
	}, [] );

	/**
	 * Reposition the source + set the view mode. Live tail (null positions)
	 * follows; Replay (positions) captures the source's live boundary for the
	 * Replay→Live flip via `browseControl()` — newest segment for a segmented
	 * source, byte size (null segment) for a file, `follow` for an empty one.
	 *
	 * The boundary comes from the row the CALLER holds, synchronously. This
	 * used to re-dispatch `taillog sources` for a fresher size, which cost a
	 * round trip on every Replay click and, on rejection, entered replay with
	 * NO boundary — a state the user could only escape by clicking Live. Both
	 * boundaries are approximate anyway: the head segment grows during the
	 * round trip too, and the caller re-catalogs every SEGMENTS_REFRESH_MS and
	 * on rotation. Trading a flip a few seconds early for a hard stuck state
	 * was the wrong side of that trade, and it was the only one of three
	 * consumers making it.
	 *
	 * @param {string}  name      The source name to (re)open.
	 * @param {?Object} positions The SSE positions seed; null tails live.
	 * @param {Object}  [source]  The source row (`{segments, bytes}`) to
	 *                            capture the boundary from.
	 */
	const seek = useCallback(
		( name, positions, source = {} ) => {
			// Stale seek: the selection moved on before this ran.
			if ( viewRef.current?.selected !== name ) {
				return;
			}
			viewRef.current?.fill(
				controlMsg(
					viewRef.current,
					positions ? browseControl( source ) : { action: 'follow' }
				)
			);
			resubscribe( [ name ], positions );
		},
		[ resubscribe ]
	);

	return {
		setFilter,
		selectSource,
		setPaused,
		seek,
		sources,
		fetchSources,
		step,
		clear,
	};
}
