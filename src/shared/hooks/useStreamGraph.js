/**
 * useStreamGraph — the whole life of a streaming dashboard's node graph: the
 * three nodes it is made of, when its stream is open, and where it reopens.
 *
 * Every SSE dashboard mounts the same backbone, so it is declared here rather
 * than written out per dashboard:
 *
 *   <prefix>:link    RemoteLink — composes `<prefix>:link:sse-in` (EventSource
 *                    ingress) plus the shared `_http` (POST /command boundary)
 *                    and `_heartbeat` (slot keep-alive), and wires the
 *                    `connected → slot` bridge between them.
 *   <prefix>:stream  Pass-through Tee; copies frames to the view, and is where a
 *                    debug-overlay `connect` taps the live stream.
 *   <prefix>:view    `viewClass`, the view-model React reads. It trusts controls
 *                    from its own name, which is what `control()` stamps.
 *
 * A stream is open only while the tab is visible AND the user hasn't paused.
 * Pause takes the SAME close path as the visibility gate — it is just
 * "inactive" — so pausing frees the bounded server SSE slot, and pause outranks
 * a refocus (a paused stream stays closed through hide → show).
 *
 * Every control that re-points the stream goes through `resubscribe`: it RECORDS
 * the intended `{ subscribe, positions }` and only touches the live stream while
 * active, so a selection or seek made WHILE PAUSED can never revive the closed
 * EventSource. Play and refocus re-apply the recorded target.
 *
 * An explicit seek is SINGLE-USE: the instant it is delivered the recorded
 * target reverts to `positions: null`, so a later pause/play resumes from
 * wherever the live tail actually reached. A Replay's catch-up-to-live flip is a
 * display-only signal that never re-calls `resubscribe` — without single-use
 * consumption, every later pause would jump back to the original replay start.
 *
 * A dashboard whose subscription is CHOSEN rather than declared passes no
 * `subscribe` at all: the link is built bare and opens nothing until a catalog
 * names one through `resubscribe`.
 */

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';
import {
	CommandInterpreterNode,
	mountExospine,
	useNodeState,
} from '@newspack-nodes/runtime';
import usePageVisibility from './usePageVisibility';
import { useCommandOnce } from './useCommandOnce';
import { useBatchedPoll } from './useBatchedPoll';
import { addSliceFetcher } from '../helpers/addSliceFetcher';
import { CatalogListViewNode } from '../nodes/catalog-list-view-node';
import { stepPosition } from './useLogPositions';
import { controlMsg } from '../helpers/controlMsg';
import { browseControl } from '../nodes/seekTracker';

/**
 * The plain `<sub> <position>` read; a verb with a sub-verb declares its own.
 *
 * @param {string} sub      The subscription being stepped.
 * @param {string} position Where to read from.
 * @return {string[]} The verb's arguments.
 */
const POSITIONAL_READ = ( sub, position ) => [ sub, position ];

/** Segments, sizes and partitions move slowly; no need for every tick. */
const CATALOG_POLL_MS = 10000;

const NO_ROWS = [];

CommandInterpreterNode.registerNodeClasses( {
	CatalogListView: CatalogListViewNode,
} );

/**
 * Mount one dashboard's stream graph and own its connection lifecycle. See the
 * module docblock for the backbone and the gating contract.
 *
 * @param {Object}  o
 * @param {string}  o.prefix        Names the three nodes this graph owns.
 * @param {?string} o.subscribe     What the stream carries; null to open
 *                                  nothing until `resubscribe` names it.
 * @param {any}     o.viewClass     The view-model node's class, handed over
 *                                  rather than named (ADR-16).
 * @param {string}  [o.endpoint]    SSE endpoint override; omit for
 *                                  `/messages/stream`.
 * @param {number}  [o.maxEntries]  View ring cap; omit to keep the view's own.
 * @param {?Object} [o.openAt]      The FIRST open's seek seed; null tails.
 * @param {boolean} [o.clearOnOpen] Empty the view before every open, for a
 *                                  model whose rows go stale across a gap.
 * @return {{ prefix: string, linkRef: Object, viewRef: Object, isPausedRef: Object, isActive: boolean, control: Function, resubscribe: Function, seek: Function, setPaused: Function, setFilter: (term: string) => void, clear: () => void, targetRef: Object }}
 *   The live handles, the gate's state, and the controls the dashboard drives.
 */
export function useStreamGraph( {
	prefix,
	subscribe,
	viewClass,
	endpoint = '',
	maxEntries = 0,
	openAt = null,
	clearOnOpen = false,
} ) {
	const linkRef = useRef( null );
	const viewRef = useRef( null );
	// Reset per (re)build: a fresh link's SseIn has no tracked offset.
	const hasConnectedRef = useRef( false );
	// Which link is streaming, so a re-render never tears a live seek down.
	const connectedLinkRef = useRef( null );
	const [ buildGen, bumpBuild ] = useState( 0 );

	const isPageVisible = usePageVisibility();
	const [ isPaused, setIsPaused ] = useState( false );
	const isPausedRef = useRef( isPaused );
	isPausedRef.current = isPaused;
	const isPageVisibleRef = useRef( isPageVisible );
	isPageVisibleRef.current = isPageVisible;
	const isActive = isPageVisible && ! isPaused;
	// Same-tick truth: a click that pauses AND seeks must see the new gate.
	const isActiveNow = useCallback(
		() => isPageVisibleRef.current && ! isPausedRef.current,
		[]
	);

	// The intended {subscribe, positions}: the reopen source of truth.
	const targetRef = useRef( null );

	// Read the latest declaration inside the once-only build and the effect.
	const declRef = useRef( null );
	declRef.current = {
		subscribe,
		viewClass,
		endpoint,
		maxEntries,
		openAt,
		clearOnOpen,
	};

	// The ONE control minter: everything the dashboard drives goes through it.
	const control = useCallback( ( value ) => {
		const view = viewRef.current;
		if ( view ) {
			view.fill( controlMsg( view, value ) );
		}
	}, [] );

	// @longform EVERY open goes through here, so the pre-open clear and the
	// single-use consumption of the recorded target cannot be reached around:
	// the target keeps its subscription and loses its seek, which is what makes
	// the NEXT reopen resume live rather than re-applying a spent seek.
	const open = useCallback(
		( subs, how ) => {
			const link = linkRef.current;
			if ( ! link ) {
				// Between builds: keep the intent, lose only the open.
				targetRef.current = subs
					? { subscribe: subs, positions: null }
					: targetRef.current;
				return;
			}
			if ( declRef.current.clearOnOpen ) {
				control( { action: 'clear' } );
			}
			targetRef.current = subs
				? { subscribe: subs, positions: null }
				: null;
			connectedLinkRef.current = link;
			hasConnectedRef.current = true;
			how( link );
		},
		[ control ]
	);

	// Record the target; open only while active (Play re-applies it).
	const resubscribe = useCallback(
		( subs, positions ) => {
			if ( isActiveNow() ) {
				open( subs, ( link ) => link.setSubscribe( subs, positions ) );
				return;
			}
			targetRef.current = { subscribe: subs, positions };
		},
		[ open, isActiveNow ]
	);

	// Mount once; cleanup runs FIRST so a rebuild clears connectedLinkRef.
	useEffect( () => {
		// Soft nodes; mountExospine snapshots Core for the reinit() rebuild.
		const build = ( { interpreter } ) => {
			const decl = declRef.current;
			const link = interpreter.makeNode(
				'RemoteLink',
				`${ prefix }:link`,
				decl.subscribe ? [ decl.subscribe ] : []
			);
			if ( decl.endpoint ) {
				link.endpoint = decl.endpoint;
			}
			link.target = `${ prefix }:stream`;
			interpreter
				.makeNode( 'Tee', `${ prefix }:stream` )
				.connectNode( `${ prefix }:view` );

			const view = interpreter.makeNode(
				decl.viewClass,
				`${ prefix }:view`
			);
			// The view applies controls from this FROM; records never match.
			view.controlFrom = `${ prefix }:view`;
			if ( decl.maxEntries ) {
				// Pre-stream only: the ring indexes modulo maxLines.
				view.maxLines = decl.maxEntries;
			}

			linkRef.current = link;
			viewRef.current = view;
			hasConnectedRef.current = false;
			// Re-publish a surviving pause to the fresh view on reinit.
			if ( isPausedRef.current ) {
				view.fill(
					controlMsg( view, { action: 'pause', paused: true } )
				);
			}
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
	}, [ prefix ] );

	// Own the live connection: open (at the recorded target) while active.
	useEffect( () => {
		const link = linkRef.current;
		if ( ! buildGen || ! link ) {
			return;
		}
		if ( ! isActive ) {
			link.close();
			connectedLinkRef.current = null;
			return;
		}
		// Already streaming this link; a re-render must NOT tear the seek.
		if ( connectedLinkRef.current === link ) {
			return;
		}
		const target = targetRef.current;
		if ( ! declRef.current.subscribe && ! target ) {
			return;
		}
		const isReconnect = hasConnectedRef.current;
		if ( target ) {
			const { subscribe: subs, positions } = target;
			// No stated seek means the stream resumes where it read to.
			open( subs, ( l ) =>
				positions
					? l.setSubscribe( subs, positions )
					: l.reconnect( subs )
			);
			return;
		}
		open( null, ( l ) =>
			isReconnect ? l.reconnect() : l.connect( declRef.current.openAt )
		);
	}, [ buildGen, isActive, open ] );

	// Pause closes the stream (the effect above); the flag drives the UI.
	const setPaused = useCallback(
		( paused ) => {
			// The ref flips NOW: a same-tick seek must record, not open.
			isPausedRef.current = paused;
			setIsPaused( paused );
			control( { action: 'pause', paused } );
		},
		[ control ]
	);

	// A seek is BOTH halves: the view's mode and the stream's move.
	const seek = useCallback(
		( sub, positions, source = {} ) => {
			control(
				positions ? browseControl( source ) : { action: 'follow' }
			);
			resubscribe( [ sub ], positions );
		},
		[ control, resubscribe ]
	);

	// Ingest gate: only matching rows enter the view's ring from here on.
	const setFilter = useCallback(
		( term ) => control( { action: 'filter', term } ),
		[ control ]
	);

	// Clear as a control, so the view's ONE reset runs (rows, counter, rate).
	const clear = useCallback(
		() => control( { action: 'clear' } ),
		[ control ]
	);

	return {
		prefix,
		linkRef,
		viewRef,
		isPausedRef,
		isActive,
		control,
		resubscribe,
		seek,
		setPaused,
		setFilter,
		clear,
		targetRef,
	};
}

/**
 * The paused single-step: the stream stays OFFLINE and one record is asked for
 * over the command channel, answered a tick later as `{ message, cursor }`,
 * admitted through the view's paused belt, and the recorded reopen target
 * advanced to the post-step cursor — so the NEXT step continues from there and
 * Play resumes streaming from the stepped point.
 *
 * The reply is addressed by its SUBJECT (ADR-7), which for these verbs is the
 * subscription being stepped — so `subjectOf` must be `argsFor` read backwards:
 * a verb with a sub-verb does not carry its source at args[0].
 *
 * @param {Object}   o
 * @param {Object}   o.graph       The `useStreamGraph` handle to step.
 * @param {string}   [o.ci]        The service CI the read verb lives on.
 * @param {string}   o.command     The read verb.
 * @param {string}   [o.scope]     Names this read's own nodes; `<prefix>:read`
 *                                 by default.
 * @param {Function} [o.argsFor]   `( sub, position ) => string[]`; the plain
 *                                 `<sub> <position>` verb by default.
 * @param {Function} [o.subjectOf] `( args ) => sub`, `argsFor` read backwards.
 * @return {() => void} Deliver one record from the cursor; a no-op unless paused.
 */
export function useSteppedRead( {
	graph,
	ci,
	command,
	scope,
	argsFor = POSITIONAL_READ,
	subjectOf,
} ) {
	const { linkRef, viewRef, isPausedRef, control, resubscribe, targetRef } =
		graph;

	const { run } = useCommandOnce( {
		ci,
		command,
		scope: scope ?? `${ graph.prefix }:read`,
		subjectOf,
		// The reply names the dir it read; the pending target may have moved.
		onDone: ( { result, subject } ) => {
			if (
				! result?.message ||
				! viewRef.current ||
				! isPausedRef.current
			) {
				return;
			}
			control( { action: 'step', frames: 1 } );
			viewRef.current.fill( result.message );
			resubscribe( [ subject ], {
				[ subject ]: { ...result.cursor },
			} );
		},
	} );

	return useCallback( () => {
		const link = linkRef.current;
		const pending = targetRef.current;
		if ( ! isPausedRef.current || ! link || ! pending ) {
			return;
		}
		const sub = pending.subscribe[ 0 ];
		const position = stepPosition( link, sub, pending.positions );
		if ( null !== position ) {
			run( argsFor( sub, position ) );
		}
	}, [ linkRef, isPausedRef, targetRef, run, argsFor ] );
}

/**
 * The catalog a stream's subscription is chosen from, POLLED as a batched-poll
 * slice. A refusal at mount, a session that expired while the tab slept, a dir
 * that appeared after the picker loaded and a Reset Graph rebuild then all
 * recover on the next tick, with no loader and no retry of their own — a
 * refusal is an ANSWER, so nothing re-asks it.
 *
 * @param {Object}   o
 * @param {string}   o.prefix   Names the slice's nodes, `<prefix>:list:*`.
 * @param {string}   o.command  The catalog verb.
 * @param {string}   o.target   Where to send it (`egressPath( ci )`).
 * @param {Function} [o.argsFn] The verb's arguments; none by default.
 * @param {Function} [o.keep]   Keep only the rows this dashboard offers.
 * @return {Object[]} The catalog rows.
 */
export function useLogCatalog( { prefix, command, target, argsFn, keep } ) {
	// Read live inside the once-only poll build.
	const declRef = useRef( null );
	declRef.current = { command, target, argsFn };

	useBatchedPoll( {
		build: ( { interpreter, tee } ) =>
			addSliceFetcher( interpreter, {
				fetcher: `${ prefix }:list:fetch`,
				receiver: `${ prefix }:list:in`,
				command: declRef.current.command,
				argsFn: declRef.current.argsFn,
				view: `${ prefix }:list:view`,
				viewClass: CatalogListViewNode,
				tee,
				target: declRef.current.target,
			} ),
		timerName: `${ prefix }:list:timer`,
		teeName: `${ prefix }:list:tee`,
		intervalMs: CATALOG_POLL_MS,
		// Part of a page, not its graph: the stream mount owns Reset Graph.
		passenger: true,
	} );

	const rows =
		useNodeState( `${ prefix }:list:view`, 'view' )?.items ?? NO_ROWS;
	return useMemo(
		() => ( keep ? rows.filter( keep ) : rows ),
		[ rows, keep ]
	);
}
