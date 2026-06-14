/**
 * Worker Status Component — log readers as a linear producer→consumer pipeline.
 *
 * THIN view over the `workerstatus:*` node graph (mounted by
 * `useWorkerStatusGraph`). The graph owns all data: `workerstatus:poll` runs the
 * dump_metadata poll, `workerstatus:transform` computes the read/write rates and
 * segment add/remove tracking, and `workerstatus:view` holds the render model.
 * This component only reads that model (via `useNodeState`) and renders — the
 * pure presentation helpers below (SegmentBar / LogSection / WorkerConnector /
 * SupervisorStatus / buildRenderPlan) are unchanged.
 */

import { memo, useMemo } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { useNodeState } from '../runtime/react';
import ConnectionBanner from '@newspack-nodes/shared/components/ConnectionBanner';
import {
	formatBytes,
	formatByteRate,
	formatAge,
	formatEta,
} from './formatters';
import {
	useWorkerStatusGraph,
	initialRefresh,
	REFRESH_OPTIONS,
} from './hooks/useWorkerStatusGraph';
import './styles/worker-status.scss';

// Re-exported for backwards-compat (the localStorage migration helper moved into
// the graph hook, which owns the refresh interval).
export { initialRefresh };

// The view model before the first poll publishes one — drives the loading gate.
const EMPTY_MODEL = {
	workers: [],
	supervisor: null,
	logs: [],
	byteRates: {},
	writeRates: {},
	segmentSize: 64 * 1024 * 1024,
	currentTime: Math.floor( Date.now() / 1000 ),
	prevSegments: {},
	removingSegments: {},
	error: null,
	loading: true,
};

/**
 * Single segment bar visualization (horizontal bar layout).
 *
 * @param {Object}  props              Component props.
 * @param {Object}  props.segment      Segment data { id, size, mtime }.
 * @param {number}  props.maxSize      Max segment size for scaling.
 * @param {number}  props.cursorSeg    Current cursor segment ID.
 * @param {number}  props.cursorOffset Current cursor offset.
 * @param {number}  props.newestSegId  ID of the newest segment.
 * @param {boolean} props.isNew        Whether this segment is newly appeared.
 * @param {boolean} props.isRemoving   Whether this segment is being removed.
 * @return {import('react').ReactElement} Rendered component.
 */
export const SegmentBar = memo( function SegmentBar( {
	segment,
	maxSize,
	cursorSeg,
	cursorOffset,
	newestSegId,
	isNew,
	isRemoving,
} ) {
	const fillPercent = maxSize > 0 ? ( segment.size / maxSize ) * 100 : 0;
	// No cursor (output-only log) → treat all segments as processed.
	const hasReader = cursorSeg !== undefined && cursorSeg !== null;
	const isCurrent = hasReader && segment.id === cursorSeg;
	const isProcessed = ! hasReader || segment.id < cursorSeg;
	const isNewest = segment.id === newestSegId;

	const processedPercent =
		isCurrent && segment.size > 0
			? ( cursorOffset / segment.size ) * fillPercent
			: 0;
	const pendingPercent = isCurrent ? fillPercent - processedPercent : 0;
	const pendingClass = isNewest ? 'pending' : ''; // Yellow only for newest, red otherwise.

	const classNames = [
		'worker-segment-h',
		isNew ? 'segment-slide-in' : '',
		isRemoving ? 'segment-slide-out' : '',
	]
		.filter( Boolean )
		.join( ' ' );

	return (
		<div
			className={ classNames }
			title={ sprintf(
				// translators: 1: segment id, 2: formatted segment size.
				__( 'Segment %1$s: %2$s', 'newspack-nodes' ),
				segment.id,
				formatBytes( segment.size )
			) }
		>
			<div className="segment-label-h">{ segment.id }</div>
			<div className="segment-bar-h">
				{ isCurrent ? (
					<>
						<div
							className="segment-fill-h processed"
							style={ { width: `${ processedPercent }%` } }
						/>
						<div
							className={ `segment-fill-h ${ pendingClass }` }
							style={ { width: `${ pendingPercent }%` } }
						/>
					</>
				) : (
					<div
						className={ `segment-fill-h ${
							isProcessed ? 'processed' : ''
						}` }
						style={ { width: `${ fillPercent }%` } }
					/>
				) }
			</div>
			<div className="segment-size-h">
				{ formatBytes( segment.size ) }
			</div>
		</div>
	);
} );

/**
 * Log section showing segments for all partitions of a log.
 *
 * @param {Object} props                  Component props.
 * @param {string} props.name             Display name for the log.
 * @param {string} props.logKey           Key prefix for rate lookups (e.g., 'firehose').
 * @param {Array}  props.partitions       Array of partition data with segments.
 * @param {Object} props.writeRates       Write rates by log key.
 * @param {number} props.maxSize          Max segment size.
 * @param {Object} props.prevSegments     Previous segment IDs by key.
 * @param {Object} props.cursorData       Cursor data by partition (optional, for logs with readers).
 * @param {Object} props.removingSegments Segments being removed (animating out) by key.
 * @return {import('react').ReactElement} Rendered component.
 */
const LogSection = memo( function LogSection( {
	name,
	logKey: logKeyPrefix,
	partitions,
	writeRates,
	maxSize,
	prevSegments,
	cursorData,
	removingSegments = {},
} ) {
	const sorted = [ ...partitions ].sort(
		( a, b ) => a.partition - b.partition
	);

	return (
		<div className="log-section">
			<div className="log-header">
				<span className="log-name">{ name }</span>
			</div>
			<div className="log-partitions">
				{ sorted.map( ( p ) => {
					const logKey = `${ logKeyPrefix }-${ p.partition }`;
					const cursor = cursorData?.[ p.partition ];
					const newestSegId =
						p.segments.length > 0
							? Math.max( ...p.segments.map( ( s ) => s.id ) )
							: 0;

					// Merge current segments with removing segments.
					const removing = removingSegments[ logKey ] || [];
					const allSegments = [ ...removing, ...p.segments ].sort(
						( a, b ) => a.id - b.id
					);
					const removingIds = new Set(
						removing.map( ( s ) => s.id )
					);

					return (
						<div key={ p.partition } className="log-partition-row">
							<div className="log-partition-info">
								<span className="partition-label-inline">
									P{ p.partition }
								</span>
								<span className="log-write-rate">
									W { formatByteRate( writeRates[ logKey ] ) }
								</span>
							</div>
							<div className="partition-segments">
								{ allSegments.map( ( segment ) => (
									<SegmentBar
										key={ segment.id }
										segment={ segment }
										maxSize={ maxSize }
										cursorSeg={ cursor?.seg }
										cursorOffset={ cursor?.offset }
										newestSegId={ newestSegId }
										isNew={
											prevSegments?.[ logKey ] &&
											! prevSegments[ logKey ].has(
												segment.id
											)
										}
										isRemoving={ removingIds.has(
											segment.id
										) }
									/>
								) ) }
								{ allSegments.length === 0 && (
									<div className="no-segments-h">
										{ __(
											'No segments',
											'newspack-nodes'
										) }
									</div>
								) }
							</div>
						</div>
					);
				} ) }
			</div>
		</div>
	);
} );

/**
 * Worker connector between two logs.
 *
 * @param {Object}   props             Component props.
 * @param {string}   props.name        Worker name.
 * @param {Array}    props.workers     Workers of this type.
 * @param {Object}   props.readRates   Read rates by worker key.
 * @param {number}   props.currentTime Current timestamp for age calculation.
 * @param {Function} props.onRestart   Callback to restart worker(s).
 * @param {boolean}  props.showArrows  Whether to show direction arrows.
 * @return {import('react').ReactElement} Rendered component.
 */
const WorkerConnector = memo( function WorkerConnector( {
	name,
	workers,
	readRates,
	currentTime,
	onRestart,
	showArrows = true,
} ) {
	const sorted = [ ...workers ].sort( ( a, b ) => a.partition - b.partition );
	const allRunning = workers.every( ( w ) => w.status === 'running' );
	const allDead = workers.every( ( w ) => w.status === 'dead' );
	const anyPendingRestart = workers.some( ( w ) => w.restart_pending );
	const workerType = workers[ 0 ]?.type;

	return (
		<div className={ `worker-connector ${ allDead ? 'dead' : '' }` }>
			<div className="connector-arrow">{ showArrows && '↓' }</div>
			<div className="connector-content">
				<span className="connector-name">{ name }</span>
				{ sorted.map( ( w ) => {
					const key = `${ w.handler || w.type }-${ w.partition }-${
						w.source || ''
					}`;
					return (
						<span
							key={ w.partition }
							className="connector-partition"
						>
							<span
								className={ `worker-status-badge compact ${ w.status }` }
							>
								P{ w.partition }
							</span>
							<span
								className="connector-age"
								title={ __( 'Worker age', 'newspack-nodes' ) }
							>
								{ w.started_at && w.status === 'running'
									? formatAge( w.started_at, currentTime )
									: '' }
							</span>
							{ w.heartbeat_age !== null &&
								w.heartbeat_age !== undefined && (
									<span
										className={ `connector-heartbeat ${
											w.heartbeat_age > 30 ? 'stale' : ''
										}` }
										title={ __(
											'Heartbeat age',
											'newspack-nodes'
										) }
									>
										{ w.heartbeat_age }s
									</span>
								) }
							<span
								className={ `connector-rate ${
									w.status === 'dead' ? 'dead' : ''
								}` }
							>
								R { formatByteRate( readRates[ key ] ) }
							</span>
							<span
								className={ `connector-behind ${
									w.behind > 1024 * 1024 ? 'warning' : ''
								}` }
							>
								{ w.behind > 0 ? formatBytes( w.behind ) : '' }
							</span>
							{ w.behind > 0 && (
								<span
									className={ `connector-eta ${
										! readRates[ key ] ||
										readRates[ key ] <= 0
											? 'stalled'
											: ''
									}` }
									title={ __(
										'Estimated time to catch up',
										'newspack-nodes'
									) }
								>
									{ formatEta( w.behind, readRates[ key ] ) }
								</span>
							) }
							{ w.restart_pending && (
								<span
									className="connector-restart-pending"
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
				<span className="connector-trailing">
					{ allRunning && (
						<span className="worker-status-badge running small">
							{ __( 'ALL RUN', 'newspack-nodes' ) }
						</span>
					) }
					{ allDead && (
						<span className="worker-status-badge dead small">
							{ __( 'ALL DEAD', 'newspack-nodes' ) }
						</span>
					) }
					{ onRestart && ! allDead && ! anyPendingRestart && (
						<button
							type="button"
							className="worker-restart-btn"
							onClick={ () => onRestart( workerType ) }
							title={ __(
								'Request graceful restart',
								'newspack-nodes'
							) }
						>
							↻
						</button>
					) }
					{ anyPendingRestart && (
						<span className="worker-restart-pending-label">
							restarting...
						</span>
					) }
				</span>
			</div>
			<div className="connector-arrow">{ showArrows && '↓' }</div>
		</div>
	);
} );

/**
 * Supervisor status row.
 *
 * @param {Object}   props             Component props.
 * @param {Object}   props.supervisor  Supervisor status descriptor.
 * @param {number}   props.currentTime Current timestamp for age calculation.
 * @param {Function} props.onRestart   Callback to restart the supervisor.
 * @return {import('react').ReactElement} Rendered component.
 */
const SupervisorStatus = memo( function SupervisorStatus( {
	supervisor,
	currentTime,
	onRestart,
} ) {
	if ( ! supervisor ) {
		return null;
	}

	const isDead = supervisor.status === 'dead';

	return (
		<div className="supervisor-section">
			<div className="supervisor-header">
				<span className="supervisor-title">
					{ __( 'Supervisor', 'newspack-nodes' ) }
				</span>
			</div>
			<div className="supervisor-list">
				<div className={ `supervisor-row ${ isDead ? 'dead' : '' }` }>
					<span className="supervisor-name">
						{ __( 'Supervisor', 'newspack-nodes' ) }
					</span>
					<div className="supervisor-instance">
						<span
							className={ `worker-status-badge compact ${ supervisor.status }` }
						>
							{ supervisor.status === 'running'
								? __( 'RUN', 'newspack-nodes' )
								: __( 'DEAD', 'newspack-nodes' ) }
						</span>
						<span
							className="supervisor-age"
							title={ __( 'Uptime', 'newspack-nodes' ) }
						>
							{ supervisor.started_at &&
							supervisor.status === 'running'
								? formatAge(
										supervisor.started_at,
										currentTime
								  )
								: '' }
						</span>
						{ supervisor.heartbeat_age !== null &&
							supervisor.heartbeat_age !== undefined && (
								<span
									className={ `connector-heartbeat ${
										supervisor.heartbeat_age > 30
											? 'stale'
											: ''
									}` }
									title={ __(
										'Heartbeat age',
										'newspack-nodes'
									) }
								>
									{ supervisor.heartbeat_age }s
								</span>
							) }
						{ supervisor.restart_pending && (
							<span
								className="connector-restart-pending"
								title="Restart pending"
							>
								⟳
							</span>
						) }
					</div>
					<span className="connector-trailing">
						{ onRestart &&
							! isDead &&
							! supervisor.restart_pending && (
								<button
									type="button"
									className="worker-restart-btn"
									onClick={ () => onRestart( 'supervisor' ) }
									title={ __(
										'Request graceful restart',
										'newspack-nodes'
									) }
								>
									↻
								</button>
							) }
						{ supervisor.restart_pending && (
							<span className="worker-restart-pending-label">
								{ __( 'restarting…', 'newspack-nodes' ) }
							</span>
						) }
					</span>
				</div>
			</div>
		</div>
	);
} );

/**
 * Build a linear render plan from the worker list.
 *
 * @param {Array} workers     Worker descriptors from the REST endpoint.
 * @param {Array} logsCatalog Top-level `logs` array (canonical per-log slots).
 * @return {Array} Render plan items.
 */
function buildRenderPlan( workers, logsCatalog = [] ) {
	if ( ! workers || workers.length === 0 ) {
		if ( logsCatalog.length === 0 ) {
			return [];
		}
		return logsCatalog.map( ( log ) => ( {
			kind: 'log',
			name: log.name,
			partitions: log.partitions || [],
			segment_size: log.segment_size,
			hasCursor: false,
		} ) );
	}

	// One step per (type, handler, source): a handler fed by multiple
	// Consumers has a distinct cursor/lag/rate per source.
	const stepsByKey = new Map();
	workers.forEach( ( w ) => {
		const handler = w.handler || w.type;
		const source = w.source || '';
		const key = `${ w.type }|${ handler }|${ source }`;
		if ( ! stepsByKey.has( key ) ) {
			stepsByKey.set( key, {
				// `type` stays the worker_type for styling; `key` is the unique id.
				type: w.type,
				key,
				handlerName: handler,
				source,
				inputs: Array.isArray( w.inputs ) ? w.inputs : [],
				outputs: Array.isArray( w.outputs ) ? w.outputs : [],
				workers: [],
			} );
		}
		stepsByKey.get( key ).workers.push( w );
	} );
	const steps = [ ...stepsByKey.values() ];

	// Standalone workers (no inputs AND no outputs) aren't part of any log flow.
	// Render them first — right under Supervisor — instead of letting the topo
	// sort interleave them into an unrelated log block by mere list position.
	const isConnected = ( step ) =>
		step.inputs.length > 0 || step.outputs.length > 0;
	const orphanSteps = steps.filter( ( s ) => ! isConnected( s ) );
	const connectedSteps = steps.filter( isConnected );

	// Producer/consumer maps: log name → step key(s).
	const producers = new Map();
	const consumers = new Map();
	steps.forEach( ( step ) => {
		step.outputs.forEach( ( name ) => {
			if ( ! producers.has( name ) ) {
				producers.set( name, [] );
			}
			producers.get( name ).push( step.key );
		} );
		step.inputs.forEach( ( name ) => {
			if ( ! consumers.has( name ) ) {
				consumers.set( name, [] );
			}
			consumers.get( name ).push( step.key );
		} );
	} );

	// Topo sort: a step reading log X comes after any step writing X (stable on tie).
	const stepIndex = new Map( steps.map( ( s, i ) => [ s.key, i ] ) );
	const visited = new Set();
	const sorted = [];
	const visit = ( step ) => {
		if ( visited.has( step.key ) ) {
			return;
		}
		visited.add( step.key );
		step.inputs.forEach( ( name ) => {
			const producerKeys = producers.get( name ) || [];
			producerKeys.forEach( ( pkey ) => {
				if ( pkey === step.key ) {
					return;
				}
				const pstep = steps[ stepIndex.get( pkey ) ];
				if ( pstep ) {
					visit( pstep );
				}
			} );
		} );
		sorted.push( step );
	};
	connectedSteps.forEach( visit );

	// Place each log: above its first consumer if any, else below its last producer.
	const beforeStep = new Map();
	const afterStep = new Map();
	const allLogs = new Set( [ ...producers.keys(), ...consumers.keys() ] );
	allLogs.forEach( ( name ) => {
		const consumerKeys = consumers.get( name ) || [];
		const producerKeys = producers.get( name ) || [];
		if ( consumerKeys.length > 0 ) {
			// Render once above the FIRST consumer (in topo order).
			const firstConsumer = sorted.find( ( s ) =>
				consumerKeys.includes( s.key )
			);
			if ( firstConsumer ) {
				if ( ! beforeStep.has( firstConsumer.key ) ) {
					beforeStep.set( firstConsumer.key, [] );
				}
				beforeStep.get( firstConsumer.key ).push( name );
			}
		} else if ( producerKeys.length > 0 ) {
			// No consumer — terminal output. Render below the LAST producer.
			const lastProducer = [ ...sorted ]
				.reverse()
				.find( ( s ) => producerKeys.includes( s.key ) );
			if ( lastProducer ) {
				if ( ! afterStep.has( lastProducer.key ) ) {
					afterStep.set( lastProducer.key, [] );
				}
				afterStep.get( lastProducer.key ).push( name );
			}
		}
	} );

	// log name → canonical slot list (source of truth for partition-row count).
	const logSlotsByName = new Map();
	const logSegmentSizeByName = new Map();
	logsCatalog.forEach( ( log ) => {
		logSlotsByName.set( log.name, log.partitions || [] );
		if ( log.segment_size ) {
			logSegmentSizeByName.set( log.name, log.segment_size );
		}
	} );

	const collectLogPartitions = ( logName ) => {
		const consumerKeys = consumers.get( logName ) || [];

		// Cursor data by partition from any worker reading this log.
		const cursorByPartition = new Map();
		let hasCursor = false;
		for ( const ckey of consumerKeys ) {
			const step = steps[ stepIndex.get( ckey ) ];
			if ( ! step ) {
				continue;
			}
			step.workers.forEach( ( w ) => {
				const entry = ( w.inputs_status || [] ).find(
					( s ) => s && s.name === logName
				);
				if ( entry && entry.cursor_seg !== undefined ) {
					cursorByPartition.set( w.partition, {
						cursor_seg: entry.cursor_seg,
						cursor_offset: entry.cursor_offset,
					} );
					hasCursor = true;
				}
			} );
		}

		const canonical = logSlotsByName.get( logName );
		if ( canonical && canonical.length > 0 ) {
			const partitions = canonical.map( ( slot ) => {
				const cursor = cursorByPartition.get( slot.partition );
				return cursor ? { ...slot, ...cursor } : slot;
			} );
			return { partitions, hasCursor };
		}

		// No canonical entry (dir not yet created) — fall back to worker data.
		const producerKeys = producers.get( logName ) || [];
		for ( const ckey of consumerKeys ) {
			const step = steps[ stepIndex.get( ckey ) ];
			if ( ! step ) {
				continue;
			}
			const partitions = [];
			step.workers.forEach( ( w ) => {
				const entry = ( w.inputs_status || [] ).find(
					( s ) => s && s.name === logName
				);
				if ( entry ) {
					partitions.push( {
						partition: w.partition,
						segments: entry.segments || [],
						total_size: entry.total_size || 0,
						cursor_seg: entry.cursor_seg,
						cursor_offset: entry.cursor_offset,
					} );
				}
			} );
			if ( partitions.length > 0 ) {
				return { partitions, hasCursor: true };
			}
		}
		for ( const pkey of producerKeys ) {
			const step = steps[ stepIndex.get( pkey ) ];
			if ( ! step ) {
				continue;
			}
			const partitions = [];
			step.workers.forEach( ( w ) => {
				const entry = ( w.outputs_status || [] ).find(
					( s ) => s && s.name === logName
				);
				if ( entry ) {
					partitions.push( {
						partition: w.partition,
						segments: entry.segments || [],
						total_size: entry.total_size || 0,
					} );
				}
			} );
			if ( partitions.length > 0 ) {
				return { partitions, hasCursor: false };
			}
		}

		return { partitions: [], hasCursor: false };
	};

	const plan = [];
	const rendered = new Set();
	const renderLog = ( logName ) => {
		if ( rendered.has( logName ) ) {
			return;
		}
		rendered.add( logName );
		const { partitions, hasCursor } = collectLogPartitions( logName );
		plan.push( {
			kind: 'log',
			name: logName,
			partitions,
			segment_size: logSegmentSizeByName.get( logName ),
			hasCursor,
		} );
	};

	orphanSteps.forEach( ( step ) => {
		plan.push( { kind: 'worker', step, showArrows: false } );
	} );

	sorted.forEach( ( step ) => {
		( beforeStep.get( step.key ) || [] ).forEach( renderLog );
		const hasInputs = step.inputs.length > 0;
		const hasOutputs = step.outputs.length > 0;
		plan.push( {
			kind: 'worker',
			step,
			showArrows: hasInputs || hasOutputs,
		} );
		( afterStep.get( step.key ) || [] ).forEach( renderLog );
	} );

	// Append catalog logs the step walk missed (produced but never tailed).
	logsCatalog.forEach( ( log ) => {
		if ( rendered.has( log.name ) ) {
			return;
		}
		rendered.add( log.name );
		plan.push( {
			kind: 'log',
			name: log.name,
			partitions: log.partitions || [],
			segment_size: log.segment_size,
			hasCursor: false,
		} );
	} );

	return plan;
}

/**
 * Worker Status component.
 *
 * @param {Object}  props           Component props.
 * @param {number}  props.refreshMs Refresh interval in milliseconds.
 * @param {boolean} props.fullPage  Whether rendering in full page mode.
 * @return {import('react').ReactElement} Rendered component.
 */
export default function WorkerStatus( { refreshMs = 2000, fullPage = false } ) {
	// Mount the node graph; it owns the poll, the rate/segment math, and the
	// interval. It returns the thin control callbacks + the current interval.
	const {
		restart,
		setRefreshInterval,
		refreshMs: refreshInterval,
	} = useWorkerStatusGraph( { refreshMs } );

	// The single read surface: the enriched render model the graph publishes.
	const model = useNodeState( 'workerstatus:view', 'view' ) ?? EMPTY_MODEL;
	const {
		workers,
		supervisor,
		logs: logsCatalog,
		byteRates,
		writeRates,
		segmentSize,
		currentTime,
		prevSegments,
		removingSegments,
		error,
		loading,
	} = model;

	// Build the linear render plan from the current worker list.
	const renderPlan = useMemo(
		() => buildRenderPlan( workers, logsCatalog ),
		[ workers, logsCatalog ]
	);

	// Helper to format worker type as display name.
	const formatWorkerName = ( type ) => {
		return type
			.split( '-' )
			.map( ( word ) => word.charAt( 0 ).toUpperCase() + word.slice( 1 ) )
			.join( ' ' );
	};

	// Helper to derive the rate-lookup key from a log file name.
	const getLogKey = ( logName ) =>
		logName ? logName.replace( /\.log$/, '' ) : '';

	if ( loading && workers.length === 0 ) {
		return (
			<div className="worker-status-loading">
				{ __( 'Loading worker status…', 'newspack-nodes' ) }
			</div>
		);
	}

	const containerClass = fullPage ? 'worker-status-full' : 'worker-status';

	// Calculate total read rate across all workers.
	const totalReadRate = Object.values( byteRates ).reduce(
		( sum, rate ) => sum + ( rate || 0 ),
		0
	);

	// Calculate total write rate across all logs.
	const totalWriteRate = Object.values( writeRates ).reduce(
		( sum, rate ) => sum + ( rate || 0 ),
		0
	);

	return (
		<div className={ containerClass }>
			{ ! fullPage && (
				<h3>{ __( 'Worker Status', 'newspack-nodes' ) }</h3>
			) }
			{ fullPage && (
				<div className="worker-status-header">
					<h2>{ __( 'Worker Status', 'newspack-nodes' ) }</h2>
					{ error && (
						<ConnectionBanner
							connectionError={ !! error }
							message={ error }
						/>
					) }
					<div className="worker-status-total-rate">
						<span className="total-rate-write">
							<span className="total-rate-label">
								{ /* translators: abbreviation for "write rate". */ }
								{ __( 'W', 'newspack-nodes' ) }
							</span>
							<span className="total-rate-value">
								{ formatByteRate( totalWriteRate ) }
							</span>
						</span>
						<span className="total-rate-read">
							<span className="total-rate-label">
								{ /* translators: abbreviation for "read rate". */ }
								{ __( 'R', 'newspack-nodes' ) }
							</span>
							<span className="total-rate-value">
								{ formatByteRate( totalReadRate ) }
							</span>
						</span>
					</div>
					<div className="worker-status-controls">
						<select
							className="newspack-nodes-refresh-select"
							value={ refreshInterval }
							onChange={ ( e ) =>
								setRefreshInterval( e.target.value )
							}
							title={ __( 'Refresh interval', 'newspack-nodes' ) }
						>
							{ REFRESH_OPTIONS.map( ( opt ) => (
								<option key={ opt.value } value={ opt.value }>
									{ opt.label }
								</option>
							) ) }
						</select>
					</div>
				</div>
			) }
			{ supervisor && (
				<SupervisorStatus
					supervisor={ supervisor }
					currentTime={ currentTime }
					onRestart={ restart }
				/>
			) }

			<div className="pipeline-flow">
				{ renderPlan.map( ( item, idx ) => {
					if ( item.kind === 'log' ) {
						const logKey = getLogKey( item.name );
						const cursorData = item.hasCursor
							? Object.fromEntries(
									item.partitions
										.filter(
											( p ) =>
												p.cursor_seg !== undefined &&
												p.cursor_seg !== null &&
												p.cursor_offset !== undefined &&
												p.cursor_offset !== null
										)
										.map( ( p ) => [
											p.partition,
											{
												seg: p.cursor_seg,
												offset: p.cursor_offset,
											},
										] )
							  )
							: undefined;
						return (
							<LogSection
								key={ `log-${ item.name }-${ idx }` }
								name={ item.name }
								logKey={ logKey }
								partitions={ item.partitions }
								writeRates={ writeRates }
								maxSize={ item.segment_size || segmentSize }
								prevSegments={ prevSegments }
								cursorData={ cursorData }
								removingSegments={ removingSegments }
							/>
						);
					}
					// kind === 'worker'.
					const { step, showArrows } = item;
					return (
						<WorkerConnector
							key={ `worker-${ step.type }-${ idx }` }
							name={ formatWorkerName( step.handlerName ) }
							workers={ step.workers }
							readRates={ byteRates }
							currentTime={ currentTime }
							onRestart={ restart }
							showArrows={ showArrows }
						/>
					);
				} ) }
			</div>
		</div>
	);
}
