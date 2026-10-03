/**
 * Tables — the station's per-Table operation board over the durable
 * `tablestats.p0` log: what each Table is asked, how often it misses, how
 * long it takes, and how much it holds.
 *
 * A thin view over one replayed stream: `useProbeStream( 'tablestats' )` in
 * history mode replays a day of the Table_Probe sweep into `tablestats:view`.
 * Five panels chart it — ops per second per Table, each operation's rate
 * per worker summed over that worker's Tables, keys missed per second, mean
 * and longest call per Table, and each SQLite Table's file size — and one row
 * per Table carries the window's totals, summed over the same per-sweep
 * samples the charts plot. Every panel but latency stacks, so its column reads
 * as the total.
 *
 * A cell reads '-' where its figure does not apply: a mean or max with no
 * calls, a size off SQLite, upkeep a volatile Table never does, and a level
 * (size, purge backlog, WAL stall) from a Table whose newest record has
 * fallen out of the live window.
 */

import { useMemo, useDeferredValue } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { useProbeStream } from './hooks/useProbeStream';
import { isLiveSample, streamHead } from './liveSample';
import { useNodeField } from '../runtime/react';
import UnparseableLinesNotice from '@newspack-nodes/shared/components/UnparseableLinesNotice';
import {
	topicChartSeries,
	fillModeForMetric,
	perWorker,
} from './topicProbeSeries';
import { TopicsPanels } from './TopicsChart';
import {
	formatBytes,
	formatGroupedCount,
	formatMs,
	formatMsgRate,
} from '@newspack-nodes/shared/utils/formatters';
import './styles/probe-tab.scss';

/**
 * Each entry groups by its own identity.
 *
 * @param {{key:string}} c A Table or operation entry.
 * @return {string} Its key.
 */
const byKey = ( c ) => c.key;

/**
 * Does this Table report a file size? Only SQLite keeps one file per Table.
 *
 * @param {{backend:string}} t A Table entry.
 * @return {boolean} True for sqlite.
 */
const isSqlite = ( t ) => 'sqlite' === t.backend;

/**
 * A duration cell: '-' where the window made no call to measure.
 *
 * @param {?number} ms Milliseconds, or null.
 * @return {string} The label.
 */
const msCell = ( ms ) => ( null === ms ? '-' : formatMs( ms ) );

/** One shared empty model, so an unready view keeps the memos' inputs stable. */
const NO_TABLES = {};

/** The max line's mode, fixed so the chart's memo holds. */
const MAX_MODE = fillModeForMetric( 'maxMs' );

/**
 * Per-operation series per worker: one series per `<op> · <worker>`, summing
 * the operation's rate over every Table that worker sweeps. Tables in one
 * worker are swept at one instant, so `topicChartSeries`' same-ts sum is exact.
 *
 * @param {Object<string,Object>} tables `view.tables`.
 * @return {Object<string,Object>} `<op> · <worker>` => series, as topicChartSeries returns.
 */
function operationSeries( tables ) {
	/** @type {Object<string,{key:string,series:Array<Object>}>} */
	const byOp = {};
	for ( const t of Object.values( tables ) ) {
		for ( const s of t.series || [] ) {
			for ( const [ op, rate ] of Object.entries( s.opRates || {} ) ) {
				( byOp[ op ] ||= { key: op, series: [] } ).series.push( {
					ts: s.ts,
					elapsed: s.elapsed,
					worker: s.worker,
					value: rate,
				} );
			}
		}
	}
	return topicChartSeries( perWorker( byOp ), 'value', byKey );
}

/**
 * Mean latency per Table beside its window max, the max a MAX series.
 *
 * @param {Object<string,Object>} tables `view.tables`.
 * @return {Object<string,Object>} `<id>` and `<id> max` => series.
 */
function latencySeries( tables ) {
	/** @type {Object<string,Object>} */
	const out = topicChartSeries( tables, 'meanMs', byKey );
	for ( const [ id, s ] of Object.entries(
		topicChartSeries( tables, 'maxMs', byKey )
	) ) {
		out[ `${ id } max` ] = { ...s, mode: MAX_MODE };
	}
	return out;
}

/**
 * Does this backend keep its rows on disk? Only a durable Table purges its
 * rows or checkpoints a WAL, so a volatile one has no such upkeep to show.
 *
 * @param {{backend:string}} t A Table entry.
 * @return {boolean} True for sqlite and wpdb.
 */
const isDurable = ( t ) => 'sqlite' === t.backend || 'wpdb' === t.backend;

/**
 * The WAL cell: frames written of frames asked, and a stall count when a live
 * Table's checkpoint is stuck. Only a SQLite Table has a WAL.
 *
 * @param {{backend:string,windowed:Object,latest:Object}} t    A Table entry.
 * @param {boolean}                                        live Its newest record is current.
 * @return {string} The label.
 */
function walLabel( t, live ) {
	if ( ! isSqlite( t ) ) {
		return '-';
	}
	const { walWritten, walFrames } = t.windowed;
	const base = `${ formatGroupedCount( walWritten ) } / ${ formatGroupedCount(
		walFrames
	) }`;
	return live && t.latest.walStalled > 0
		? `${ base } · ${ __(
				'stalled',
				'newspack-nodes'
		  ) } ${ formatGroupedCount( t.latest.walStalled ) }`
		: base;
}

const COLUMNS = [
	__( 'Table', 'newspack-nodes' ),
	__( 'Backend', 'newspack-nodes' ),
	__( 'Ops', 'newspack-nodes' ),
	__( 'Hit %', 'newspack-nodes' ),
	__( 'Avg', 'newspack-nodes' ),
	__( 'Max', 'newspack-nodes' ),
	__( 'Size', 'newspack-nodes' ),
	__( 'Errors', 'newspack-nodes' ),
	__( 'Purged', 'newspack-nodes' ),
	__( 'Purge behind', 'newspack-nodes' ),
	__( 'WAL', 'newspack-nodes' ),
];

/**
 * The purge-backlog cell: whether a live durable Table's purge is behind.
 *
 * @param {{backend:string,latest:Object}} t    A Table entry.
 * @param {boolean}                        live Its newest record is current.
 * @return {string} The label.
 */
function purgeBehindLabel( t, live ) {
	if ( ! isDurable( t ) || ! live ) {
		return '-';
	}
	return t.latest.purgeBehind
		? __( 'behind', 'newspack-nodes' )
		: __( 'no', 'newspack-nodes' );
}

/**
 * Tables station tab.
 *
 * @return {import('react').ReactElement} Rendered component.
 */
export default function Tables() {
	useProbeStream( 'tablestats', { mode: 'history' } );
	const view = useNodeField( 'tablestats:view', 'view' );
	const tables = view?.tables ?? NO_TABLES;
	const deferred = useDeferredValue( tables );

	const opsSeries = useMemo(
		() => topicChartSeries( deferred, 'opsRate', byKey ),
		[ deferred ]
	);
	const opSeries = useMemo( () => operationSeries( deferred ), [ deferred ] );
	const missSeries = useMemo(
		() => topicChartSeries( deferred, 'missRate', byKey ),
		[ deferred ]
	);
	const latency = useMemo( () => latencySeries( deferred ), [ deferred ] );
	const sizeSeries = useMemo(
		() =>
			topicChartSeries(
				Object.fromEntries(
					Object.entries( deferred ).filter( ( [ , t ] ) =>
						isSqlite( t )
					)
				),
				'fileBytes',
				byKey
			),
		[ deferred ]
	);
	const total = __( 'Total', 'newspack-nodes' );
	const panels = [
		{
			title: __( 'Table Ops Rate', 'newspack-nodes' ),
			yLabel: __( 'Ops', 'newspack-nodes' ),
			series: opsSeries,
			formatValue: formatMsgRate,
			metric: 'opsRate',
			stacked: true,
		},
		{
			title: __( 'Table Operation Rate', 'newspack-nodes' ),
			yLabel: __( 'Ops', 'newspack-nodes' ),
			series: opSeries,
			formatValue: formatMsgRate,
			metric: 'opsRate',
			stacked: true,
		},
		{
			title: __( 'Table Miss Rate', 'newspack-nodes' ),
			yLabel: __( 'Misses', 'newspack-nodes' ),
			series: missSeries,
			formatValue: formatMsgRate,
			metric: 'missRate',
			stacked: true,
		},
		{
			title: __( 'Table Latency', 'newspack-nodes' ),
			yLabel: __( 'Latency', 'newspack-nodes' ),
			series: latency,
			formatValue: formatMs,
			metric: 'meanMs',
			stackable: false,
		},
		{
			title: __( 'Table Size', 'newspack-nodes' ),
			yLabel: __( 'Size', 'newspack-nodes' ),
			series: sizeSeries,
			formatValue: formatBytes,
			metric: 'fileBytes',
			stacked: true,
		},
	];

	// Worst first by windowed errors, then by name.
	const rows = Object.values( tables ).sort(
		( a, b ) =>
			b.windowed.errors - a.windowed.errors ||
			a.key.localeCompare( b.key )
	);
	const head = streamHead( tables );

	return (
		<div className="nodes-probe-tab">
			<UnparseableLinesNotice
				source={ __( 'Table statistics', 'newspack-nodes' ) }
				node="tablestats:link"
			/>
			<div className="nodes-probe-tab__panels">
				<TopicsPanels panels={ panels } totalLabel={ total } />
			</div>
			{ 0 === rows.length ? (
				<p className="newspack-nodes-empty-state nodes-probe-tab__empty">
					{ __( 'No Table has reported yet.', 'newspack-nodes' ) }
				</p>
			) : (
				<table className="nodes-probe-tab__table newspack-nodes-table">
					<thead>
						<tr>
							{ COLUMNS.map( ( h ) => (
								<th key={ h }>{ h }</th>
							) ) }
						</tr>
					</thead>
					<tbody>
						{ rows.map( ( t ) => {
							const w = t.windowed;
							const live = isLiveSample( t.latest, head );
							return (
								<tr key={ t.key } data-table-key={ t.key }>
									<td className="nodes-probe-tab__name">
										{ t.key }
									</td>
									<td>{ t.backend }</td>
									<td>{ formatGroupedCount( w.ops ) }</td>
									<td>
										{ null === w.hitPct
											? '-'
											: `${ w.hitPct.toFixed( 1 ) }%` }
									</td>
									<td>{ msCell( w.meanMs ) }</td>
									<td>{ msCell( w.maxMs ) }</td>
									<td>
										{ isSqlite( t ) && live
											? formatBytes( t.latest.fileBytes )
											: '-' }
									</td>
									<td
										className={
											w.errors > 0
												? 'nodes-probe-tab__count is-nonzero'
												: 'nodes-probe-tab__count'
										}
									>
										{ formatGroupedCount( w.errors ) }
									</td>
									<td>
										{ isDurable( t )
											? formatGroupedCount( w.purged )
											: '-' }
									</td>
									<td>{ purgeBehindLabel( t, live ) }</td>
									<td>{ walLabel( t, live ) }</td>
								</tr>
							);
						} ) }
					</tbody>
				</table>
			) }
		</div>
	);
}
