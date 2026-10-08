/**
 * useStreamGraph — the whole life of a streaming dashboard's node graph: the
 * two nodes it is made of, when it rides the page's stream, and where it
 * resumes.
 *
 * Every SSE dashboard mounts the same pair, so it is declared here rather
 * than written out per dashboard:
 *
 *   <prefix>:stream  Pass-through Tee; copies frames to the view, is where a
 *                    debug-overlay `connect` taps the live stream, and names
 *                    this graph on the page link.
 *   <prefix>:view    `viewClass`, the view-model React reads. It trusts controls
 *                    from its own name, which is what `control()` stamps.
 *
 * The graph opens no connection of its own. It rides the page's one stream
 * link, the backbone's `_stream`: it `attach`es its subscription under its
 * `<prefix>:stream`, and the link routes each record by its stamp to every
 * graph carrying it, so every stream graph on a page shares one EventSource.
 *
 * A graph rides only while the tab is visible AND the user hasn't paused.
 * Pause takes the SAME path as the visibility gate — it is just "inactive" —
 * and `park`s the graph, which drops it from the page's stream but keeps its
 * place, so Play resumes where it stopped. Pause outranks a refocus: a paused
 * graph stays parked through hide → show. An unmount `detach`es it, which
 * forgets its place.
 *
 * Every control that re-points the stream goes through `resubscribe`: it RECORDS
 * the intended `{ subscribe, positions }` and only touches the link while
 * active, so a selection or seek made WHILE PAUSED can never ride. Play and
 * refocus re-apply the recorded target. A `null` position tails; an omitted
 * one resumes.
 *
 * An explicit seek is SINGLE-USE: the instant it is delivered the recorded
 * target loses its positions, so a later pause/play resumes from wherever the
 * live tail actually reached. A Replay's catch-up-to-live flip is a
 * display-only signal that never re-calls `resubscribe` — without single-use
 * consumption, every later pause would jump back to the original replay start.
 *
 * A dashboard whose subscription is CHOSEN rather than declared passes no
 * `subscribe` at all: the graph rides nothing until a catalog names one
 * through `resubscribe`.
 *
 * `useSteppedRead` and `useLogCatalog` sit beside it because they are the same
 * graph's other halves: the single record a paused stream steps by, and the
 * polled list its subscription is named from.
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
	useNodeField,
} from '@newspack-nodes/runtime';
import usePageVisibility from './usePageVisibility';
import { useCommandOnce } from './useCommandOnce';
import { useBatchedPoll } from './useBatchedPoll';
import { addSliceFetcher } from '../helpers/addSliceFetcher';
import { egressPath } from '../helpers/egressPath';
import { CatalogListViewNode } from '../nodes/catalog-list-view-node';
import { stepPosition } from './useLogPositions';
import { controlMsg } from '../helpers/controlMsg';
import { browseControl } from '../nodes/seekTracker';

/**
 * Which of a catalog's rows a dashboard offers.
 *
 * @typedef {( row: Object ) => boolean} CatalogFilter
 */

/** Segments, sizes and partitions move slowly; ten seconds is often enough. */
const CATALOG_POLL_MS = 10000;

/** One array, so an empty catalog keeps its identity across renders. */
const NO_ROWS = [];

CommandInterpreterNode.registerNodeClasses( {
	CatalogListView: CatalogListViewNode,
} );

/**
 * Mount one dashboard's stream graph and own its connection lifecycle. See the
 * module docblock for the backbone and the gating contract.
 *
 * @param {Object}  o               The dashboard's declaration.
 * @param {string}  o.prefix        Names the two nodes this graph owns.
 * @param {string}  [o.group]       The dashboard's group, whose Tap the
 *                                  graph's reads pass; handed back on the
 *                                  handle for them.
 * @param {?string} [o.subscribe]   What the stream carries; omit it or pass
 *                                  null to open nothing until `resubscribe`
 *                                  names one.
 * @param {any}     o.viewClass     The view-model node's class, handed over
 *                                  rather than named (ADR-16).
 * @param {number}  [o.maxEntries]  View ring cap; omit to keep the view's own.
 * @param {?Object} [o.openAt]      The seek each build's first ride states,
 *                                  read as the link reads one: omitted
 *                                  states none, null tails.
 * @param {boolean} [o.clearOnOpen] Empty the view before every open, for a
 *                                  model whose rows go stale across a gap.
 * @return {{ prefix: string, group: (string|undefined), linkRef: Object, viewRef: Object, isPausedRef: Object, isActive: boolean, control: (value: Object) => void, resubscribe: (subs: string[], positions: ?Object) => void, seek: (sub: string, positions: ?Object, source?: Object) => void, setPaused: (paused: boolean) => void, setFilter: (term: string) => void, clear: () => void, targetRef: Object }}
 *   The live handles — `linkRef` holds the page's `_stream` — the gate's
 *   state and the controls the dashboard drives. The link keeps this graph's
 *   skipped-line count under `<prefix>:stream`, the name
 *   `UnparseableLinesNotice` takes.
 */
export function useStreamGraph( {
	prefix,
	group,
	subscribe,
	viewClass,
	maxEntries = 0,
	openAt,
	clearOnOpen = false,
} ) {
	// The Tee the page link delivers to, which names this graph on the link.
	const tee = `${ prefix }:stream`;
	const linkRef = useRef( null );
	const viewRef = useRef( null );
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

	// The intended {subscribe, positions}: the source every ride reads.
	const targetRef = useRef( null );

	// Read the latest declaration inside the once-only build and the effect.
	const declRef = useRef( null );
	declRef.current = {
		subscribe,
		viewClass,
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

	// @longform EVERY attach goes through here, so the pre-open clear and the
	// single-use consumption of the recorded seek cannot be reached around:
	// once the link takes it, the target keeps its subscription and loses its
	// positions, so the NEXT ride resumes where the page's stream read to. A
	// seek the link refuses leaves the target that is riding, so no later
	// ride replays the refusal; with no link yet, the build reads the target.
	const ride = useCallback(
		( subs, positions ) => {
			const link = linkRef.current;
			if ( ! link ) {
				targetRef.current = { subscribe: subs, positions };
				return;
			}
			if ( declRef.current.clearOnOpen ) {
				control( { action: 'clear' } );
			}
			link.attach( subs, tee, positions );
			targetRef.current = { subscribe: subs };
		},
		[ control, tee ]
	);

	// Record the target; ride only while active (Play re-applies it).
	const resubscribe = useCallback(
		( subs, positions ) => {
			if ( isActiveNow() ) {
				ride( subs, positions );
				return;
			}
			targetRef.current = { subscribe: subs, positions };
		},
		[ ride, isActiveNow ]
	);

	// Mount once; cleanup runs FIRST so a rebuild detaches before it rebuilds.
	useEffect( () => {
		const build = ( { interpreter, stream } ) => {
			const decl = declRef.current;
			interpreter
				.makeNode( 'Tee', tee )
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

			linkRef.current = stream;
			viewRef.current = view;
			// A fresh build states the declared seed, unless a seek is pending.
			const pending = targetRef.current;
			const subs =
				pending?.subscribe ??
				( decl.subscribe ? [ decl.subscribe ] : null );
			targetRef.current = subs && {
				subscribe: subs,
				positions:
					undefined === pending?.positions
						? decl.openAt
						: pending.positions,
			};
			// Re-publish a surviving pause to the fresh view on reinit.
			if ( isPausedRef.current ) {
				view.fill(
					controlMsg( view, { action: 'pause', paused: true } )
				);
			}
			// Re-render so the riding effect runs against the fresh build.
			bumpBuild( ( n ) => n + 1 );

			return () => {
				stream.detach( tee );
				linkRef.current = null;
				viewRef.current = null;
			};
		};

		const { teardown } = mountExospine( build );
		return teardown;
	}, [ prefix, tee ] );

	// Ride the page's stream while active, at the recorded target.
	useEffect( () => {
		const link = linkRef.current;
		if ( ! buildGen || ! link ) {
			return;
		}
		if ( ! isActive ) {
			link.park( tee );
			return;
		}
		const target = targetRef.current;
		if ( target ) {
			ride( target.subscribe, target.positions );
		}
	}, [ buildGen, isActive, ride, tee ] );

	// Pause parks the graph (the effect above); the flag drives the UI.
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
		group,
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
 * The paused single-step: the graph stays parked and one record is asked for
 * over the command channel, answered a tick later as `{ message, cursor }`,
 * admitted through the view's paused belt, and the recorded ride target
 * advanced to the post-step cursor — so the NEXT step continues from there and
 * Play resumes streaming from the stepped point. A reply with no record adds
 * no row; its cursor still advances the target when the read consumed a line
 * that would not unpack.
 *
 * The reply is addressed by its SUBJECT (ADR-7), which for these verbs is the
 * subscription being stepped, the first token of `<sub> <position>`.
 *
 * A record answered after Play is dropped rather than admitted: the live stream
 * is delivering again, and a stale step would insert a row behind the tail.
 *
 * @param {Object} o         Options.
 * @param {Object} o.graph   The `useStreamGraph` handle to step, whose group
 *                           the read passes.
 * @param {string} o.ci      The service CI the read verb lives on.
 * @param {string} o.command The read verb.
 * @param {string} [o.scope] Names this read's own nodes; `<prefix>-step`
 *                           by default.
 * @return {() => void} Deliver one record from the recorded cursor; a no-op
 *   unless the stream is paused and pointed at a subscription.
 */
export function useSteppedRead( { graph, ci, command, scope } ) {
	const { linkRef, viewRef, isPausedRef, control, resubscribe, targetRef } =
		graph;

	const { run } = useCommandOnce( {
		group: graph.group,
		ci,
		command,
		scope: scope ?? `${ graph.prefix }-step`,
		// The reply names the dir it read; the pending target may have moved.
		onDone: ( { result, subject } ) => {
			if (
				! result?.cursor ||
				! viewRef.current ||
				! isPausedRef.current
			) {
				return;
			}
			const at = targetRef.current?.positions?.[ subject ];
			if ( result.message ) {
				control( { action: 'step', frames: 1 } );
				viewRef.current.fill( result.message );
			} else if (
				at?.segment === result.cursor.segment &&
				at?.offset === result.cursor.offset
			) {
				return;
			}
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
			run( [ sub, position ] );
		}
	}, [ linkRef, isPausedRef, targetRef, run ] );
}

/**
 * The catalog a stream's subscription is chosen from, POLLED as a batched-poll
 * slice. A refusal at mount, a session that expired while the tab slept, a dir
 * that appeared after the picker loaded and a Reset Graph rebuild then all
 * recover on the next tick, with no loader and no retry of their own — a
 * refusal is an ANSWER, so nothing re-asks it.
 *
 * @param {Object}        o         Options.
 * @param {Object}        o.graph   The `useStreamGraph` handle choosing from
 *                                  it: its prefix names the slice's nodes,
 *                                  `<prefix>-catalog:*`, and its group's Tap
 *                                  the verb passes.
 * @param {string}        o.ci      The service CI the verb lives on.
 * @param {string}        o.command The catalog verb.
 * @param {CatalogFilter} [o.keep]  Keep only the rows this dashboard
 *                                  offers. Declare it once: it is a memo
 *                                  dependency, so a fresh arrow each render
 *                                  hands back a fresh array each render.
 * @return {Object[]} The catalog rows.
 */
export function useLogCatalog( { graph, ci, command, keep } ) {
	const { prefix } = graph;
	// Read live inside the once-only poll build.
	const declRef = useRef( null );
	declRef.current = { command, target: egressPath( graph.group, ci ) };

	useBatchedPoll( {
		build: ( { interpreter, tee } ) =>
			addSliceFetcher( interpreter, {
				fetcher: `${ prefix }-catalog:fetch`,
				receiver: `${ prefix }-catalog:in`,
				command: declRef.current.command,
				view: `${ prefix }-catalog:view`,
				viewClass: CatalogListViewNode,
				tee,
				target: declRef.current.target,
			} ),
		timerName: `${ prefix }-catalog:timer`,
		teeName: `${ prefix }-catalog:tee`,
		intervalMs: CATALOG_POLL_MS,
		// Part of a page, not its graph: the stream mount owns Reset Graph.
		passenger: true,
	} );

	const rows =
		useNodeField( `${ prefix }-catalog:view`, 'view' )?.items ?? NO_ROWS;
	return useMemo(
		() => ( keep ? rows.filter( keep ) : rows ),
		[ rows, keep ]
	);
}
