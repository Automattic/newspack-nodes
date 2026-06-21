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
	mergeStoredOrder,
} from './overviewOrder';
import {
	readOrder,
	writeOrder,
	readExpanded,
	writeExpanded,
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
	} = useTopologyManager();
	// A rejected activate/deactivate/restart ({ name, message }) raises this alert.
	const [ alert, setAlert ] = useState( null );
	// Active topology names currently UNFOLDED — restored from localStorage
	// (empty = all folded). Within-tree node-fold set + the user's drag order are
	// likewise persisted; write-through effects keep all three sticky on reload.
	const [ expanded, setExpanded ] = useState( readExpanded );
	const [ order, setOrder ] = useState( readOrder );
	const [ collapsed, setCollapsed ] = useState( () => new Set() );
	// Pointer-drag reorder: the name being dragged + the transient live order it
	// produces (committed to `order` only on pointer-up, so we don't thrash
	// localStorage on every move). `dragNameRef` mirrors `dragName` for the
	// pointer-move/up handlers (which fire from the captured grip, not React state).
	const [ dragName, setDragName ] = useState( null );
	const [ liveOrder, setLiveOrder ] = useState( null );
	const dragNameRef = useRef( null );
	// rAF-coalesce pointer moves: store the latest Y, apply at most once per frame.
	const dragRafRef = useRef( null );
	const dragYRef = useRef( 0 );

	useEffect( () => writeExpanded( expanded ), [ expanded ] );
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
	// `topicprobe:view`, the source for the Topics panels.
	useTopicProbeStream( { mode: 'history' } );
	const probeView = useNodeState( 'topicprobe:view', 'view' );

	const actives = topologies.filter( ( t ) => t.active );
	const stopped = topologies
		.filter( ( t ) => ! t.active )
		.sort( ( a, b ) => a.name.localeCompare( b.name ) );

	// Display order is the user's drag order (stored names first, new ones
	// appended alphabetically) — never health, so badges flapping doesn't reorder.
	// Mid-drag, `liveOrder` (the in-progress reorder) takes over so rows visibly
	// shuffle under the cursor.
	const displayedNames =
		liveOrder ??
		orderTopologies(
			actives.map( ( t ) => t.name ),
			order
		);
	const orderedActives = displayedNames
		.map( ( name ) => actives.find( ( t ) => t.name === name ) )
		.filter( Boolean );

	// Mirror the current display order + live order into refs so the drag handlers
	// can stay referentially STABLE (useCallback []) — stable handler props are
	// what let `memo(TopologyRow)` skip a re-render on every drag frame.
	const displayedRef = useRef( displayedNames );
	displayedRef.current = displayedNames;
	const liveOrderRef = useRef( null );
	liveOrderRef.current = liveOrder;

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
	// grip captures the pointer, so move/up keep firing even over other rows; each
	// move recomputes the live order from the row geometry under the cursor. All
	// three are stable (read current order via refs) so they don't bust row memo.
	const onGripPointerDown = useCallback( ( name, e ) => {
		e.preventDefault();
		e.currentTarget.setPointerCapture?.( e.pointerId );
		dragNameRef.current = name;
		setDragName( name );
		setLiveOrder( displayedRef.current );
	}, [] );
	const onGripPointerMove = useCallback( ( e ) => {
		if ( ! dragNameRef.current ) {
			return;
		}
		// Coalesce to one reorder per animation frame using the latest pointer Y —
		// pointermove fires far faster than we can usefully re-render.
		dragYRef.current = e.clientY;
		if ( null !== dragRafRef.current ) {
			return;
		}
		dragRafRef.current = window.requestAnimationFrame( () => {
			dragRafRef.current = null;
			const name = dragNameRef.current;
			if ( ! name ) {
				return;
			}
			setLiveOrder( ( prev ) =>
				dragReorder(
					prev ?? displayedRef.current,
					name,
					activeRowRects(),
					dragYRef.current
				)
			);
		} );
	}, [] );
	const onGripPointerUp = useCallback( () => {
		if ( ! dragNameRef.current ) {
			return;
		}
		dragNameRef.current = null;
		if ( null !== dragRafRef.current ) {
			window.cancelAnimationFrame( dragRafRef.current );
			dragRafRef.current = null;
		}
		// Commit: fold the live active order back over the full persisted order
		// (carrying inactive names) — once, so localStorage isn't thrashed.
		if ( liveOrderRef.current ) {
			setOrder( ( prev ) =>
				mergeStoredOrder( prev, liveOrderRef.current )
			);
		}
		setDragName( null );
		setLiveOrder( null );
	}, [] );

	// Per-topic (source) 24h series for the three Topics panels — message rate,
	// byte rate, backlog. MEMOIZED on the probe consumers so a drag-reorder (which
	// re-renders Overview on every pointer frame) doesn't recompute these heavy
	// 24h rollups — that was the source of the progressive drag lag.
	const consumers = probeView?.consumers;
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
						className="nodes-overview__foldall"
						onClick={ foldAll }
					>
						{ __( 'Fold all', 'newspack-nodes' ) }
					</button>
					<button
						type="button"
						className="nodes-overview__unfoldall"
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
