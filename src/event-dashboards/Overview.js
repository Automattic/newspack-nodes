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

import { useState, useEffect } from '@wordpress/element';
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
	reorderNames,
	mergeStoredOrder,
} from './overviewOrder';
import {
	readOrder,
	writeOrder,
	readExpanded,
	writeExpanded,
} from './overviewPrefs';
import './styles/overview.scss';

// dataTransfer MIME for a row-reorder drag. Plain text (not a custom type) is the
// most cross-browser-reliable — Firefox is finicky about custom drag data types.
const DRAG_MIME = 'text/plain';

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

	useEffect( () => writeExpanded( expanded ), [ expanded ] );
	useEffect( () => writeOrder( order ), [ order ] );

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
	const orderedNames = orderTopologies(
		actives.map( ( t ) => t.name ),
		order
	);
	const orderedActives = orderedNames
		.map( ( name ) => actives.find( ( t ) => t.name === name ) )
		.filter( Boolean );

	const expandTopology = ( name ) =>
		setExpanded( ( prev ) => new Set( prev ).add( name ) );
	const collapseTopology = ( name ) =>
		setExpanded( ( prev ) => {
			const next = new Set( prev );
			next.delete( name );
			return next;
		} );
	const foldAll = () => setExpanded( new Set() );
	const unfoldAll = () =>
		setExpanded( new Set( actives.map( ( t ) => t.name ) ) );
	const onToggleFold = ( key ) =>
		setCollapsed( ( prev ) => {
			const next = new Set( prev );
			if ( next.has( key ) ) {
				next.delete( key );
			} else {
				next.add( key );
			}
			return next;
		} );

	// Native HTML5 row reorder (mirrors the palette's dataTransfer idiom): the grip
	// carries the dragged name; dropping on a row inserts it before that row.
	const onRowDragStart = ( name, e ) => {
		e.dataTransfer.setData( DRAG_MIME, name );
		e.dataTransfer.effectAllowed = 'move';
	};
	const onRowDropOn = ( targetName, e ) => {
		e.preventDefault();
		const dragged = e.dataTransfer.getData( DRAG_MIME );
		if ( ! dragged || dragged === targetName ) {
			return;
		}
		// Merge the reordered ACTIVE names back over the full persisted order so a
		// drag while some topology is inactive doesn't drop its saved slot.
		setOrder( ( prev ) =>
			mergeStoredOrder(
				prev,
				reorderNames( orderedNames, dragged, targetName )
			)
		);
	};

	// Per-topic (source) 24h series for the three Topics panels — message rate,
	// byte rate, backlog — each ranked by max in its own legend.
	const consumers = probeView?.consumers || {};
	const msgRateSeries = topicChartSeries( consumers, 'msgRate' );
	const byteRateSeries = topicChartSeries( consumers, 'byteRate' );
	const backlogSeries = topicChartSeries( consumers, 'backlog' );

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
				consumers={ probeView?.consumers }
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
						onDragStart={ onRowDragStart }
						onDropOn={ onRowDropOn }
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
