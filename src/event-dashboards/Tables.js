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
 * calls, and a size, WAL or purge the Table's own record carries as null —
 * `Table_Node::probe_stats()` writes null for a slot its backend has no such
 * thing for. A level (size, purge backlog, WAL stall) also reads '-' from a
 * Table whose newest record has fallen out of the live window.
 */

import { useMemo, useDeferredValue } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { useProbeStream } from './hooks/useProbeStream';
import { isLiveSample, streamHead } from './liveSample';
import { useNodeField } from '../runtime/react';
import UnparseableLinesNotice from '@newspack-nodes/shared/components/UnparseableLinesNotice';
import { topicChartSeries, byKey } from './topicProbeSeries';
import { TopicsPanels, ProbeTable, errorsColumn } from './TopicsChart';
import {
	formatBytes,
	formatGroupedCount,
	formatMsgRate,
} from '@newspack-nodes/shared/utils/formatters';
import { formatDuration } from '@newspack-nodes/shared/utils/formatUtils';
import './styles/probe-tab.scss';

/** One shared empty model, so an unready view keeps the memos' inputs stable. */
const NO_TABLES = {};

/**
 * A Table's window-max line plots beside its mean.
 *
 * @param {{key:string}} t A Table entry.
 * @return {string} `<id> max`.
 */
const byMaxKey = ( t ) => `${ t.key } max`;

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
	return topicChartSeries( byOp, 'value', byKey );
}

/**
 * The WAL cell: frames written of frames asked, and a stall count when a live
 * Table's checkpoint is stuck. '-' where the record carries no WAL.
 *
 * @param {{windowed:Object,latest:Object}} t    A Table entry.
 * @param {boolean}                         live Its newest record is current.
 * @return {string} The label.
 */
function walLabel( t, live ) {
	const { walStalled } = t.latest;
	if ( null === walStalled ) {
		return '-';
	}
	const { walWritten, walFrames } = t.windowed;
	const base = `${ formatGroupedCount( walWritten ) } / ${ formatGroupedCount(
		walFrames
	) }`;
	return live && walStalled > 0
		? `${ base } · ${ __(
				'stalled',
				'newspack-nodes'
		  ) } ${ formatGroupedCount( walStalled ) }`
		: base;
}

/**
 * The purge-backlog cell: whether a live Table's purge is behind, '-' where
 * the record says it purges nothing.
 *
 * @param {{latest:Object}} t    A Table entry.
 * @param {boolean}         live Its newest record is current.
 * @return {string} The label.
 */
function purgeBehindLabel( t, live ) {
	const { purgeBehind } = t.latest;
	if ( null === purgeBehind || ! live ) {
		return '-';
	}
	return purgeBehind
		? __( 'behind', 'newspack-nodes' )
		: __( 'no', 'newspack-nodes' );
}

/**
 * The Table table's columns. `ctx.head` is the stream head a level's
 * freshness is judged against.
 *
 * @type {Array<import('./TopicsChart').ProbeColumn>}
 */
const COLUMNS = [
	{
		label: __( 'Table', 'newspack-nodes' ),
		cell: byKey,
		td: () => ( { className: 'nodes-probe-tab__name' } ),
	},
	{ label: __( 'Backend', 'newspack-nodes' ), cell: ( t ) => t.backend },
	{
		label: __( 'Ops', 'newspack-nodes' ),
		cell: ( t ) => formatGroupedCount( t.windowed.ops ),
	},
	{
		label: __( 'Hit %', 'newspack-nodes' ),
		cell: ( t ) =>
			null === t.windowed.hitPct
				? '-'
				: `${ t.windowed.hitPct.toFixed( 1 ) }%`,
	},
	{
		label: __( 'Avg', 'newspack-nodes' ),
		cell: ( t ) => formatDuration( t.windowed.meanMs ),
	},
	{
		label: __( 'Max', 'newspack-nodes' ),
		cell: ( t ) => formatDuration( t.windowed.maxMs ),
	},
	{
		label: __( 'Size', 'newspack-nodes' ),
		cell: ( t, ctx ) =>
			null !== t.latest.fileBytes && isLiveSample( t.latest, ctx.head )
				? formatBytes( t.latest.fileBytes )
				: '-',
	},
	errorsColumn( __( 'Errors', 'newspack-nodes' ) ),
	{
		label: __( 'Purged', 'newspack-nodes' ),
		cell: ( t ) =>
			null === t.latest.purgeBehind
				? '-'
				: formatGroupedCount( t.windowed.purged ),
	},
	{
		label: __( 'Purge behind', 'newspack-nodes' ),
		cell: ( t, ctx ) =>
			purgeBehindLabel( t, isLiveSample( t.latest, ctx.head ) ),
	},
	{
		label: __( 'WAL', 'newspack-nodes' ),
		cell: ( t, ctx ) => walLabel( t, isLiveSample( t.latest, ctx.head ) ),
	},
];

/**
 * Tables station tab.
 *
 * @return {import('react').ReactElement} Rendered component.
 */
export default function Tables() {
	useProbeStream( 'tablestats', { mode: 'history' } );
	const view = useNodeField( 'tablestats:view', 'view' );
	const deferred = useDeferredValue( view?.tables ?? NO_TABLES );

	const opsSeries = useMemo(
		() => topicChartSeries( deferred, 'opsRate', byKey ),
		[ deferred ]
	);
	const opSeries = useMemo( () => operationSeries( deferred ), [ deferred ] );
	const missSeries = useMemo(
		() => topicChartSeries( deferred, 'missRate', byKey ),
		[ deferred ]
	);
	// Mean per Table beside its window max, each series in its own mode.
	const latency = useMemo(
		() => ( {
			...topicChartSeries( deferred, 'meanMs', byKey ),
			...topicChartSeries( deferred, 'maxMs', byMaxKey ),
		} ),
		[ deferred ]
	);
	const sizeSeries = useMemo(
		() => topicChartSeries( deferred, 'fileBytes', byKey ),
		[ deferred ]
	);
	const panels = [
		{
			title: __( 'Table Ops Rate', 'newspack-nodes' ),
			yLabel: __( 'Ops', 'newspack-nodes' ),
			series: opsSeries,
			formatValue: formatMsgRate,
			stacked: true,
		},
		{
			title: __( 'Table Operation Rate', 'newspack-nodes' ),
			yLabel: __( 'Ops', 'newspack-nodes' ),
			series: opSeries,
			formatValue: formatMsgRate,
			stacked: true,
		},
		{
			title: __( 'Table Miss Rate', 'newspack-nodes' ),
			yLabel: __( 'Misses', 'newspack-nodes' ),
			series: missSeries,
			formatValue: formatMsgRate,
			stacked: true,
		},
		{
			title: __( 'Table Latency', 'newspack-nodes' ),
			yLabel: __( 'Latency', 'newspack-nodes' ),
			series: latency,
			formatValue: formatDuration,
			stackable: false,
		},
		{
			title: __( 'Table Size', 'newspack-nodes' ),
			yLabel: __( 'Size', 'newspack-nodes' ),
			series: sizeSeries,
			formatValue: formatBytes,
			stacked: true,
		},
	];

	// Worst first by windowed errors, then by name.
	const rows = useMemo(
		() =>
			Object.values( deferred ).sort(
				( a, b ) =>
					b.windowed.errors - a.windowed.errors ||
					a.key.localeCompare( b.key )
			),
		[ deferred ]
	);
	const context = useMemo(
		() => ( { head: streamHead( deferred ) } ),
		[ deferred ]
	);

	return (
		<div className="nodes-probe-tab">
			<UnparseableLinesNotice
				source={ __( 'Table statistics', 'newspack-nodes' ) }
				node="tablestats:link"
			/>
			<div className="nodes-probe-tab__panels">
				<TopicsPanels panels={ panels } />
			</div>
			<ProbeTable
				columns={ COLUMNS }
				rows={ rows }
				rowKey={ byKey }
				keyAttr="data-table-key"
				context={ context }
				emptyText={ __(
					'No Table has reported yet.',
					'newspack-nodes'
				) }
			/>
		</div>
	);
}
