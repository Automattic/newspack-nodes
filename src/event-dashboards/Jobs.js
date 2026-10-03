/**
 * Jobs — the station's per-handler job-outcome board over the durable `jobstats.p0`
 * log. The batteries-included answer to "are my background jobs running, and are
 * they failing?".
 *
 * A thin view over two replayed streams. `useProbeStream( 'jobstats' )` in
 * history mode replays 24h of `jobstats.p0` into the `jobstats:view` model, the
 * source of every run, failure, duration and outcome below;
 * `useProbeStream( 'topicprobe' )` supplies the backlog, which belongs to the
 * Consumer tailing the jobs Topic rather than to any job identity.
 *
 * Four Tachikoma-style panels chart that window: runs/s and errors/s per job
 * IDENTITY per worker, stacked so the column reads as the fleet's total; the
 * jobs Topic's backlog in bytes, stacked because each partition's is its own
 * debt; and queue latency per job IDENTITY, a mean that never stacks.
 * One table row per identity then carries the windowed run and failure totals,
 * the average, longest and last durations, the average queue wait, the last
 * outcome (a status badge plus its one-line message) and when it last ran. A
 * mean or max over a window with no runs reads '-'. Those totals are summed
 * over the same per-interval series the charts plot, so a worker recycle
 * contributes its window like any other rather than reading as a counter reset.
 */

import { useMemo, useDeferredValue } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { useProbeStream } from './hooks/useProbeStream';
import { useNodeField } from '../runtime/react';
import UnparseableLinesNotice from '@newspack-nodes/shared/components/UnparseableLinesNotice';
import {
	topicChartSeries,
	fillModeForMetric,
	perWorker,
} from './topicProbeSeries';
import { TopicsChart } from './TopicsChart';
import {
	formatBytes,
	formatGroupedCount,
	formatMs,
	formatMsgRate,
	formatAge,
} from '@newspack-nodes/shared/utils/formatters';
import './styles/probe-tab.scss';
import './styles/jobs.scss';

/**
 * Does this consumer tail the jobs Topic?
 *
 * The Topic's concrete dirs are `jobs.p<N>`; a bare `jobs` matches too. The
 * topicprobe stream carries every Consumer the probe sweeps, so without the test
 * the backlog panel plots unrelated topics beside the jobs one.
 *
 * @param {string} source The consumer's `source` from `topicprobe:view`.
 * @return {boolean} True when the consumer reads the jobs Topic.
 */
const isJobsSource = ( source ) => /^jobs(\.p\d+)?$/.test( source || '' );

/**
 * Each entry plots under its own key.
 *
 * @param {{key:string}} c A job identity or a per-worker pseudo-entry.
 * @return {string} Its key.
 */
const byKey = ( c ) => c.key;

/**
 * A duration cell: '-' where the window ran nothing to measure.
 *
 * @param {?number} ms Milliseconds, or null.
 * @return {string} The label.
 */
const msCell = ( ms ) => ( null === ms ? '-' : formatMs( ms ) );

/** Shared empty models, so an unready view keeps the memos' inputs stable. */
const NO_HANDLERS = {};
const NO_CONSUMERS = {};

/**
 * Jobs station tab.
 *
 * @return {import('react').ReactElement} Rendered component.
 */
export default function Jobs() {
	// Replay jobstats.p0 (24h) into jobstats:view.
	useProbeStream( 'jobstats', { mode: 'history' } );
	const view = useNodeField( 'jobstats:view', 'view' );
	const handlers = view?.handlers ?? NO_HANDLERS;

	// The jobs Consumer's lag rides the topicprobe stream the Overview replays.
	useProbeStream( 'topicprobe', { mode: 'history' } );
	const probeView = useNodeField( 'topicprobe:view', 'view' );

	// Deferred so redraws stay off INP.
	const deferred = useDeferredValue( handlers );
	// One stream per identity per worker; the stacked chart sums them.
	const streams = useMemo( () => perWorker( deferred ), [ deferred ] );
	const runsSeries = useMemo(
		() => topicChartSeries( streams, 'runsRate', byKey ),
		[ streams ]
	);
	const errorsSeries = useMemo(
		() => topicChartSeries( streams, 'errorsRate', byKey ),
		[ streams ]
	);
	// Per IDENTITY: a mean over its workers' samples, never a sum.
	const latencySeries = useMemo(
		() => topicChartSeries( deferred, 'queueLatencyMs', byKey ),
		[ deferred ]
	);
	const deferredProbe = useDeferredValue(
		probeView?.consumers ?? NO_CONSUMERS
	);
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
	const total = __( 'Total', 'newspack-nodes' );

	return (
		<div className="nodes-probe-tab">
			<UnparseableLinesNotice
				source={ __( 'Job statistics', 'newspack-nodes' ) }
				node="jobstats:link"
			/>
			<UnparseableLinesNotice
				source={ __( 'Job backlog', 'newspack-nodes' ) }
				node="topicprobe:link"
			/>
			<div className="nodes-probe-tab__panels">
				<TopicsChart
					title={ __( 'Job Runs Rate', 'newspack-nodes' ) }
					yLabel={ __( 'Runs', 'newspack-nodes' ) }
					series={ runsSeries }
					formatValue={ formatMsgRate }
					fillMode={ fillModeForMetric( 'runsRate' ) }
					stacked
					totalLabel={ total }
				/>
				<TopicsChart
					title={ __( 'Job Errors Rate', 'newspack-nodes' ) }
					yLabel={ __( 'Errors', 'newspack-nodes' ) }
					series={ errorsSeries }
					formatValue={ formatMsgRate }
					fillMode={ fillModeForMetric( 'errorsRate' ) }
					stacked
					totalLabel={ total }
				/>
				<TopicsChart
					title={ __( 'Job Backlog', 'newspack-nodes' ) }
					yLabel={ __( 'Backlog', 'newspack-nodes' ) }
					series={ backlogSeries }
					formatValue={ formatBytes }
					fillMode={ fillModeForMetric( 'backlog' ) }
					stacked
					totalLabel={ total }
				/>
				<TopicsChart
					title={ __( 'Job Queue Latency', 'newspack-nodes' ) }
					yLabel={ __( 'Latency', 'newspack-nodes' ) }
					series={ latencySeries }
					formatValue={ formatMs }
					fillMode={ fillModeForMetric( 'queueLatencyMs' ) }
					stackable={ false }
				/>
			</div>

			{ 0 === rows.length ? (
				<p className="newspack-nodes-empty-state nodes-probe-tab__empty">
					{ __( 'No job activity yet.', 'newspack-nodes' ) }
				</p>
			) : (
				<table className="nodes-probe-tab__table newspack-nodes-table">
					<thead>
						<tr>
							<th>{ __( 'Job', 'newspack-nodes' ) }</th>
							<th>{ __( 'Runs', 'newspack-nodes' ) }</th>
							<th>{ __( 'Failures', 'newspack-nodes' ) }</th>
							<th>{ __( 'Avg', 'newspack-nodes' ) }</th>
							<th>{ __( 'Max', 'newspack-nodes' ) }</th>
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
									<td className="nodes-probe-tab__name">
										{ row.key }
									</td>
									<td>{ formatGroupedCount( w.runs ) }</td>
									<td
										className={
											w.errors > 0
												? 'nodes-probe-tab__count is-nonzero'
												: 'nodes-probe-tab__count'
										}
									>
										{ formatGroupedCount( w.errors ) }
									</td>
									<td>{ msCell( w.avgDurationMs ) }</td>
									<td>{ msCell( w.maxDurationMs ) }</td>
									<td>{ formatMs( l.lastDurationMs ) }</td>
									<td>{ msCell( w.avgQueueMs ) }</td>
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
