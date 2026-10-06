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
 * jobs Topic's backlog in bytes per partition per worker, stacked because each
 * is its own debt; and queue latency per job IDENTITY, a mean that never
 * stacks.
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
import { topicChartSeries, byKey, bySource } from './topicProbeSeries';
import { TopicsPanels, ProbeTable, errorsColumn } from './TopicsChart';
import {
	formatBytes,
	formatGroupedCount,
	formatMsgRate,
	formatAge,
} from '@newspack-nodes/shared/utils/formatters';
import { formatDuration } from '@newspack-nodes/shared/utils/formatUtils';
import { axisDuration } from '@newspack-nodes/shared/utils/axis-ticks';
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

/** Shared empty models, so an unready view keeps the memos' inputs stable. */
const NO_HANDLERS = {};
const NO_CONSUMERS = {};

/**
 * The identity table's columns. A mean or max over a window with no runs is
 * null, which `formatDuration` reads as '-'; `ctx.nowSec` dates the last run.
 *
 * @type {Array<import('./TopicsChart').ProbeColumn>}
 */
const COLUMNS = [
	{
		label: __( 'Job', 'newspack-nodes' ),
		cell: byKey,
		td: () => ( { className: 'nodes-probe-tab__name' } ),
	},
	{
		label: __( 'Runs', 'newspack-nodes' ),
		cell: ( row ) => formatGroupedCount( row.windowed.runs ),
	},
	errorsColumn( __( 'Failures', 'newspack-nodes' ) ),
	{
		label: __( 'Avg', 'newspack-nodes' ),
		cell: ( row ) => formatDuration( row.windowed.avgDurationMs ),
	},
	{
		label: __( 'Max', 'newspack-nodes' ),
		cell: ( row ) => formatDuration( row.windowed.maxDurationMs ),
	},
	{
		label: __( 'Last', 'newspack-nodes' ),
		cell: ( row ) => formatDuration( row.latest.lastDurationMs ),
	},
	{
		label: __( 'Queued', 'newspack-nodes' ),
		cell: ( row ) => formatDuration( row.windowed.avgQueueMs ),
	},
	{
		label: __( 'Status', 'newspack-nodes' ),
		cell: ( row ) => (
			<span
				className={ `newspack-nodes-status-badge nodes-jobs__status is-${ row.latest.lastStatus }` }
			>
				{ row.latest.lastStatus }
			</span>
		),
	},
	{
		label: __( 'Message', 'newspack-nodes' ),
		cell: ( row ) => row.latest.lastMessage,
		td: ( row ) => ( {
			className: 'nodes-jobs__message',
			title: row.latest.lastMessage,
		} ),
	},
	{
		label: __( 'Last run', 'newspack-nodes' ),
		cell: ( row, ctx ) =>
			row.latest.lastTs
				? formatAge( row.latest.lastTs, ctx.nowSec )
				: '-',
	},
];

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
	const runsSeries = useMemo(
		() =>
			topicChartSeries( deferred, 'runsRate', byKey, { byWorker: true } ),
		[ deferred ]
	);
	const errorsSeries = useMemo(
		() =>
			topicChartSeries( deferred, 'errorsRate', byKey, {
				byWorker: true,
			} ),
		[ deferred ]
	);
	const latencySeries = useMemo(
		() =>
			topicChartSeries( deferred, 'queueLatencyMs', byKey, {
				byWorker: false,
			} ),
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
				'backlog',
				bySource,
				{ byWorker: true }
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

	const panels = [
		{
			title: __( 'Job Runs Rate', 'newspack-nodes' ),
			yLabel: __( 'Runs', 'newspack-nodes' ),
			series: runsSeries,
			formatValue: formatMsgRate,
			stacked: true,
		},
		{
			title: __( 'Job Errors Rate', 'newspack-nodes' ),
			yLabel: __( 'Errors', 'newspack-nodes' ),
			series: errorsSeries,
			formatValue: formatMsgRate,
			stacked: true,
		},
		{
			title: __( 'Job Backlog', 'newspack-nodes' ),
			yLabel: __( 'Backlog', 'newspack-nodes' ),
			series: backlogSeries,
			formatValue: formatBytes,
			stacked: true,
		},
		{
			title: __( 'Job Queue Latency', 'newspack-nodes' ),
			yLabel: __( 'Latency', 'newspack-nodes' ),
			series: latencySeries,
			formatFor: axisDuration,
			stackable: false,
		},
	];

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
			<TopicsPanels panels={ panels } />
			<ProbeTable
				columns={ COLUMNS }
				rows={ rows }
				rowKey={ byKey }
				keyAttr="data-job-key"
				context={ { nowSec: Math.floor( Date.now() / 1000 ) } }
				emptyText={ __( 'No job activity yet.', 'newspack-nodes' ) }
			/>
		</div>
	);
}
