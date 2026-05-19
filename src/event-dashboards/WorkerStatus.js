/* global localStorage */
/**
 * Worker Status Component
 *
 * Displays status of all registered log readers with segment visualization.
 * Renders the topology as a linear pipeline: each log appears exactly once,
 * positioned between the producer (worker that writes it via outputs_status)
 * and the consumer (worker that tails it via inputs_status).
 *
 * Logs with no consumer render as terminal outputs after their producer.
 * Logs with no producer render as source inputs before their consumer.
 *
 * Cursor data is sourced from the consumer's inputs_status entry; segment
 * filesystem data prefers the consumer side too (cursor + segments come from
 * the same snapshot), falling back to the producer's outputs_status when no
 * consumer exists for that log.
 */

import {
	useState,
	useEffect,
	useRef,
	useCallback,
	useMemo,
	memo,
} from '@wordpress/element';
import { getCommandClient } from '../shared/utils/commandClient';
import unwrapCommandResponse from '../shared/utils/unwrapCommandResponse';
import usePageVisibility from '../shared/hooks/usePageVisibility';
import './styles/worker-status.scss';

const REFRESH_OPTIONS = [
	{ label: '1s', value: '1000' },
	{ label: '2s', value: '2000' },
	{ label: '5s', value: '5000' },
	{ label: '10s', value: '10000' },
];

/**
 * Format bytes to human readable string.
 *
 * @param {number} bytes Byte count.
 * @return {string} Formatted string.
 */
function formatBytes( bytes ) {
	if ( ! bytes || bytes === 0 ) {
		return '0 B';
	}
	const k = 1024;
	const sizes = [ 'B', 'KB', 'MB', 'GB' ];
	const i = Math.floor( Math.log( bytes ) / Math.log( k ) );
	return (
		parseFloat( ( bytes / Math.pow( k, i ) ).toFixed( 1 ) ) +
		' ' +
		sizes[ i ]
	);
}

/**
 * Format bytes per second to human readable string.
 *
 * @param {number} bytesPerSec Bytes per second.
 * @return {string} Formatted string.
 */
function formatByteRate( bytesPerSec ) {
	if ( ! bytesPerSec || bytesPerSec === 0 ) {
		return '0 B/s';
	}
	const k = 1024;
	const sizes = [ 'B/s', 'KB/s', 'MB/s', 'GB/s' ];
	const i = Math.floor( Math.log( bytesPerSec ) / Math.log( k ) );
	return (
		parseFloat( ( bytesPerSec / Math.pow( k, i ) ).toFixed( 1 ) ) +
		' ' +
		sizes[ i ]
	);
}

/**
 * Format age as human readable duration.
 *
 * @param {number} startedAt Unix timestamp when worker started.
 * @param {number} now       Current Unix timestamp.
 * @return {string} Formatted duration string.
 */
function formatAge( startedAt, now ) {
	if ( ! startedAt ) {
		return '-';
	}
	const seconds = now - startedAt;
	if ( seconds < 60 ) {
		return `${ seconds }s`;
	}
	if ( seconds < 3600 ) {
		const mins = Math.floor( seconds / 60 );
		return `${ mins }m`;
	}
	const hours = Math.floor( seconds / 3600 );
	const mins = Math.floor( ( seconds % 3600 ) / 60 );
	return `${ hours }h${ mins }m`;
}

/**
 * Format ETA as human readable duration.
 *
 * @param {number} bytesBehind Bytes remaining to process.
 * @param {number} readRate    Current read rate in bytes per second.
 * @return {string} Formatted ETA string or empty if not applicable.
 */
function formatEta( bytesBehind, readRate ) {
	if ( ! bytesBehind || bytesBehind <= 0 ) {
		return '';
	}
	if ( ! readRate || readRate <= 0 ) {
		return 'stalled';
	}
	const seconds = Math.ceil( bytesBehind / readRate );
	if ( seconds < 60 ) {
		return `${ seconds }s`;
	}
	if ( seconds < 3600 ) {
		const mins = Math.ceil( seconds / 60 );
		return `${ mins }m`;
	}
	const hours = Math.floor( seconds / 3600 );
	const mins = Math.ceil( ( seconds % 3600 ) / 60 );
	return `${ hours }h${ mins }m`;
}

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
const SegmentBar = memo( function SegmentBar( {
	segment,
	maxSize,
	cursorSeg,
	cursorOffset,
	newestSegId,
	isNew,
	isRemoving,
} ) {
	const fillPercent = maxSize > 0 ? ( segment.size / maxSize ) * 100 : 0;
	// If no cursor (output-only log), treat all segments as processed (green).
	const hasReader = cursorSeg !== undefined && cursorSeg !== null;
	const isCurrent = hasReader && segment.id === cursorSeg;
	const isProcessed = ! hasReader || segment.id < cursorSeg;
	const isNewest = segment.id === newestSegId;

	// For current segment: green up to cursor, then yellow (if newest) or red (if old).
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
			title={ `Segment ${ segment.id }: ${ formatBytes(
				segment.size
			) }` }
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
										No segments
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
							<span className="connector-age" title="Worker age">
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
										title="Heartbeat age"
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
									title="Estimated time to catch up"
								>
									{ formatEta( w.behind, readRates[ key ] ) }
								</span>
							) }
							{ w.restart_pending && (
								<span
									className="connector-restart-pending"
									title="Restart pending"
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
							ALL RUN
						</span>
					) }
					{ allDead && (
						<span className="worker-status-badge dead small">
							ALL DEAD
						</span>
					) }
					{ onRestart && ! allDead && ! anyPendingRestart && (
						<button
							type="button"
							className="worker-restart-btn"
							onClick={ () => onRestart( workerType ) }
							title="Request graceful restart"
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
				<span className="supervisor-title">Supervisor</span>
			</div>
			<div className="supervisor-list">
				<div className={ `supervisor-row ${ isDead ? 'dead' : '' }` }>
					<span className="supervisor-name">Supervisor</span>
					<div className="supervisor-instance">
						<span
							className={ `worker-status-badge compact ${ supervisor.status }` }
						>
							{ supervisor.status === 'running' ? 'RUN' : 'DEAD' }
						</span>
						<span className="supervisor-age" title="Uptime">
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
									title="Heartbeat age"
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
									title="Request graceful restart"
								>
									↻
								</button>
							) }
						{ supervisor.restart_pending && (
							<span className="worker-restart-pending-label">
								restarting...
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
 * Each pipeline log appears exactly once. A log shared by a producer and a
 * consumer renders BETWEEN them (so the producer's worker connector sits above
 * the log, and the consumer's connector sits below). Terminal outputs (no
 * consumer) render after their producer; source inputs (no producer) render
 * before their consumer.
 *
 * The returned array is a flat sequence of items consumed by the renderer:
 *  - `{ kind: 'log', ... }` — a LogSection to draw.
 *  - `{ kind: 'worker', ... }` — a WorkerConnector to draw.
 *
 * @param {Array} workers     Worker descriptors from the REST endpoint.
 * @param {Array} logsCatalog Top-level `logs` array — canonical per-log
 *                            per-partition slot list (every `*.log/` on disk
 *                            padded to `max(num_partitions, max-on-disk+1)`).
 *                            Consumer cursor data is overlaid from `workers`.
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

	// Group workers by (type, handler, source). One step per (Consumer,
	// target) pair — a single handler can be fed by multiple Consumers
	// (e.g. JobRouter receives from firehose:consumer via Tee fan-out AND
	// from jobintake:consumer directly), and each Consumer has its own
	// cursor / lag / read-rate. Collapsing across sources renders both
	// as duplicate-looking pills under one header. Multiple partitions of
	// the same (type, handler, source) still roll up into the same step.
	const stepsByKey = new Map();
	workers.forEach( ( w ) => {
		const handler = w.handler || w.type;
		const source = w.source || '';
		const key = `${ w.type }|${ handler }|${ source }`;
		if ( ! stepsByKey.has( key ) ) {
			stepsByKey.set( key, {
				// Keep `type` as the worker_type so styling/category code that
				// keys on it still works; `key` is what identifies this step
				// uniquely.
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

	// Build producer/consumer maps: log name → step type(s).
	const producers = new Map(); // name → step.type that writes this log.
	const consumers = new Map(); // name → step.type that reads this log.
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

	// Topological sort: a step that reads log X must come after any step that
	// writes log X. Stable order on tie (preserves API order for visual
	// consistency). Indexed by step.key so two Consumers under the same
	// worker_type don't collide.
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
	steps.forEach( visit );

	// For each log, pick the canonical "info source" (the worker that has the
	// richest data). Consumers carry cursor + segments + cursor partition data;
	// producers only carry segments. Prefer consumer-side data when available.
	//
	// Store the location plan: where in the rendered sequence each log appears.
	//  - If producer + consumer exist: render BEFORE the consumer step.
	//  - If only consumer: render BEFORE the consumer step (source).
	//  - If only producer: render AFTER the producer step (terminal).
	const beforeStep = new Map(); // step.key → log[] to render above it.
	const afterStep = new Map(); // step.key → log[] to render below it.
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

	// Build a map of log name → canonical slot list from logsCatalog. The
	// backend's enumerate_logs() pads to max(num_partitions, max-on-disk+1)
	// per log, so this is the single source of truth for how many partition
	// rows to render under each log header. Cursor data is overlaid from
	// the matching worker per partition where available.
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

		// Cursor data, keyed by partition, from any worker that reads this log.
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

		// No canonical entry — the log directory hasn't been created yet
		// (fresh deploy, no writes), or it lives outside `logs/`. Fall back
		// to whatever the workers tell us so the dashboard still renders.
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

	// Append any logs from the catalog that the step-walking pass didn't
	// reach. Dashboard `steps` are keyed off Consumer offsetlog rows, so a
	// log that's written by a producer but never tailed by a Consumer (e.g.
	// errors.log, flames.log, or jobs.log when no job-workers Consumer is
	// active) won't appear under any step above and drops through to here.
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
	const [ workers, setWorkers ] = useState( [] );
	const [ supervisor, setSupervisor ] = useState( null );
	const [ logsCatalog, setLogsCatalog ] = useState( [] ); // Top-level `logs` array — full per-log slot list.
	const [ loading, setLoading ] = useState( true );
	const [ error, setError ] = useState( null );
	const [ refreshInterval, setRefreshInterval ] = useState( () => {
		// Load from localStorage with validation against allowed dropdown values.
		const validValues = REFRESH_OPTIONS.map( ( opt ) => opt.value );
		const saved = localStorage.getItem(
			'newspack-event-logger-nodes-worker-refresh'
		);
		if ( saved && validValues.includes( saved ) ) {
			return saved;
		}
		return String( refreshMs );
	} );
	const [ byteRates, setByteRates ] = useState( {} ); // Read rates by worker key.
	const [ writeRates, setWriteRates ] = useState( {} ); // Write rates by log key (logName-partition).
	const [ segmentSize, setSegmentSize ] = useState( 64 * 1024 * 1024 ); // Default 64MB.
	const [ currentTime, setCurrentTime ] = useState( () =>
		Math.floor( Date.now() / 1000 )
	);
	const prevSegmentsRef = useRef( {} ); // Previous segment IDs by log key.
	const prevSegmentDataRef = useRef( {} ); // Previous segment data by log key.
	const prevPositionsRef = useRef( {} ); // Read positions by worker key.
	const prevTotalSizesRef = useRef( {} ); // Total sizes by log key for write rates.
	const lastFetchTimeRef = useRef( null );
	const animationTimersRef = useRef( [] );
	const [ removingSegments, setRemovingSegments ] = useState( {} ); // Segments animating out.
	const isPageVisible = usePageVisibility();

	/**
	 * Request restart for workers of a given type.
	 *
	 * Dispatches `workers.restart` through `/command`. Arg shape differs from
	 * the legacy REST endpoint: the verb takes `{types: string[], partition:
	 * int}` (plural types, integer partition where -1 means "all"), whereas
	 * the legacy route took `{type: string, all_partitions: bool, nonce}`. The
	 * `/command` route is `manage_options`-guarded and CommandClient supplies
	 * the WP nonce in its `X-WP-Nonce` header, so we no longer thread a
	 * per-action nonce through the body.
	 *
	 * @param {string} workerType Worker group name (e.g., 'firehose-workers').
	 */
	const handleRestart = useCallback( async ( workerType ) => {
		try {
			const message = await getCommandClient().send( {
				to: 'workers',
				verb: 'restart',
				payload: {
					types: [ workerType ],
					partition: -1,
				},
			} );
			unwrapCommandResponse( message );
		} catch ( err ) {
			setError( `Failed to request restart: ${ err.message }` );
		}
	}, [] );

	// Save refresh interval to localStorage.
	useEffect( () => {
		localStorage.setItem(
			'newspack-event-logger-nodes-worker-refresh',
			refreshInterval
		);
	}, [ refreshInterval ] );

	const fetchWorkers = useCallback( async () => {
		try {
			const now = Date.now();
			// workers.dump_metadata returns the full 7-field operator-grade
			// envelope (workers[], supervisor, logs[], num_partitions,
			// num_segments, segment_size, timestamp) — same shape the legacy
			// WorkersController::get_workers() route produced. The minimal
			// workers.list projection is for CLI / topology callers; the
			// dashboard needs the rich per-worker descriptors that
			// dump_metadata supplies.
			const message = await getCommandClient().send( {
				to: 'workers',
				verb: 'dump_metadata',
			} );
			const data = unwrapCommandResponse( message ) || {};

			// Track segment changes for animation.
			const newPrevSegments = {};
			const newPrevSegmentData = {};
			const newPositions = {};
			const newByteRates = {};
			const newWriteRates = {};
			const newTotalSizes = {};
			const newRemoving = {};

			// Calculate time delta for rate calculation.
			const timeDelta = lastFetchTimeRef.current
				? ( now - lastFetchTimeRef.current ) / 1000
				: 0;

			// Per-worker read rates (cursor advancement against primary input).
			// Key by (handler, partition, source) — a single handler can be
			// fed by multiple Consumers (e.g. JobRouter from firehose:consumer
			// AND jobintake:consumer), each with its own cursor. Keying only
			// by handler+partition collapses both rows into one slot and the
			// rate becomes whichever cursor was processed last.
			( data.workers || [] ).forEach( ( worker ) => {
				const workerKey = `${ worker.handler || worker.type }-${
					worker.partition
				}-${ worker.source || '' }`;

				// Sum processed bytes across every input — workers can tail
				// multiple logs (firehose-workers reads firehose + jobintake).
				let totalProcessed = 0;
				( worker.inputs_status || [] ).forEach( ( input ) => {
					if (
						input.cursor_seg === undefined ||
						input.cursor_offset === undefined
					) {
						return;
					}
					( input.segments || [] ).forEach( ( seg ) => {
						if ( seg.id < input.cursor_seg ) {
							totalProcessed += seg.size;
						} else if ( seg.id === input.cursor_seg ) {
							totalProcessed += input.cursor_offset;
						}
					} );
				} );
				newPositions[ workerKey ] = totalProcessed;

				if (
					timeDelta > 0 &&
					prevPositionsRef.current[ workerKey ] !== undefined
				) {
					const bytesDelta =
						totalProcessed - prevPositionsRef.current[ workerKey ];
					newByteRates[ workerKey ] =
						bytesDelta >= 0 ? bytesDelta / timeDelta : 0;
				}
			} );

			// Per-log write rates and segment-change tracking. Each log appears
			// in possibly multiple workers' inputs_status / outputs_status, so
			// we collect by (logName, partition) — same physical filesystem
			// state regardless of which worker reported it. Take the max
			// total_size and the union of segments seen, so a stale snapshot
			// from one worker can't shrink the visualization.
			const logSnapshots = new Map(); // logKey → { total_size, segments[] }.
			const recordLog = ( log, partition ) => {
				if ( ! log || ! log.name ) {
					return;
				}
				const logKey = `${ log.name.replace(
					/\.log$/,
					''
				) }-${ partition }`;
				const prior = logSnapshots.get( logKey ) || {
					total_size: 0,
					segments: new Map(),
				};
				prior.total_size = Math.max(
					prior.total_size,
					log.total_size || 0
				);
				( log.segments || [] ).forEach( ( seg ) => {
					prior.segments.set( seg.id, seg );
				} );
				logSnapshots.set( logKey, prior );
			};
			( data.workers || [] ).forEach( ( w ) => {
				( w.inputs_status || [] ).forEach( ( log ) =>
					recordLog( log, w.partition )
				);
				( w.outputs_status || [] ).forEach( ( log ) =>
					recordLog( log, w.partition )
				);
			} );

			logSnapshots.forEach( ( snap, logKey ) => {
				newTotalSizes[ logKey ] = snap.total_size;
				if (
					timeDelta > 0 &&
					prevTotalSizesRef.current[ logKey ] !== undefined
				) {
					const sizeDelta =
						snap.total_size - prevTotalSizesRef.current[ logKey ];
					newWriteRates[ logKey ] =
						sizeDelta >= 0 ? sizeDelta / timeDelta : 0;
				}
				const currentIds = new Set( snap.segments.keys() );
				newPrevSegments[ logKey ] = currentIds;
				newPrevSegmentData[ logKey ] = snap.segments;

				const prevIds = prevSegmentsRef.current[ logKey ];
				const prevData = prevSegmentDataRef.current[ logKey ];
				if ( prevIds && prevData ) {
					const removed = [];
					for ( const id of prevIds ) {
						if ( ! currentIds.has( id ) ) {
							const segData = prevData.get( id );
							if ( segData ) {
								removed.push( segData );
							}
						}
					}
					if ( removed.length > 0 ) {
						newRemoving[ logKey ] = removed;
					}
				}
			} );

			// Skip the state update (and the cascading buildRenderPlan
			// re-run) when the new payload is structurally identical to
			// what we already have — common in steady state, where the
			// 2s refresh just re-reads the same set of workers + logs.
			// JSON.stringify on ~5KB of REST data is sub-ms; cheaper
			// than the render plan rebuild it gates.
			const replaceIfChanged = ( prev, next ) =>
				JSON.stringify( prev ) === JSON.stringify( next ) ? prev : next;
			setWorkers( ( prev ) =>
				replaceIfChanged( prev, data.workers || [] )
			);
			setSupervisor( ( prev ) =>
				replaceIfChanged( prev, data.supervisor ?? null )
			);
			setLogsCatalog( ( prev ) =>
				replaceIfChanged( prev, data.logs || [] )
			);
			setByteRates( newByteRates );
			setWriteRates( newWriteRates );
			if ( data.segment_size ) {
				setSegmentSize( data.segment_size );
			}
			if ( data.timestamp ) {
				setCurrentTime( data.timestamp );
			}
			setError( null );

			// Update refs.
			lastFetchTimeRef.current = now;
			prevPositionsRef.current = newPositions;
			prevTotalSizesRef.current = newTotalSizes;

			// Clear previous animation timers.
			animationTimersRef.current.forEach( clearTimeout );
			animationTimersRef.current = [];

			// Set removing segments for animation.
			if ( Object.keys( newRemoving ).length > 0 ) {
				setRemovingSegments( newRemoving );
				animationTimersRef.current.push(
					setTimeout( () => {
						setRemovingSegments( {} );
					}, 400 )
				);
			}

			// Clear "new" status after animation completes.
			animationTimersRef.current.push(
				setTimeout( () => {
					prevSegmentsRef.current = newPrevSegments;
					prevSegmentDataRef.current = newPrevSegmentData;
				}, 500 )
			);
		} catch ( err ) {
			setError( 'Server disconnected. Reconnecting...' );
		} finally {
			setLoading( false );
		}
	}, [] );

	// Fetch on mount.
	useEffect( () => {
		fetchWorkers();
	}, [ fetchWorkers ] );

	// Auto-refresh only when page is visible.
	useEffect( () => {
		if ( ! isPageVisible ) {
			return;
		}
		const intervalMs = parseInt( refreshInterval, 10 );
		const interval = setInterval( fetchWorkers, intervalMs );
		return () => {
			clearInterval( interval );
			animationTimersRef.current.forEach( clearTimeout );
			animationTimersRef.current = [];
		};
	}, [ fetchWorkers, refreshInterval, isPageVisible ] );

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
				Loading worker status...
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
			{ ! fullPage && <h3>Worker Status</h3> }
			{ fullPage && (
				<div className="worker-status-header">
					<h2>Worker Status</h2>
					{ error && (
						<div className="worker-status-error-inline">
							{ error }
						</div>
					) }
					<div className="worker-status-total-rate">
						<span className="total-rate-write">
							<span className="total-rate-label">W</span>
							<span className="total-rate-value">
								{ formatByteRate( totalWriteRate ) }
							</span>
						</span>
						<span className="total-rate-read">
							<span className="total-rate-label">R</span>
							<span className="total-rate-value">
								{ formatByteRate( totalReadRate ) }
							</span>
						</span>
					</div>
					<div className="worker-status-controls">
						<select
							className="event-logger-refresh-select"
							value={ refreshInterval }
							onChange={ ( e ) =>
								setRefreshInterval( e.target.value )
							}
							title="Refresh interval"
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
					onRestart={ handleRestart }
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
								prevSegments={ prevSegmentsRef.current }
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
							onRestart={ handleRestart }
							showArrows={ showArrows }
						/>
					);
				} ) }
			</div>
		</div>
	);
}
