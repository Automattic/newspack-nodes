/**
 * The Overview, Jobs and Tables pages' sources and the blocks their layouts
 * are composed of, for both the tab bundle and its layout editor, which
 * each import this module, so each bundle declares the sources it reads.
 *
 * Two polls answer the fleet board — `dump_graph` through the Worker Status
 * transform, and `topologies dump` — and three streams replay a day of each
 * probe log. `nodes/board` joins the two polls once per answer, and every
 * reader of the board reads it; `nodes/fleet` derives the fleet's vitals
 * from the board and the topic probe, so one stat strip reads them all and
 * still makes no fetch of its own. Every series a chart draws and every live total a tile
 * shows is a field derived from a view's model (`fieldValue()`), so it is
 * computed once a model, whichever blocks show it.
 */

import { __, _n, sprintf } from '@wordpress/i18n';
import { SUBSTRATE_VIEWS } from '@newspack-nodes/shared/blocks';
import { registerSource } from '@newspack-nodes/shared/sources';
import {
	formatBytes,
	formatByteRate,
	formatCount,
	formatMsgRate,
} from '@newspack-nodes/shared/utils/formatters';
import { axisDuration } from '@newspack-nodes/shared/utils/axis-ticks';
import { views } from './nodes/register';
import { OP_PREFIX } from './nodes/tablestats-view-node';
import { topicChartSeries, byKey, bySource } from './topicProbeSeries';
import { fleetSummary } from './fleetSummary';
import { probe24hTotals } from './probe24hTotals';
import { liveTotal, streamHead } from './liveSample';
import { BOARD_GROUP, BOARD_MS, boardOf } from './hooks/useTopologyManager';
import topologyRowsBlock from './blocks/topology-rows';
import probeTableBlock from './blocks/probe-table';
import './styles/summary-cards.scss';

/** Each probe log a page replays, by its stream. */
export const PROBE_LOGS = {
	topicprobe: 'topicprobe.p0',
	jobstats: 'jobstats.p0',
	tablestats: 'tablestats.p0',
};

/** A level's newest reading counts once; a reader's rate adds per worker. */
const WHOLE = { byWorker: false };
const PER_WORKER = { byWorker: true };

/**
 * Does this consumer tail the jobs Topic, `jobs` or `jobs.p<N>`?
 *
 * @param {Object} consumer A topic-probe consumer.
 * @return {boolean} Whether it does.
 */
const readsJobs = ( consumer ) =>
	/^jobs(\.p\d+)?$/.test( consumer.source || '' );

/**
 * A Table's window-max line, plotted beside its mean.
 *
 * @param {{key:string}} table A Table entry.
 * @return {string} `<id> max`.
 */
const byMaxKey = ( table ) => `${ table.key } max`;

/**
 * Per-operation series per worker, one per `<op> · <worker>`, each summing
 * that operation's rate over every Table the worker sweeps in a bucket.
 *
 * @param {?Object<string,Object>} tables The tablestats view's `tables`.
 * @return {Object<string,Object>} The series.
 */
function operationSeries( tables ) {
	const ops = new Set();
	for ( const table of Object.values( tables ?? {} ) ) {
		for ( const bucket of table.buckets || [] ) {
			Object.keys( bucket.f )
				.filter( ( field ) => field.startsWith( OP_PREFIX ) )
				.forEach( ( field ) => ops.add( field ) );
		}
	}
	return Object.assign(
		{},
		...[ ...ops ].map( ( field ) =>
			topicChartSeries(
				tables,
				field,
				() => field.slice( OP_PREFIX.length ),
				PER_WORKER
			)
		)
	);
}

/**
 * The health tile's words: the worst level and how many active topologies
 * stand at it, stalled outranking behind.
 *
 * @param {ReturnType<typeof fleetSummary>} fleet The fleet's vitals.
 * @return {string} The words.
 */
function healthLabel( fleet ) {
	if ( fleet.stalledCount > 0 ) {
		return sprintf(
			// translators: %d: number of stalled topologies.
			_n(
				'%d stalled',
				'%d stalled',
				fleet.stalledCount,
				'newspack-nodes'
			),
			fleet.stalledCount
		);
	}
	if ( fleet.behindCount > 0 ) {
		return sprintf(
			// translators: %d: number of lagging topologies.
			_n( '%d behind', '%d behind', fleet.behindCount, 'newspack-nodes' ),
			fleet.behindCount
		);
	}
	return __( 'ok', 'newspack-nodes' );
}

/**
 * A live total over one probe map, each live entry's newest sample summed.
 *
 * @param {'consumers'|'partitions'} map   Which map.
 * @param {string}                   field The sample's field.
 * @return {(model: Object) => number} The derivation, over a fleet model.
 */
const live =
	( map, field ) =>
	( { probe } ) =>
		liveTotal( probe[ map ], streamHead( probe[ map ] ), field );

registerSource( 'nodes/worker-status', {
	label: __( 'Worker status', 'newspack-nodes' ),
	kind: 'poll',
	group: BOARD_GROUP,
	ci: 'workers',
	command: 'dump_graph',
	viewClass: views.WorkerStatusView,
	transformClass: views.WorkerStatusTransform,
	intervalMs: BOARD_MS,
} );

registerSource( 'nodes/topologies', {
	label: __( 'Topologies', 'newspack-nodes' ),
	kind: 'poll',
	group: BOARD_GROUP,
	ci: 'topologies',
	command: 'dump',
	viewClass: views.TopologyManagerView,
	intervalMs: BOARD_MS,
} );

registerSource( 'nodes/topicprobe', {
	label: __( 'Topic probe', 'newspack-nodes' ),
	kind: 'stream',
	subscribe: () => PROBE_LOGS.topicprobe,
	viewClass: views.TopicProbeView,
	mode: 'history',
	fields: {
		msgRate: {
			label: __( 'Messages read', 'newspack-nodes' ),
			axis: __( 'Messages', 'newspack-nodes' ),
			kind: 'series',
			format: formatMsgRate,
			value: ( { consumers } ) =>
				topicChartSeries( consumers, 'msgRate', bySource, PER_WORKER ),
		},
		byteRate: {
			label: __( 'Bytes read', 'newspack-nodes' ),
			axis: __( 'Bytes', 'newspack-nodes' ),
			kind: 'series',
			format: formatByteRate,
			value: ( { consumers } ) =>
				topicChartSeries( consumers, 'byteRate', bySource, PER_WORKER ),
		},
		backlog: {
			label: __( 'Backlog', 'newspack-nodes' ),
			kind: 'series',
			format: formatBytes,
			value: ( { consumers } ) =>
				topicChartSeries( consumers, 'backlog', bySource, PER_WORKER ),
		},
		cacheSize: {
			label: __( 'Cache size', 'newspack-nodes' ),
			axis: __( 'Cache Size', 'newspack-nodes' ),
			kind: 'series',
			format: formatBytes,
			value: ( { consumers } ) =>
				topicChartSeries(
					consumers,
					'cacheSize',
					bySource,
					PER_WORKER
				),
		},
		endBytes: {
			label: __( 'Partition size', 'newspack-nodes' ),
			axis: __( 'Size', 'newspack-nodes' ),
			kind: 'series',
			format: formatBytes,
			value: ( { partitions } ) =>
				topicChartSeries( partitions, 'endBytes', bySource, WHOLE ),
		},
		diskBytes: {
			label: __( 'Partition on disk', 'newspack-nodes' ),
			axis: __( 'Disk', 'newspack-nodes' ),
			kind: 'series',
			format: formatBytes,
			value: ( { partitions } ) =>
				topicChartSeries( partitions, 'diskBytes', bySource, WHOLE ),
		},
		jobsBacklog: {
			label: __( 'Jobs backlog', 'newspack-nodes' ),
			axis: __( 'Backlog', 'newspack-nodes' ),
			kind: 'series',
			format: formatBytes,
			value: ( { consumers = {} } ) =>
				topicChartSeries(
					Object.fromEntries(
						Object.entries( consumers ).filter( ( [ , one ] ) =>
							readsJobs( one )
						)
					),
					'backlog',
					bySource,
					PER_WORKER
				),
		},
	},
} );

registerSource( 'nodes/jobstats', {
	label: __( 'Job statistics', 'newspack-nodes' ),
	kind: 'stream',
	subscribe: () => PROBE_LOGS.jobstats,
	viewClass: views.JobstatsView,
	mode: 'history',
	fields: {
		runsRate: {
			label: __( 'Runs', 'newspack-nodes' ),
			kind: 'series',
			format: formatMsgRate,
			value: ( { handlers } ) =>
				topicChartSeries( handlers, 'runsRate', byKey, PER_WORKER ),
		},
		errorsRate: {
			label: __( 'Errors', 'newspack-nodes' ),
			kind: 'series',
			format: formatMsgRate,
			value: ( { handlers } ) =>
				topicChartSeries( handlers, 'errorsRate', byKey, PER_WORKER ),
		},
		queueLatencyMs: {
			label: __( 'Queue latency', 'newspack-nodes' ),
			axis: __( 'Latency', 'newspack-nodes' ),
			kind: 'series',
			formatFor: axisDuration,
			value: ( { handlers } ) =>
				topicChartSeries( handlers, 'queueLatencyMs', byKey, WHOLE ),
		},
	},
} );

registerSource( 'nodes/tablestats', {
	label: __( 'Table statistics', 'newspack-nodes' ),
	kind: 'stream',
	subscribe: () => PROBE_LOGS.tablestats,
	viewClass: views.TablestatsView,
	mode: 'history',
	fields: {
		opsRate: {
			label: __( 'Ops per Table', 'newspack-nodes' ),
			axis: __( 'Ops', 'newspack-nodes' ),
			kind: 'series',
			format: formatMsgRate,
			value: ( { tables } ) =>
				topicChartSeries( tables, 'opsRate', byKey, WHOLE ),
		},
		operations: {
			label: __( 'Ops per operation', 'newspack-nodes' ),
			axis: __( 'Ops', 'newspack-nodes' ),
			kind: 'series',
			format: formatMsgRate,
			value: ( { tables } ) => operationSeries( tables ),
		},
		missRate: {
			label: __( 'Misses', 'newspack-nodes' ),
			kind: 'series',
			format: formatMsgRate,
			value: ( { tables } ) =>
				topicChartSeries( tables, 'missRate', byKey, WHOLE ),
		},
		latency: {
			label: __( 'Latency', 'newspack-nodes' ),
			kind: 'series',
			formatFor: axisDuration,
			value: ( { tables } ) => ( {
				...topicChartSeries( tables, 'meanMs', byKey, WHOLE ),
				...topicChartSeries( tables, 'maxMs', byMaxKey, WHOLE ),
			} ),
		},
		fileBytes: {
			label: __( 'Size', 'newspack-nodes' ),
			kind: 'series',
			format: formatBytes,
			value: ( { tables } ) =>
				topicChartSeries( tables, 'fileBytes', byKey, WHOLE ),
		},
		fileDiskBytes: {
			label: __( 'On Disk', 'newspack-nodes' ),
			kind: 'series',
			format: formatBytes,
			value: ( { tables } ) =>
				topicChartSeries( tables, 'fileDiskBytes', byKey, WHOLE ),
		},
	},
} );

registerSource( 'nodes/board', {
	label: __( 'Fleet board', 'newspack-nodes' ),
	kind: 'derived',
	from: [ 'nodes/worker-status', 'nodes/topologies' ],
	derive: ( [ worker, topology ] ) => boardOf( worker, topology ),
} );

registerSource( 'nodes/fleet', {
	label: __( 'Fleet', 'newspack-nodes' ),
	kind: 'derived',
	from: [ 'nodes/board', 'nodes/topicprobe' ],
	derive: ( [ board, probe ] ) => ( {
		board,
		probe: probe ?? {},
		fleet: fleetSummary( board.topologies ),
	} ),
	fields: {
		topologies: {
			label: __( 'Topologies', 'newspack-nodes' ),
			kind: 'value',
			value: ( { fleet } ) => fleet,
			format: ( fleet ) =>
				sprintf(
					// translators: %1$d: total topologies; %2$d: active count.
					__( '%1$d · %2$d active', 'newspack-nodes' ),
					fleet.topologyCount,
					fleet.activeCount
				),
		},
		workers: {
			label: __( 'Workers', 'newspack-nodes' ),
			kind: 'value',
			value: ( { fleet } ) => fleet,
			format: ( fleet ) =>
				sprintf(
					// translators: %1$d: running workers; %2$d: expected workers.
					__( '%1$d / %2$d up', 'newspack-nodes' ),
					fleet.workersUp,
					fleet.workersTotal
				),
		},
		partitions: {
			label: __( 'Partitions', 'newspack-nodes' ),
			kind: 'value',
			value: ( { board } ) => board.logPartitions,
			format: String,
		},
		health: {
			label: __( 'Health', 'newspack-nodes' ),
			kind: 'value',
			value: ( { fleet } ) => fleet,
			format: healthLabel,
			modifier: ( fleet ) => `health-${ fleet.health }`,
		},
		read: {
			label: __( 'Read', 'newspack-nodes' ),
			kind: 'value',
			value: ( { board } ) => board.readRate,
			format: formatByteRate,
		},
		write: {
			label: __( 'Write', 'newspack-nodes' ),
			kind: 'value',
			value: ( { board } ) => board.writeRate,
			format: formatByteRate,
		},
		msgrate: {
			label: __( 'Msgs read/s', 'newspack-nodes' ),
			kind: 'value',
			value: live( 'consumers', 'msgRate' ),
			format: formatMsgRate,
		},
		backlog: {
			label: __( 'Backlog', 'newspack-nodes' ),
			kind: 'value',
			value: live( 'consumers', 'backlog' ),
			format: formatBytes,
		},
		messages: {
			label: __( 'Msgs read · 24h', 'newspack-nodes' ),
			kind: 'value',
			value: ( { probe } ) => probe24hTotals( probe.consumers ).msgs,
			format: formatCount,
		},
		bytes: {
			label: __( 'Bytes read · 24h', 'newspack-nodes' ),
			kind: 'value',
			value: ( { probe } ) => probe24hTotals( probe.consumers ).bytes,
			format: formatBytes,
		},
		'cache-total': {
			label: __( 'Total Cache', 'newspack-nodes' ),
			kind: 'value',
			value: live( 'consumers', 'cacheSize' ),
			format: formatBytes,
		},
		'size-total': {
			label: __( 'Total Size', 'newspack-nodes' ),
			kind: 'value',
			value: live( 'partitions', 'endBytes' ),
			format: formatBytes,
		},
		'disk-total': {
			label: __( 'Total On Disk', 'newspack-nodes' ),
			kind: 'value',
			value: live( 'partitions', 'diskBytes' ),
			format: formatBytes,
		},
	},
} );

/**
 * Every block the three pages' layouts may hold, by block name.
 *
 * @type {Object<string,import('@newspack-nodes/shared/composition/CompositionView').CompositionBlockView>}
 */
export const BLOCK_VIEWS = {
	...SUBSTRATE_VIEWS,
	'newspack-nodes/topology-rows': topologyRowsBlock,
	'newspack-nodes/probe-table': probeTableBlock,
};
