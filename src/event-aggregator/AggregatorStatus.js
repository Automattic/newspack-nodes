/**
 * Aggregator Status Component
 *
 * THIN view over the DE-GOD `aggregator:*` node graph (mounted by
 * useAggregatorStatusGraph). The single god `status` poll feeding one
 * `aggregator:view` is gone; the graph now owns TWO independent per-concern
 * slices, each on its own slice verb with its own inspectable reply path:
 *
 *   summary:view → the header strip (connected/total counts + snapshot clock)
 *   servers:view → the server cards (per-server partition grids)
 *
 * This component reads each slice via its own useNodeState and renders — the pure
 * presentation helpers below (formatTime / formatRtt / getRttClass /
 * PartitionStatus / ServerCard) are unchanged. The 1s "ago" tick stays here: it's
 * pure display, re-rendering the relative timestamps without re-polling.
 */

import { useState, useEffect, createPortal } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';

import { useNodeState } from '@newspack-nodes/runtime';
import {
	useAggregatorStatusGraph,
	REFRESH_OPTIONS,
} from './hooks/useAggregatorStatusGraph';
import ConnectionBanner from '@newspack-nodes/shared/components/ConnectionBanner';
import './styles/aggregator-status.scss';

// The slice models before each slice's first poll publishes — drive the loading
// gates. summary owns the header counts + clock; servers owns the card data.
const EMPTY_SUMMARY = {
	connected: 0,
	total: 0,
	serverNow: null,
	error: null,
	loading: true,
	lastRefresh: null,
};
const EMPTY_SERVERS = {
	servers: null,
	error: null,
	loading: true,
};

/**
 * Format a Unix timestamp as relative time or absolute.
 *
 * @param {number} timestamp Unix timestamp in seconds.
 * @param {number} now       Reference clock (the server's snapshot time); falls
 *                           back to the browser clock when omitted.
 * @return {string} Formatted time string.
 */
const formatTime = ( timestamp, now ) => {
	if ( ! timestamp ) {
		return '-';
	}

	// `now` is the server's clock at the moment it built this status snapshot
	// (the response Message's TIMESTAMP). Computing "ago" against it — not the
	// browser clock — means the value reflects what the aggregator itself saw
	// and stays fixed between dashboard refreshes (no client-side drift). Falls
	// back to the browser clock only for callers without a server time (header).
	const ref = now ?? Date.now() / 1000;
	const diff = ref - timestamp;

	if ( diff < 60 ) {
		return sprintf(
			// translators: %d: number of seconds since the last update.
			__( '%ds ago', 'newspack-nodes' ),
			Math.round( diff )
		);
	}
	if ( diff < 3600 ) {
		return sprintf(
			// translators: %d: number of minutes since the last update.
			__( '%dm ago', 'newspack-nodes' ),
			Math.round( diff / 60 )
		);
	}

	const date = new Date( timestamp * 1000 );
	return date.toLocaleTimeString();
};

/**
 * Format RTT value with appropriate precision.
 *
 * @param {number} rtt Round-trip time in milliseconds.
 * @return {string} Formatted RTT.
 */
const formatRtt = ( rtt ) => {
	if ( rtt === null || rtt === undefined ) {
		return null;
	}
	if ( rtt < 1 ) {
		return rtt.toFixed( 2 );
	}
	if ( rtt < 100 ) {
		return rtt.toFixed( 1 );
	}
	return Math.round( rtt ).toString();
};

/**
 * Get RTT color class based on value.
 *
 * @param {number} rtt Round-trip time in milliseconds.
 * @return {string} CSS class name.
 */
const getRttClass = ( rtt ) => {
	if ( rtt === null || rtt === undefined ) {
		return 'muted';
	}
	if ( rtt > 500 ) {
		return 'error';
	}
	if ( rtt > 200 ) {
		return 'warning';
	}
	return 'success';
};

/**
 * Partition Status Component.
 *
 * @param {Object} props           Component props.
 * @param {number} props.partition Partition number.
 * @param {Object} props.status    Partition status data.
 * @param {number} props.now       Server snapshot clock for relative-time calc.
 * @return {import('react').ReactElement} Rendered component.
 */
function PartitionStatus( { partition, status, now } ) {
	const connected = !! status.connected;
	const connectionStatus = connected ? 'connected' : 'disconnected';
	// Gate on `connected`: last_heartbeat_response is a sticky timestamp (never
	// cleared once set), so a dead spoke would otherwise latch 'success' forever.
	// Disconnected → pending, clearing the sticky heartbeat state on disconnect.
	const heartbeatStatus =
		connected && status.last_heartbeat_response ? 'success' : 'pending';
	// Rolled-up health drives the card's left status rail: green when the
	// connection is live AND heartbeating, amber when connected but not yet
	// heartbeating (degraded), red when down.
	let health = 'down';
	if ( connected ) {
		health = heartbeatStatus === 'success' ? 'ok' : 'degraded';
	}
	const errorMessage = status.last_error;
	const rtt = status.last_heartbeat_rtt;
	const rttFormatted = formatRtt( rtt );

	return (
		<div className={ `aggregator-partition is-${ health }` }>
			<div className="aggregator-partition-header">
				<span className="aggregator-partition-label">
					p{ partition }
				</span>
				<span
					className={ `aggregator-status-badge small ${ connectionStatus }` }
				>
					{ connectionStatus.replace( /_/g, ' ' ) }
				</span>
			</div>
			<div className="aggregator-partition-stats">
				<div className="aggregator-partition-row">
					<span className="aggregator-partition-stat-label">
						{ connected
							? __( 'Connected', 'newspack-nodes' )
							: __( 'Attempt', 'newspack-nodes' ) }
					</span>
					<span className="aggregator-partition-stat-value">
						{ formatTime( status.last_connection_attempt, now ) }
					</span>
				</div>
				<div className="aggregator-partition-row">
					<span className="aggregator-partition-stat-label">
						{ __( 'Server HB', 'newspack-nodes' ) }
					</span>
					<span className="aggregator-partition-stat-value">
						{ formatTime( status.last_sse_heartbeat, now ) }
					</span>
				</div>
				<div className="aggregator-partition-row">
					<span className="aggregator-partition-stat-label">
						{ __( 'Client HB', 'newspack-nodes' ) }
					</span>
					<span className="aggregator-partition-stat-value">
						{ rttFormatted && (
							<span
								className={ `aggregator-heartbeat-rtt small ${ getRttClass(
									rtt
								) }` }
							>
								{ rttFormatted }ms
							</span>
						) }
						{ formatTime( status.last_heartbeat_response, now ) }
					</span>
				</div>
				<div className="aggregator-partition-row">
					<span className="aggregator-partition-stat-label">
						{ __( 'Status', 'newspack-nodes' ) }
					</span>
					<span className="aggregator-partition-stat-value">
						<span
							className={ `aggregator-heartbeat-badge small ${ heartbeatStatus }` }
						>
							{ heartbeatStatus.replace( /_/g, ' ' ) }
						</span>
						{ /* HTTP code rides the Status line as a muted caption —
						     informative on errors, unobtrusive on a 200. */ }
						{ status.last_http_code && (
							<span className="aggregator-http-code">
								HTTP { status.last_http_code }
							</span>
						) }
					</span>
				</div>
			</div>
			{ /* A dedicated error line, only when there's a real message. */ }
			{ errorMessage && (
				<div
					className="aggregator-partition-error"
					title={ errorMessage }
				>
					{ errorMessage }
				</div>
			) }
		</div>
	);
}

/**
 * Server Card Component.
 *
 * @param {Object} props        Component props.
 * @param {Object} props.server Server status data.
 * @param {number} props.now    Server snapshot clock for relative-time calc.
 * @return {import('react').ReactElement} Rendered component.
 */
function ServerCard( { server, now } ) {
	const partitions = server.partitions || {};
	const partitionKeys = Object.keys( partitions ).sort(
		( a, b ) => Number( a ) - Number( b )
	);

	// Count connected partitions.
	const connectedPartitions = partitionKeys.filter(
		( p ) => partitions[ p ]?.connected === true
	).length;

	return (
		<div className="aggregator-server-card">
			{ /* Server Identity */ }
			<div className="aggregator-server-identity">
				<div className="aggregator-server-id">{ server.id }</div>
				<div className="aggregator-server-url" title={ server.url }>
					{ server.url }
				</div>
				<div className="aggregator-server-partition-count">
					{ sprintf(
						// translators: 1: number of connected partitions, 2: total number of partitions.
						__( '%1$d/%2$d partitions', 'newspack-nodes' ),
						connectedPartitions,
						partitionKeys.length
					) }
				</div>
			</div>

			{ /* Partition Status Grid */ }
			<div className="aggregator-partitions">
				{ partitionKeys.map( ( p ) => (
					<PartitionStatus
						key={ p }
						partition={ Number( p ) }
						status={ partitions[ p ] || {} }
						now={ now }
					/>
				) ) }
			</div>
		</div>
	);
}

/**
 * Aggregator Status Dashboard Component.
 *
 * @param {Object}  props                      Props.
 * @param {Element} [props.headerControlsSlot] Hub shared-header slot to portal the controls into.
 * @return {import('react').ReactElement} Rendered component.
 */
export default function AggregatorStatus( { headerControlsSlot } ) {
	// Mount the node graph; it owns the two per-concern poll slices + the interval.
	// It returns the thin refresh control + the current interval.
	const { setRefreshInterval, refreshInterval } = useAggregatorStatusGraph();

	// Two independent read surfaces — one per slice the graph publishes.
	const summary = useNodeState( 'summary:view', 'view' ) ?? EMPTY_SUMMARY;
	const serversSlice =
		useNodeState( 'servers:view', 'view' ) ?? EMPTY_SERVERS;
	// Header strip reads the summary slice (counts + clock + refresh marker).
	const { connected, total, serverNow, lastRefresh } = summary;
	// Server cards read the servers slice (data + its own loading/error gate).
	const { servers, error, loading } = serversSlice;

	const [ , setTick ] = useState( 0 );

	// Tick every second to update relative timestamps (pure display — no poll).
	useEffect( () => {
		const timer = setInterval( () => setTick( ( t ) => t + 1 ), 1000 );
		return () => clearInterval( timer );
	}, [] );

	// The status/refresh strip (Updated… / X/Y connected / interval) lives on the
	// right of the hub's ONE shared header — portaled into its slot. A node = the
	// hub slot (portal); `null` = slot pending (render nothing); `undefined` =
	// standalone (tests) → render inline.
	const controls = (
		<div className="aggregator-status-meta">
			<div className="aggregator-status-refresh-indicator">
				<span className="aggregator-status-refresh-dot" />
				<span>
					{ lastRefresh
						? sprintf(
								// translators: %s: formatted time of the last update.
								__( 'Updated %s', 'newspack-nodes' ),
								formatTime( lastRefresh / 1000 )
						  )
						: __( 'Loading…', 'newspack-nodes' ) }
				</span>
			</div>
			{ servers && (
				<div className="aggregator-status-server-count">
					<strong>{ connected }</strong> / { total }{ ' ' }
					{ __( 'connected', 'newspack-nodes' ) }
				</div>
			) }
			<select
				className="newspack-nodes-select"
				value={ refreshInterval }
				onChange={ ( e ) => setRefreshInterval( e.target.value ) }
				title={ __( 'Refresh interval', 'newspack-nodes' ) }
			>
				{ REFRESH_OPTIONS.map( ( opt ) => (
					<option key={ opt.value } value={ opt.value }>
						{ opt.label }
					</option>
				) ) }
			</select>
		</div>
	);
	let renderedControls = null;
	if ( headerControlsSlot ) {
		renderedControls = createPortal( controls, headerControlsSlot );
	} else if ( undefined === headerControlsSlot ) {
		renderedControls = controls;
	}

	return (
		<div className="aggregator-status-dashboard">
			{ renderedControls }

			{ /* Loading State */ }
			{ loading && (
				<div className="aggregator-status-loading">
					<div className="spinner" />
					<span>
						{ __( 'Loading server status…', 'newspack-nodes' ) }
					</span>
				</div>
			) }

			{ /* Error State */ }
			{ ! loading && (
				<ConnectionBanner
					connectionError={ !! error }
					message={ error }
				/>
			) }

			{ /* Server List */ }
			{ ! loading && ! error && (
				<div className="aggregator-status-servers">
					{ servers && servers.length > 0 ? (
						servers.map( ( server ) => (
							<ServerCard
								key={ server.id }
								server={ server }
								now={ serverNow }
							/>
						) )
					) : (
						<div className="aggregator-status-empty">
							{ __(
								'No servers configured. Add servers in Event Logger settings.',
								'newspack-nodes'
							) }
						</div>
					) }
				</div>
			) }
		</div>
	);
}
