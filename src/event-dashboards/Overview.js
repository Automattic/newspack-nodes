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
 *  - one row per ACTIVE topology (worker pills + uptime + current lag), sorted
 *    worst health first, plus a de-emphasized group of stopped topologies.
 *
 * The panels are the real 24h history: a second `RemoteLink` (`useTopicProbeStream`
 * in 'history' mode) replays the durable `topicprobe.p0` log from `start`, and
 * `topicChartSeries` rolls the per-reader samples up per topic into the three
 * metrics — the in-product mirror of Grafana's Topics dashboard.
 *
 * Deliberately a SUMMARY, not the Topologies tab's full live tree. Reuses the
 * same `consoleHref` deep-links so navigation stays single-sourced.
 */

import { useState } from '@wordpress/element';
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
import { partitionSummaries } from './partitionSummaries';
import {
	formatBytes,
	formatByteRate,
	formatMsgRate,
	formatAge,
} from './formatters';
import './styles/overview.scss';

// Health → label + sort rank (lower = worse = surfaces first).
const HEALTH_LABELS = {
	ok: __( 'ok', 'newspack-nodes' ),
	behind: __( 'behind', 'newspack-nodes' ),
	stalled: __( 'stalled', 'newspack-nodes' ),
};
const HEALTH_RANK = { stalled: 0, behind: 1, ok: 2 };
// Heartbeat age (s) past which a worker pill flags stale — mirrors the
// Topologies tab's connector-heartbeat threshold.
const STALE_HEARTBEAT_S = 30;

/**
 * Roll a topology's live workers up to the per-partition + fleet vitals the row
 * renders: partition summaries, running/total, worst consumer lag (bytes), and
 * the earliest running-worker start (fleet uptime anchor).
 *
 * @param {Object} t A topology row (with an optional live `status`).
 * @return {{ parts: Array, up: number, total: number, behind: number, startedAt: ?number }} Vitals.
 */
function vitals( t ) {
	const workers = t.status?.workers || [];
	const parts = partitionSummaries( workers );
	const up = parts.filter( ( p ) => 'running' === p.status ).length;
	const behind = workers.reduce(
		( max, w ) => Math.max( max, w.behind || 0 ),
		0
	);
	const starts = parts
		.filter( ( p ) => 'running' === p.status && p.started_at )
		.map( ( p ) => p.started_at );
	const startedAt = starts.length ? Math.min( ...starts ) : null;
	return { parts, up, total: parts.length, behind, startedAt };
}

/**
 * One active-topology row: name (live link) + health badge + per-partition
 * worker pills + uptime + current lag, with the shared activate/restart/edit
 * controls.
 *
 * @param {Object}   props
 * @param {Object}   props.topology     The active topology row.
 * @param {?number}  props.currentTime  Server clock (for uptime).
 * @param {Function} props.onActivate   (name) => Promise.
 * @param {Function} props.onDeactivate (name) => Promise.
 * @param {Function} props.onRestart    (name) => Promise.
 * @param {Function} props.onError      ({name,message}) => void for a rejected mutation.
 * @param {Function} props.onExpand     (name) => void; unfold this row to its full detail tree.
 * @return {import('react').ReactElement} The row.
 */
function ActiveRow( {
	topology,
	currentTime,
	onActivate,
	onDeactivate,
	onRestart,
	onError,
	onExpand,
} ) {
	const health = topology.health || 'ok';
	const { parts, up, total, behind, startedAt } = vitals( topology );
	return (
		<div
			className={ `nodes-overview__row nodes-overview__row--${ health }` }
		>
			<button
				type="button"
				className="nodes-overview__expand"
				title={ __( 'Expand', 'newspack-nodes' ) }
				aria-expanded={ false }
				onClick={ () => onExpand( topology.name ) }
			>
				▸
			</button>
			<a
				className="nodes-overview__name"
				href={ consoleHref( topology.name ) }
				title={ __( 'Open in the live console', 'newspack-nodes' ) }
			>
				{ topology.name }
			</a>
			<span
				className={ `nodes-overview__health nodes-overview__health--${ health }` }
			>
				{ HEALTH_LABELS[ health ] ?? health }
			</span>
			<span className="nodes-overview__parts">
				{ parts.map( ( p ) => {
					const dead = 'running' !== p.status;
					const stale =
						! dead &&
						p.heartbeat_age !== null &&
						p.heartbeat_age !== undefined &&
						p.heartbeat_age > STALE_HEARTBEAT_S;
					return (
						<span
							key={ p.partition }
							className={ `nodes-overview__part nodes-overview__part--${
								dead ? 'dead' : 'running'
							}${ stale ? ' is-stale' : '' }` }
						>
							<span className="nodes-overview__part-id">
								P{ p.partition }
							</span>
							{ ! dead &&
								p.heartbeat_age !== null &&
								p.heartbeat_age !== undefined && (
									<span className="nodes-overview__hb">
										{ sprintf(
											// translators: %d: heartbeat age in seconds.
											__( '%ds', 'newspack-nodes' ),
											p.heartbeat_age
										) }
									</span>
								) }
							{ p.restart_pending && (
								<span
									className="nodes-overview__restart"
									title={ __(
										'Restart pending',
										'newspack-nodes'
									) }
								>
									⟳
								</span>
							) }
						</span>
					);
				} ) }
				<span className="nodes-overview__upcount">
					{ sprintf(
						// translators: %1$d: running partitions; %2$d: total partitions.
						__( '%1$d/%2$d up', 'newspack-nodes' ),
						up,
						total
					) }
				</span>
			</span>
			<span className="nodes-overview__uptime">
				{ startedAt ? formatAge( startedAt, currentTime ) : '' }
			</span>
			<span
				className={ `nodes-overview__lag${
					behind > 0 ? ' is-behind' : ''
				}` }
				title={ __(
					'Consumer lag (bytes behind) — see the Backlog panel for the 24h trend',
					'newspack-nodes'
				) }
			>
				<span className="nodes-overview__lagval">
					{ behind > 0
						? sprintf(
								// translators: %s: bytes-behind, e.g. "1.2 KB".
								__( 'lag %s', 'newspack-nodes' ),
								formatBytes( behind )
						  )
						: __( 'caught up', 'newspack-nodes' ) }
				</span>
			</span>
			<TopologyControls
				name={ topology.name }
				active={ true }
				onActivate={ onActivate }
				onDeactivate={ onDeactivate }
				onRestart={ onRestart }
				onError={ onError }
				editHref={ consoleHref( topology.name, { edit: true } ) }
			/>
		</div>
	);
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
	// Active topology names currently UNFOLDED (empty = all folded on load).
	const [ expanded, setExpanded ] = useState( () => new Set() );
	// Within-tree node-fold set, threaded into each unfolded TopologySection.
	const [ collapsed, setCollapsed ] = useState( () => new Set() );

	// Second link: replay the durable topicprobe.p0 log (24h from `start`) into
	// `topicprobe:view`, the source for the per-topology lag sparklines.
	useTopicProbeStream( { mode: 'history' } );
	const probeView = useNodeState( 'topicprobe:view', 'view' );

	const actives = topologies.filter( ( t ) => t.active );
	const stopped = topologies
		.filter( ( t ) => ! t.active )
		.sort( ( a, b ) => a.name.localeCompare( b.name ) );

	// Worst health first (stalled → behind → ok), then alphabetical.
	const activeSorted = [ ...actives ].sort( ( a, b ) => {
		const ra = HEALTH_RANK[ a.health ] ?? HEALTH_RANK.ok;
		const rb = HEALTH_RANK[ b.health ] ?? HEALTH_RANK.ok;
		return ra !== rb ? ra - rb : a.name.localeCompare( b.name );
	} );

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
				{ activeSorted.map( ( t ) =>
					expanded.has( t.name ) ? (
						<TopologyRow
							key={ t.name }
							topology={ t }
							onActivate={ activate }
							onDeactivate={ deactivate }
							onRestart={ restart }
							onError={ setAlert }
							onCollapseTopology={ collapseTopology }
							collapsed={ collapsed }
							onToggleFold={ onToggleFold }
						/>
					) : (
						<ActiveRow
							key={ t.name }
							topology={ t }
							currentTime={ currentTime }
							onActivate={ activate }
							onDeactivate={ deactivate }
							onRestart={ restart }
							onError={ setAlert }
							onExpand={ expandTopology }
						/>
					)
				) }
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
