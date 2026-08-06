/**
 * Jobs — the hub's per-handler job-outcome board over the durable jobstats.p0 log.
 *
 * A thin view over `useJobstatsStream` (history mode → 24h replay) + the
 * `jobstats:view` model. Per job identity it shows the 24h windowed run + failure
 * totals (summed over the same per-interval series the charts plot, so a worker
 * recycle contributes its window like any other), the average + last durations,
 * the last outcome (status badge + one-line message), and when it last ran — plus
 * two Tachikoma-style rate panels (runs/s, errors/s) rolled up per handler from the
 * same per-identity series. The batteries-included answer to "are my background jobs
 * running, and are they failing?".
 */

import { useMemo, useDeferredValue } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { useJobstatsStream } from './hooks/useJobstatsStream';
import { useTopicProbeStream } from './hooks/useTopicProbeStream';
import { useNodeState } from '../runtime/react';
import { topicChartSeries, fillModeForMetric } from './topicProbeSeries';
import { TopicsChart } from './TopicsChart';
import {
	formatBytes,
	formatCount,
	formatMsgRate,
	formatAge,
} from './formatters';
import './styles/jobs.scss';

// The jobs Topic's concrete dirs are `jobs.p<N>`; bare `jobs` tolerated.
const isJobsSource = ( source ) => /^jobs(\.p\d+)?$/.test( source || '' );

// Milliseconds → a compact "Nms" / "N.Ns" label.
function formatMs( ms ) {
	if ( ! Number.isFinite( ms ) || ms <= 0 ) {
		return '0ms';
	}
	if ( ms < 1000 ) {
		return `${ Math.round( ms ) }ms`;
	}
	return `${ ( ms / 1000 ).toFixed( 1 ) }s`;
}

/**
 * Jobs hub tab.
 *
 * @return {import('react').ReactElement} Rendered component.
 */
export default function Jobs() {
	// Replay jobstats.p0 (24h) into jobstats:view.
	useJobstatsStream( { mode: 'history' } );
	const view = useNodeState( 'jobstats:view', 'view' );
	const handlers = view?.handlers ?? {};

	// The jobs Consumer's lag rides the topicprobe stream the Overview replays.
	useTopicProbeStream( { mode: 'history' } );
	const probeView = useNodeState( 'topicprobe:view', 'view' );

	// Per-handler rate rollups, deferred so redraws stay off INP.
	const deferred = useDeferredValue( handlers );
	const runsSeries = useMemo(
		() => topicChartSeries( deferred, 'runsRate', ( c ) => c.handler ),
		[ deferred ]
	);
	const errorsSeries = useMemo(
		() => topicChartSeries( deferred, 'errorsRate', ( c ) => c.handler ),
		[ deferred ]
	);
	// Per IDENTITY, not handler: summing means across identities is invalid.
	const latencySeries = useMemo(
		() => topicChartSeries( deferred, 'queueLatencyMs', ( c ) => c.key ),
		[ deferred ]
	);
	const deferredProbe = useDeferredValue( probeView?.consumers ?? {} );
	const backlogSeries = useMemo(
		() =>
			topicChartSeries(
				Object.fromEntries(
					Object.entries( deferredProbe ).filter( ( [ , c ] ) =>
						isJobsSource( c.source )
					)
				),
				'backlog'
			),
		[ deferredProbe ]
	);

	// Identity rows, worst-first by windowed failures (matching the column).
	const rows = Object.entries( handlers )
		.map( ( [ key, h ] ) => ( { key, ...h } ) )
		.sort(
			( a, b ) =>
				b.windowed.errors - a.windowed.errors ||
				a.key.localeCompare( b.key )
		);

	const nowSec = Math.floor( Date.now() / 1000 );

	return (
		<div className="nodes-jobs">
			<div className="nodes-jobs__panels">
				<TopicsChart
					title={ __( 'Job Runs Rate', 'newspack-nodes' ) }
					series={ runsSeries }
					formatValue={ formatMsgRate }
					fillMode={ fillModeForMetric( 'runsRate' ) }
				/>
				<TopicsChart
					title={ __( 'Job Errors Rate', 'newspack-nodes' ) }
					series={ errorsSeries }
					formatValue={ formatMsgRate }
					fillMode={ fillModeForMetric( 'errorsRate' ) }
				/>
				<TopicsChart
					title={ __( 'Job Backlog', 'newspack-nodes' ) }
					series={ backlogSeries }
					formatValue={ formatBytes }
					fillMode={ fillModeForMetric( 'backlog' ) }
				/>
				<TopicsChart
					title={ __( 'Job Queue Latency', 'newspack-nodes' ) }
					series={ latencySeries }
					formatValue={ formatMs }
					fillMode={ fillModeForMetric( 'queueLatencyMs' ) }
				/>
			</div>

			{ 0 === rows.length ? (
				<p className="newspack-nodes-empty-state nodes-jobs__empty">
					{ __( 'No job activity yet.', 'newspack-nodes' ) }
				</p>
			) : (
				<table className="nodes-jobs__table newspack-nodes-table">
					<thead>
						<tr>
							<th>{ __( 'Job', 'newspack-nodes' ) }</th>
							<th>{ __( 'Runs', 'newspack-nodes' ) }</th>
							<th>{ __( 'Failures', 'newspack-nodes' ) }</th>
							<th>{ __( 'Avg', 'newspack-nodes' ) }</th>
							<th>{ __( 'Last', 'newspack-nodes' ) }</th>
							<th>{ __( 'Queued', 'newspack-nodes' ) }</th>
							<th>{ __( 'Status', 'newspack-nodes' ) }</th>
							<th>{ __( 'Message', 'newspack-nodes' ) }</th>
							<th>{ __( 'Last run', 'newspack-nodes' ) }</th>
						</tr>
					</thead>
					<tbody>
						{ rows.map( ( row ) => {
							const l = row.latest;
							const w = row.windowed;
							return (
								<tr key={ row.key } data-job-key={ row.key }>
									<td className="nodes-jobs__name">
										<span className="nodes-jobs__handler">
											{ row.key }
										</span>
									</td>
									<td>{ formatCount( w.runs ) }</td>
									<td
										className={
											w.errors > 0
												? 'nodes-jobs__failures is-nonzero'
												: 'nodes-jobs__failures'
										}
									>
										{ formatCount( w.errors ) }
									</td>
									<td>{ formatMs( w.avgDurationMs ) }</td>
									<td>{ formatMs( l.lastDurationMs ) }</td>
									<td>{ formatMs( w.avgQueueMs ) }</td>
									<td>
										<span
											className={ `newspack-nodes-status-badge nodes-jobs__status is-${ l.lastStatus }` }
										>
											{ l.lastStatus }
										</span>
									</td>
									<td
										className="nodes-jobs__message"
										title={ l.lastMessage }
									>
										{ l.lastMessage }
									</td>
									<td>
										{ l.lastTs
											? formatAge( l.lastTs, nowSec )
											: '-' }
									</td>
								</tr>
							);
						} ) }
					</tbody>
				</table>
			) }
		</div>
	);
}
