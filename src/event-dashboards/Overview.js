/**
 * Overview — the hub's at-a-glance FLEET-HEALTH board (the default first paint).
 * The "is everything OK right now?" glance, so you don't have to scroll the dense
 * Topologies tree to spot trouble. Modeled on Tachikoma's topics dashboard (rate
 * + backlog, ranked) and the critique's Workers-&-Lag panel: lead with consumer
 * LAG (the health metric of a log pipeline) — as a live trend, not just a number,
 * because what matters is whether the backlog is draining or climbing.
 *
 * A live view over useTopologyManager:
 *  - a fleet strip (topology/active counts, partitions-up, a worst-health pill),
 *  - the supervisor card,
 *  - one row per ACTIVE topology — per-partition worker pills (running/dead +
 *    heartbeat freshness), a live lag SPARKLINE + current lag, and fleet uptime —
 *    sorted worst health first so problems surface, and
 *  - a de-emphasized group of stopped topologies (Edit only; nothing's live to
 *    open).
 *
 * The hub has no time-series store (the unfed-Prometheus gap), so the sparkline
 * is a client-side rolling window of the recent poll samples — the live
 * mini-version of Grafana's Topics-Backlog panel; long history stays in Grafana.
 *
 * Deliberately a SUMMARY, not the Topologies tab's full live tree. Reuses the
 * same `consoleHref` deep-links so navigation stays single-sourced.
 */

import { useEffect, useState } from '@wordpress/element';
import { __, sprintf, _n } from '@wordpress/i18n';
import ConnectionBanner from '@newspack-nodes/shared/components/ConnectionBanner';
import { useTopologyManager } from './hooks/useTopologyManager';
import { SupervisorStatus } from './SupervisorStatus';
import { consoleHref } from './TopologyManager';
import { partitionSummaries } from './partitionSummaries';
import { Sparkline, appendCapped } from './Sparkline';
import { formatBytes, formatAge } from './formatters';
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
// Lag-sparkline ring-buffer depth (~2.5 min at the 4s poll cadence).
const SPARK_SAMPLES = 40;

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
 * worker pills + uptime + a live lag sparkline & current lag, with an Edit
 * deep-link.
 *
 * @param {Object}   props
 * @param {Object}   props.topology    The active topology row.
 * @param {?number}  props.currentTime Server clock (for uptime).
 * @param {number[]} props.lagHistory  Recent consumer-lag samples (oldest first).
 * @return {import('react').ReactElement} The row.
 */
function ActiveRow( { topology, currentTime, lagHistory } ) {
	const health = topology.health || 'ok';
	const { parts, up, total, behind, startedAt } = vitals( topology );
	return (
		<div
			className={ `nodes-overview__row nodes-overview__row--${ health }` }
		>
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
					'Consumer lag (bytes behind) — sparkline is the recent trend',
					'newspack-nodes'
				) }
			>
				<Sparkline
					values={ lagHistory }
					className="nodes-overview__lagspark"
				/>
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
			<a
				className="nodes-overview__edit"
				href={ consoleHref( topology.name, { edit: true } ) }
				title={ __(
					'Edit this topology in the console',
					'newspack-nodes'
				) }
			>
				{ __( 'Edit', 'newspack-nodes' ) }
			</a>
		</div>
	);
}

/**
 * Worst-health rollup + pill label across the active fleet.
 *
 * @param {Array} actives Active topology rows.
 * @return {{ worst: string, label: string }} Worst health + its pill label.
 */
function fleetHealth( actives ) {
	const stalled = actives.filter( ( t ) => 'stalled' === t.health ).length;
	const behind = actives.filter( ( t ) => 'behind' === t.health ).length;
	if ( stalled ) {
		return {
			worst: 'stalled',
			label: sprintf(
				// translators: %d: number of stalled topologies.
				_n( '%d stalled', '%d stalled', stalled, 'newspack-nodes' ),
				stalled
			),
		};
	}
	if ( behind ) {
		return {
			worst: 'behind',
			label: sprintf(
				// translators: %d: number of lagging topologies.
				_n( '%d behind', '%d behind', behind, 'newspack-nodes' ),
				behind
			),
		};
	}
	return { worst: 'ok', label: __( 'all systems ok', 'newspack-nodes' ) };
}

/**
 * Overview hub tab.
 *
 * @return {import('react').ReactElement} Rendered component.
 */
export default function Overview() {
	const { topologies, supervisor, currentTime, restart, connected } =
		useTopologyManager();

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

	// Live lag history: one sample per server tick, oldest-trimmed, keyed by
	// topology name (stale topologies drop out on the next tick).
	const [ lagHistory, setLagHistory ] = useState( {} );
	useEffect( () => {
		if ( currentTime === null || currentTime === undefined ) {
			return;
		}
		setLagHistory( ( prev ) => {
			const next = {};
			actives.forEach( ( t ) => {
				next[ t.name ] = appendCapped(
					prev[ t.name ] || [],
					vitals( t ).behind,
					SPARK_SAMPLES
				);
			} );
			return next;
		} );
		// One sample per server tick — intentionally NOT re-running on every
		// `actives` re-render (that would double-count within a tick).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ currentTime ] );

	const fleet = actives.reduce(
		( acc, t ) => {
			const v = vitals( t );
			acc.up += v.up;
			acc.total += v.total;
			return acc;
		},
		{ up: 0, total: 0 }
	);
	const { worst, label: fleetHealthLabel } = fleetHealth( actives );

	return (
		<div className="nodes-overview">
			<ConnectionBanner
				connectionError={ ! connected }
				message={ __( 'Disconnected — retrying…', 'newspack-nodes' ) }
			/>
			<div className="nodes-overview__fleet">
				<span className="nodes-overview__count">
					{ sprintf(
						// translators: %1$d: total topologies; %2$d: active count.
						_n(
							'%1$d topology · %2$d active',
							'%1$d topologies · %2$d active',
							topologies.length,
							'newspack-nodes'
						),
						topologies.length,
						actives.length
					) }
				</span>
				{ fleet.total > 0 && (
					<span className="nodes-overview__partsup">
						{ sprintf(
							// translators: %1$d: running partitions; %2$d: total active partitions.
							__( '%1$d / %2$d partitions up', 'newspack-nodes' ),
							fleet.up,
							fleet.total
						) }
					</span>
				) }
				<span
					className={ `nodes-overview__fleet-health nodes-overview__fleet-health--${ worst }` }
				>
					{ fleetHealthLabel }
				</span>
				<a
					className="nodes-overview__new"
					href={ consoleHref( '', { isNew: true } ) }
					title={ __(
						'Create a new topology in the console',
						'newspack-nodes'
					) }
				>
					{ __( '+ New Topology', 'newspack-nodes' ) }
				</a>
			</div>
			{ supervisor && (
				<SupervisorStatus
					supervisor={ supervisor }
					currentTime={ currentTime }
					onRestart={ () => restart( 'supervisor' ) }
				/>
			) }
			<div className="nodes-overview__rows">
				{ activeSorted.map( ( t ) => (
					<ActiveRow
						key={ t.name }
						topology={ t }
						currentTime={ currentTime }
						lagHistory={ lagHistory[ t.name ] || [] }
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
							<a
								className="nodes-overview__edit"
								href={ consoleHref( t.name, { edit: true } ) }
								title={ __(
									'Edit this topology in the console',
									'newspack-nodes'
								) }
							>
								{ __( 'Edit', 'newspack-nodes' ) }
							</a>
						</span>
					) ) }
				</div>
			) }
		</div>
	);
}
