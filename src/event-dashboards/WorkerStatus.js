/**
 * Worker Status Component — one foldable node/log tree section per topology.
 *
 * THIN view over the `workerstatus:*` node graph (mounted by
 * `useWorkerStatusGraph`). The graph owns all data: `workerstatus:poll` runs the
 * dump_graph poll, `workerstatus:transform` computes the read/write rates and
 * segment add/remove tracking, and `workerstatus:view` holds the render model.
 * This component only reads that model (via `useNodeState`) and renders — the
 * supervisor card plus a `TopologySection` per topology (built by
 * `buildTopologySections`), whose fold state is owned here.
 */

import { memo, useMemo, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { useNodeState } from '../runtime/react';
import ConnectionBanner from '@newspack-nodes/shared/components/ConnectionBanner';
import TopologySection from './TopologySection';
import { buildTopologySections } from './topologyGraph';
import { formatBytes, formatByteRate, formatAge } from './formatters';
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
	graph: {},
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
		graph,
		byteRates,
		writeRates,
		segmentSize,
		currentTime,
		prevSegments,
		removingSegments,
		error,
		loading,
	} = model;

	// One node/log tree section per topology: structure from the `.tsl` graph,
	// status overlay from the worker rows + logs catalog.
	const sections = useMemo(
		() => buildTopologySections( graph, workers, logsCatalog ),
		[ graph, workers, logsCatalog ]
	);
	const [ collapsed, setCollapsed ] = useState( () => new Set() );
	const onToggle = ( key ) =>
		setCollapsed( ( prev ) => {
			const next = new Set( prev );
			if ( next.has( key ) ) {
				next.delete( key );
			} else {
				next.add( key );
			}
			return next;
		} );

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

			<div className="topology-sections">
				{ sections.map( ( section ) => (
					<TopologySection
						key={ section.topology }
						section={ section }
						workers={ section.workers }
						byteRates={ byteRates }
						writeRates={ writeRates }
						segmentSize={ segmentSize }
						currentTime={ currentTime }
						prevSegments={ prevSegments }
						removingSegments={ removingSegments }
						collapsed={ collapsed }
						onToggle={ onToggle }
						onRestart={ restart }
					/>
				) ) }
			</div>
		</div>
	);
}
