/**
 * Jobs — the hub's per-handler job-outcome board over the durable jobstats.p0 log.
 *
 * A thin view over `useJobstatsStream` (history mode → 24h replay) + the
 * `jobstats:view` model. Per job identity it shows the cumulative run counts, the
 * average + last durations, the last outcome (status badge + one-line message), and
 * when it last ran — plus two Tachikoma-style rate panels (runs/s, errors/s) rolled
 * up per handler from the same per-identity series. The batteries-included answer to
 * "are my background jobs running, and are they failing?".
 */

import { useMemo, useDeferredValue } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { useJobstatsStream } from './hooks/useJobstatsStream';
import { useNodeState } from '../runtime/react';
import { topicChartSeries, fillModeForMetric } from './topicProbeSeries';
import { TopicsChart } from './TopicsChart';
import { formatCount, formatMsgRate, formatAge } from './formatters';
import './styles/jobs.scss';

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

	// Identity rows, worst-first (failing jobs surface at the top).
	const rows = Object.entries( handlers )
		.map( ( [ key, h ] ) => ( { key, ...h } ) )
		.sort(
			( a, b ) =>
				b.latest.errors - a.latest.errors ||
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
			</div>

			{ 0 === rows.length ? (
				<p className="nodes-jobs__empty">
					{ __( 'No job activity yet.', 'newspack-nodes' ) }
				</p>
			) : (
				<table className="nodes-jobs__table wp-list-table widefat striped">
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
							return (
								<tr key={ row.key } data-job-key={ row.key }>
									<td className="nodes-jobs__name">
										<span className="nodes-jobs__handler">
											{ row.key }
										</span>
									</td>
									<td>{ formatCount( l.runs ) }</td>
									<td
										className={
											l.errors > 0
												? 'nodes-jobs__failures is-nonzero'
												: 'nodes-jobs__failures'
										}
									>
										{ formatCount( l.errors ) }
									</td>
									<td>{ formatMs( l.avgDurationMs ) }</td>
									<td>{ formatMs( l.lastDurationMs ) }</td>
									<td>{ formatMs( l.avgQueueMs ) }</td>
									<td>
										<span
											className={ `nodes-jobs__status is-${ l.lastStatus }` }
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
