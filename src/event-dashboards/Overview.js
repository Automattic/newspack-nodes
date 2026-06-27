/**
 * Overview — the hub's at-a-glance FLEET-HEALTH board (the default first paint).
 * The "is everything OK right now?" glance, so you don't have to scroll the dense
 * Topologies tree to spot trouble. Modeled on Tachikoma's topics dashboard (rate
 * + backlog, ranked) and the critique's Workers-&-Lag panel: lead with consumer
 * LAG (the health metric of a log pipeline) — as a live trend, not just a number,
 * because what matters is whether the backlog is draining or climbing.
 *
 * A live view over useTopologyManager + the TopicProbe stream:
 *  - the shared SummaryCards row (topology/active counts, worker liveness,
 *    on-disk partitions, health, global R/W rates, 24h produced totals),
 *  - the supervisor card,
 *  - THREE Tachikoma-style Topics panels — Message Rate, Byte Rate, Backlog —
 *    each a multi-series 24h time chart (one series per topic/source) with a
 *    ranked max/avg legend, and
 *  - one row per ACTIVE topology, each FOLDABLE between a compact summary and the
 *    full live detail tree (one `TopologyRow`, folded vs unfolded), in the user's
 *    own drag order (persisted), plus a de-emphasized group of stopped topologies.
 *
 * Row order is the user's drag order — NOT health — so a flapping "behind" badge
 * never reshuffles the list. Order + fold state persist to localStorage.
 *
 * The panels are the real 24h history: a second `RemoteLink` (`useTopicProbeStream`
 * in 'history' mode) replays the durable `topicprobe.p0` log from `start`, and
 * `topicChartSeries` rolls the per-reader samples up per topic into the three
 * metrics — the in-product mirror of Grafana's Topics dashboard.
 *
 * Reuses the same `consoleHref` deep-links so navigation stays single-sourced.
 */

import {
	useState,
	useEffect,
	useRef,
	useMemo,
	useCallback,
	useDeferredValue,
} from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import ConnectionBanner from '@newspack-nodes/shared/components/ConnectionBanner';
import SummaryCards from './SummaryCards';
import TopologyControls from './TopologyControls';
import AlertModal from './AlertModal';
import { useTopologyManager } from './hooks/useTopologyManager';
import { useTopicProbeStream } from './hooks/useTopicProbeStream';
import { useNodeState } from '../runtime/react';
import { topicChartSeries } from './topicProbeSeries';
import { TopicsChart } from './TopicsChart';
import { SupervisorStatus } from './SupervisorStatus';
import { consoleHref, TopologyRow } from './TopologyRow';
import { formatBytes, formatByteRate, formatMsgRate } from './formatters';
import {
	orderTopologies,
	dragReorder,
	dragGapTransforms,
	mergeStoredOrder,
} from './overviewOrder';
import {
	readOrder,
	writeOrder,
	readExpanded,
	writeExpanded,
	readCollapsed,
	writeCollapsed,
} from './overviewPrefs';
import './styles/overview.scss';

// Read the rendered active-row vertical bounds (in display order) for the live
// pointer-drag reorder. Native DnD proved too browser-finicky (esp. Firefox), so
// reordering is pointer-events based and geometry-driven.
function activeRowRects() {
	return [
		...document.querySelectorAll(
			'.nodes-overview__rows [data-topology-row]'
		),
	].map( ( el ) => {
		const r = el.getBoundingClientRect();
		return {
			name: el.getAttribute( 'data-topology-row' ),
			top: r.top,
			bottom: r.bottom,
		};
	} );
}

/**
 * Overview hub tab.
 *
 * @return {import('react').ReactElement} Rendered component.
 */
export default function Overview() {
	// Pointer-drag reorder state, declared FIRST so it can pause everything else
	// while a drag is in flight. `dragName` = the row being dragged. The drag is a
	// FLOAT: the dragged row follows the cursor via a compositor transform set
	// imperatively in the rAF handler — NO React render per move — and the reorder
	// commits to `order` once on pointer-up. (Re-rendering the list every frame is
	// what made the row lag the cursor and build GC pressure the longer you held.)
	const [ dragName, setDragName ] = useState( null );
	const dragNameRef = useRef( null );
	// rAF-coalesce pointer moves: store the latest Y, apply at most once per frame.
	const dragRafRef = useRef( null );
	const dragYRef = useRef( 0 );
	// Drag geometry, cached at pointer-down (transforms don't change layout, so
	// these stay valid for the whole gesture): the grab Y, all row elements + their
	// bounds + names in display order, and the dragged row's index.
	const dragStartYRef = useRef( 0 );
	const dragElsRef = useRef( [] );
	const dragRectsRef = useRef( [] );
	const dragNamesRef = useRef( [] );
	const dragFromRef = useRef( -1 );
	const dragging = null !== dragName;

	// PAUSE all background updates while dragging: the 4s poll is suspended (so it
	// can't fire reconstructWorkers mid-drag) and the SSE-fed probe view is frozen
	// (so the live topicprobe stream doesn't recompute/redraw the Topics charts
	// under the drag). Everything resumes on drop.
	const {
		topologies,
		supervisor,
		currentTime,
		readRate,
		writeRate,
		logPartitions,
		activate,
		deactivate,
		restart,
		connected,
	} = useTopologyManager( { paused: dragging } );

	// A rejected activate/deactivate/restart ({ name, message }) raises this alert.
	const [ alert, setAlert ] = useState( null );
	// Active topology names currently UNFOLDED — restored from localStorage
	// (empty = all folded). Within-tree node-fold set + the user's drag order are
	// likewise persisted; write-through effects keep all three sticky on reload.
	const [ expanded, setExpanded ] = useState( readExpanded );
	const [ order, setOrder ] = useState( readOrder );
	const [ collapsed, setCollapsed ] = useState( readCollapsed );

	useEffect( () => writeExpanded( expanded ), [ expanded ] );
	useEffect( () => writeCollapsed( collapsed ), [ collapsed ] );
	useEffect( () => writeOrder( order ), [ order ] );
	// Cancel a pending drag frame if we unmount mid-drag.
	useEffect(
		() => () => {
			if ( null !== dragRafRef.current ) {
				window.cancelAnimationFrame( dragRafRef.current );
			}
		},
		[]
	);

	// Second link: replay the durable topicprobe.p0 log (24h from `start`) into
	// `topicprobe:view`, the source for the Topics panels. Frozen during a drag.
	useTopicProbeStream( { mode: 'history' } );
	const probeLive = useNodeState( 'topicprobe:view', 'view' );
	const frozenProbeRef = useRef( probeLive );
	if ( ! dragging ) {
		frozenProbeRef.current = probeLive;
	}
	const probeView = dragging ? frozenProbeRef.current : probeLive;

	const actives = topologies.filter( ( t ) => t.active );
	const stopped = topologies
		.filter( ( t ) => ! t.active )
		.sort( ( a, b ) => a.name.localeCompare( b.name ) );

	// Display order is the user's drag order (stored names first, new ones
	// appended alphabetically) — never health, so badges flapping doesn't reorder.
	// The dragged row floats over this order; it only changes on drop.
	const displayedNames = orderTopologies(
		actives.map( ( t ) => t.name ),
		order
	);
	const orderedActives = displayedNames
		.map( ( name ) => actives.find( ( t ) => t.name === name ) )
		.filter( Boolean );

	// Mirror the current display order into a ref so the (stable, useCallback [])
	// drag handlers can read it without re-subscribing — stable handler props are
	// what let `memo(TopologyRow)` skip re-renders.
	const displayedRef = useRef( displayedNames );
	displayedRef.current = displayedNames;

	const expandTopology = useCallback(
		( name ) => setExpanded( ( prev ) => new Set( prev ).add( name ) ),
		[]
	);
	const collapseTopology = useCallback( ( name ) => {
		setExpanded( ( prev ) => {
			const next = new Set( prev );
			next.delete( name );
			return next;
		} );
	}, [] );
	const foldAll = () => setExpanded( new Set() );
	const unfoldAll = () =>
		setExpanded( new Set( actives.map( ( t ) => t.name ) ) );
	const onToggleFold = useCallback( ( key ) => {
		setCollapsed( ( prev ) => {
			const next = new Set( prev );
			if ( next.has( key ) ) {
				next.delete( key );
			} else {
				next.add( key );
			}
			return next;
		} );
	}, [] );

	// Pointer-drag reorder (cross-browser; native HTML5 DnD was too flaky). The
	// grip captures the pointer, so move/up keep firing even over other rows. The
	// gesture is a FLOAT: cache the geometry once, then per frame translate the
	// dragged row to the cursor AND shift the rows it passes to open the drop gap —
	// all compositor transforms, NO React render — committing the reorder once on
	// drop. The handlers are stable (state via refs) so they don't bust row memo.
	const onGripPointerDown = useCallback( ( name, e ) => {
		e.preventDefault();
		// Capture so move/up keep firing as the cursor leaves the grip. A throw
		// (e.g. no active pointer) must not abort the rest of the gesture setup.
		try {
			e.currentTarget.setPointerCapture?.( e.pointerId );
		} catch {
			// no-op — drag proceeds without capture.
		}
		const els = [
			...document.querySelectorAll(
				'.nodes-overview__rows [data-topology-row]'
			),
		];
		dragNameRef.current = name;
		dragStartYRef.current = e.clientY;
		dragElsRef.current = els;
		dragRectsRef.current = activeRowRects();
		dragNamesRef.current = displayedRef.current;
		dragFromRef.current = els.findIndex(
			( el ) => el.getAttribute( 'data-topology-row' ) === name
		);
		// The passed-over rows animate their shift; the dragged row tracks the
		// cursor 1:1 (no transition) and lifts above its siblings.
		els.forEach( ( el, i ) => {
			el.style.transition =
				i === dragFromRef.current ? '' : 'transform 0.15s ease';
		} );
		setDragName( name );
	}, [] );
	const onGripPointerMove = useCallback( ( e ) => {
		if ( ! dragNameRef.current ) {
			return;
		}
		// Coalesce to one transform pass per animation frame using the latest
		// pointer Y — pointermove fires far faster than the display refreshes.
		dragYRef.current = e.clientY;
		if ( null !== dragRafRef.current ) {
			return;
		}
		dragRafRef.current = window.requestAnimationFrame( () => {
			dragRafRef.current = null;
			const els = dragElsRef.current;
			const from = dragFromRef.current;
			if ( from < 0 || ! els[ from ] ) {
				return;
			}
			const { transforms } = dragGapTransforms(
				dragRectsRef.current,
				from,
				dragYRef.current - dragStartYRef.current,
				dragYRef.current
			);
			els.forEach( ( el, i ) => {
				el.style.transform = `translateY(${ transforms[ i ] }px)`;
			} );
			const dragged = els[ from ];
			dragged.style.zIndex = '10';
			dragged.style.position = 'relative';
		} );
	}, [] );
	const onGripPointerUp = useCallback( () => {
		if ( ! dragNameRef.current ) {
			return;
		}
		const name = dragNameRef.current;
		dragNameRef.current = null;
		if ( null !== dragRafRef.current ) {
			window.cancelAnimationFrame( dragRafRef.current );
			dragRafRef.current = null;
		}
		// Reset every row's inline drag styling; React re-renders into the new order.
		dragElsRef.current.forEach( ( el ) => {
			el.style.transform = '';
			el.style.transition = '';
			el.style.zIndex = '';
			el.style.position = '';
		} );
		dragElsRef.current = [];
		// Commit ONCE: where the cursor ended vs the cached row geometry, folded
		// back over the full persisted order (carrying inactive names).
		const reordered = dragReorder(
			dragNamesRef.current,
			name,
			dragRectsRef.current,
			dragYRef.current
		);
		setOrder( ( prev ) => mergeStoredOrder( prev, reordered ) );
		setDragName( null );
	}, [] );

	// Per-topic (source) 24h series for the three Topics panels — message rate,
	// byte rate, backlog. The probe consumers feed the heavy 24h rollups + d3
	// chart redraws (~100ms each); deferring them keeps that work OFF the
	// interaction's critical path. When a probe publish lands (or a drag commits
	// and unfreezes), the urgent render paints with the prior series — memoized,
	// so the charts skip — and React catches the charts up in a follow-up
	// low-priority render. That is what holds grip-drag INP down.
	const consumers = useDeferredValue( probeView?.consumers );
	const msgRateSeries = useMemo(
		() => topicChartSeries( consumers, 'msgRate' ),
		[ consumers ]
	);
	const byteRateSeries = useMemo(
		() => topicChartSeries( consumers, 'byteRate' ),
		[ consumers ]
	);
	const backlogSeries = useMemo(
		() => topicChartSeries( consumers, 'backlog' ),
		[ consumers ]
	);
	const cacheSizeSeries = useMemo(
		() => topicChartSeries( consumers, 'cacheSize' ),
		[ consumers ]
	);

	return (
		<div className="nodes-overview">
			<ConnectionBanner
				connectionError={ ! connected }
				message={ __( 'Disconnected — retrying…', 'newspack-nodes' ) }
			/>
			<SummaryCards
				topologies={ topologies }
				readRate={ readRate }
				writeRate={ writeRate }
				logPartitions={ logPartitions }
				consumers={ consumers }
				newTopologyHref={ consoleHref( '', { isNew: true } ) }
			/>
			<div className="nodes-overview__panels">
				<TopicsChart
					title={ __( 'Topics Message Rate', 'newspack-nodes' ) }
					series={ msgRateSeries }
					formatValue={ formatMsgRate }
				/>
				<TopicsChart
					title={ __( 'Topics Byte Rate', 'newspack-nodes' ) }
					series={ byteRateSeries }
					formatValue={ formatByteRate }
				/>
				<TopicsChart
					title={ __( 'Topics Backlog', 'newspack-nodes' ) }
					series={ backlogSeries }
					formatValue={ formatBytes }
				/>
				<TopicsChart
					title={ __( 'Topics Cache Size', 'newspack-nodes' ) }
					series={ cacheSizeSeries }
					formatValue={ formatBytes }
				/>
			</div>
			{ supervisor && (
				<SupervisorStatus
					supervisor={ supervisor }
					currentTime={ currentTime }
					onRestart={ () => restart( 'supervisor' ) }
				/>
			) }
			{ actives.length > 0 && (
				<div className="nodes-overview__toolbar">
					<button
						type="button"
						className="nodes-overview__foldall button button-small"
						onClick={ foldAll }
					>
						{ __( 'Fold all', 'newspack-nodes' ) }
					</button>
					<button
						type="button"
						className="nodes-overview__unfoldall button button-small"
						onClick={ unfoldAll }
					>
						{ __( 'Unfold all', 'newspack-nodes' ) }
					</button>
				</div>
			) }
			<div className="nodes-overview__rows">
				{ orderedActives.map( ( t ) => (
					<TopologyRow
						key={ t.name }
						topology={ t }
						folded={ ! expanded.has( t.name ) }
						onActivate={ activate }
						onDeactivate={ deactivate }
						onRestart={ restart }
						onError={ setAlert }
						onExpand={ expandTopology }
						onCollapseTopology={ collapseTopology }
						isDragging={ dragName === t.name }
						onGripPointerDown={ onGripPointerDown }
						onGripPointerMove={ onGripPointerMove }
						onGripPointerUp={ onGripPointerUp }
						collapsed={ collapsed }
						onToggleFold={ onToggleFold }
					/>
				) ) }
			</div>
			{ stopped.length > 0 && (
				<div className="nodes-overview__stopped">
					<span className="nodes-overview__stopped-label">
						{ __( 'Stopped', 'newspack-nodes' ) }
					</span>
					{ stopped.map( ( t ) => (
						<span
							key={ t.name }
							className="nodes-overview__stopped-item"
						>
							<span className="nodes-overview__name">
								{ t.name }
							</span>
							<TopologyControls
								name={ t.name }
								active={ false }
								onActivate={ activate }
								onDeactivate={ deactivate }
								onRestart={ restart }
								onError={ setAlert }
								editHref={ consoleHref( t.name, {
									edit: true,
								} ) }
							/>
						</span>
					) ) }
				</div>
			) }
			{ alert && (
				<AlertModal
					title={ sprintf(
						// translators: %s: topology name.
						__( 'Couldn’t update “%s”', 'newspack-nodes' ),
						alert.name
					) }
					message={ alert.message }
					onClose={ () => setAlert( null ) }
				/>
			) }
		</div>
	);
}
