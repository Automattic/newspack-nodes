/**
 * Aggregator Status Component
 *
 * THIN view over the DE-GOD `aggregator:*` node graph (mounted by
 * useAggregatorStatusGraph). The single god `status` poll feeding one
 * `aggregator:view` is gone; the graph now owns TWO independent per-concern
 * slices, each on its own slice verb with its own inspectable reply path:
 *
 *   summary:view → the header strip (connected/idle/total counts + clock)
 *   servers:view → the server cards (per-server partition grids)
 *
 * This component reads each slice via its own useNodeState and renders — the pure
 * presentation helpers below (formatTime / formatRtt / getRttClass /
 * PartitionStatus / ServerCard) are unchanged. The 1s "ago" tick stays here: it's
 * pure display, re-rendering the relative timestamps without re-polling.
 */

import { useState, useCallback } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';

import { useNodeState } from '@newspack-nodes/runtime';
import {
	useAggregatorStatusGraph,
	REFRESH_OPTIONS,
} from './hooks/useAggregatorStatusGraph';
import ConnectionBanner from '@newspack-nodes/shared/components/ConnectionBanner';
import useRouterTick from '@newspack-nodes/shared/hooks/useRouterTick';
import { formatLocalDateTime } from '@newspack-nodes/shared/utils/formatUtils';
import './styles/aggregator-status.scss';
import { HeaderSlot } from '@newspack-nodes/shared/components/HeaderSlot';

// Slice-model defaults before first poll — drive the loading gates.
const EMPTY_SUMMARY = {
	connected: 0,
	idle: 0,
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
 * @param {number}  timestamp Unix timestamp in seconds.
 * @param {?number} [now]     Reference clock (the server's snapshot time); falls
 *                            back to the browser clock when omitted or null,
 *                            which is the pre-first-poll state.
 * @return {string} Formatted time string.
 */
const formatTime = ( timestamp, now ) => {
	if ( ! timestamp ) {
		return '-';
	}

	// "ago" vs the server snapshot clock, not browser — no client drift.
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

	// Older than an hour: a bare clock time could be any day.
	return formatLocalDateTime( timestamp );
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
 * One partition's three-state connection reading. A stream the server closed at
 * EOF is IDLE — healthy, and due back at `scheduled_reconnect_at` — so it must
 * never be styled or counted as the failure a bare `! connected` would make it.
 *
 * @param {Object} status Partition status data.
 * @return {string} One of connected|idle|disconnected.
 */
const partitionState = ( status ) => {
	if ( status?.connected ) {
		return 'connected';
	}
	return status?.scheduled_reconnect_at ? 'idle' : 'disconnected';
};

/**
 * How long until a stream closed at EOF comes back — the useful fact about an
 * idle spoke, where a last-attempt timestamp says nothing.
 *
 * @param {number}  timestamp Unix second the reopen is due.
 * @param {?number} [now]     Server snapshot clock; browser clock when omitted.
 * @return {string} e.g. "in 9s".
 */
const formatCountdown = ( timestamp, now ) => {
	const ref = now ?? Date.now() / 1000;
	return sprintf(
		// translators: %d: seconds until the stream reopens.
		__( 'in %ds', 'newspack-nodes' ),
		Math.max( 0, Math.round( timestamp - ref ) )
	);
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
	const connectionStatus = partitionState( status );
	const connected = 'connected' === connectionStatus;
	const idle = 'idle' === connectionStatus;
	// Gate on connected: heartbeat ts is sticky, else dead spoke latches OK.
	const heartbeatStatus =
		connected && status.last_heartbeat_response ? 'success' : 'pending';
	// Health rails the card's left edge: ok / idle / degraded / down.
	let health = idle ? 'idle' : 'down';
	if ( connected ) {
		health = heartbeatStatus === 'success' ? 'ok' : 'degraded';
	}
	const errorMessage = status.last_error;
	const rtt = status.last_heartbeat_rtt;
	const rttFormatted = formatRtt( rtt );

	return (
		<div
			className={ `newspack-nodes-card newspack-nodes-card--hoverable aggregator-partition is-${ health }` }
		>
			<div className="aggregator-partition-header">
				<span className="aggregator-partition-label">
					p{ partition }
				</span>
				<span
					className={ `newspack-nodes-status-badge aggregator-status-badge small ${ connectionStatus }` }
				>
					{ connectionStatus.replace( /_/g, ' ' ) }
				</span>
			</div>
			<div className="aggregator-partition-stats">
				<div className="aggregator-partition-row">
					<span className="newspack-nodes-stat-label aggregator-partition-stat-label">
						{ idle && __( 'Reconnects', 'newspack-nodes' ) }
						{ connected && __( 'Connected', 'newspack-nodes' ) }
						{ ! idle &&
							! connected &&
							__( 'Attempt', 'newspack-nodes' ) }
					</span>
					<span className="newspack-nodes-stat-value aggregator-partition-stat-value">
						{ idle
							? formatCountdown(
									status.scheduled_reconnect_at,
									now
							  )
							: formatTime(
									status.last_connection_attempt,
									now
							  ) }
					</span>
				</div>
				<div className="aggregator-partition-row">
					<span className="newspack-nodes-stat-label aggregator-partition-stat-label">
						{ __( 'Server HB', 'newspack-nodes' ) }
					</span>
					<span className="newspack-nodes-stat-value aggregator-partition-stat-value">
						{ formatTime( status.last_sse_heartbeat, now ) }
					</span>
				</div>
				<div className="aggregator-partition-row">
					<span className="newspack-nodes-stat-label aggregator-partition-stat-label">
						{ __( 'Client HB', 'newspack-nodes' ) }
					</span>
					<span className="newspack-nodes-stat-value aggregator-partition-stat-value">
						{ rttFormatted && (
							<span
								className={ `newspack-nodes-status aggregator-heartbeat-rtt small ${ getRttClass(
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
					<span className="newspack-nodes-stat-label aggregator-partition-stat-label">
						{ __( 'Status', 'newspack-nodes' ) }
					</span>
					<span className="newspack-nodes-stat-value aggregator-partition-stat-value">
						<span
							className={ `newspack-nodes-status-badge aggregator-heartbeat-badge small ${ heartbeatStatus }` }
						>
							{ heartbeatStatus.replace( /_/g, ' ' ) }
						</span>
						{ /* HTTP code as a muted caption on Status line. */ }
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
 * Fleet roll-up panel: the on-demand deep-probe result for one spoke — worker
 * live/stale/dead counts, worst consumer distance, dead-letter total. Shown only
 * after a Probe click; an error probe surfaces the error line instead.
 *
 * @param {Object} props        Component props.
 * @param {Object} props.answer The probe's answer: `{ busy, result, error }`.
 * @return {import('react').ReactElement} Rendered component.
 */
function FleetRollup( { answer } ) {
	if ( answer.busy ) {
		return (
			<div className="aggregator-fleet-rollup">
				{ __( 'Probing…', 'newspack-nodes' ) }
			</div>
		);
	}
	if ( answer.error ) {
		return (
			<div
				className="aggregator-fleet-rollup is-error"
				title={ answer.error }
			>
				{ answer.error }
			</div>
		);
	}
	const {
		workers = {},
		worst_distance: worstDistance = 0,
		deadletter_segments: dlq = 0,
	} = answer.result || {};
	return (
		<div className="aggregator-fleet-rollup">
			<span className="aggregator-fleet-stat">
				{ sprintf(
					// translators: 1: live workers, 2: stale workers, 3: dead workers.
					__(
						'Workers %1$d live / %2$d stale / %3$d dead',
						'newspack-nodes'
					),
					workers.live || 0,
					workers.stale || 0,
					workers.dead || 0
				) }
			</span>
			<span className="aggregator-fleet-stat">
				{ sprintf(
					// translators: %d: worst consumer lag in bytes.
					__( 'Worst lag %d B', 'newspack-nodes' ),
					worstDistance
				) }
			</span>
			<span className="aggregator-fleet-stat">
				{ sprintf(
					// translators: %d: number of quarantined dead-letter segments.
					__( 'DLQ %d', 'newspack-nodes' ),
					dlq
				) }
			</span>
		</div>
	);
}

/**
 * Server Card Component.
 *
 * @param {Object}   props               Component props.
 * @param {Object}   props.server        Server status data.
 * @param {number}   props.now           Server snapshot clock for relative-time calc.
 * @param {Object}   [props.probeResult] This spoke's last probe answer, if any.
 * @param {Function} props.onProbe       Fire an on-demand deep probe by server id.
 * @return {import('react').ReactElement} Rendered component.
 */
function ServerCard( { server, now, probeResult, onProbe } ) {
	const partitions = server.partitions || {};
	const partitionKeys = Object.keys( partitions ).sort(
		( a, b ) => Number( a ) - Number( b )
	);

	// Count partitions that are up — streaming, or idle between streams.
	const connectedPartitions = partitionKeys.filter(
		( p ) => 'disconnected' !== partitionState( partitions[ p ] )
	).length;

	// cmd_probe wants the vault credential key, not the node name.
	const runProbe = () => onProbe( server.vault_id );
	const probing = true === probeResult?.busy;

	return (
		<div className="newspack-nodes-card newspack-nodes-card--elevated aggregator-server-card">
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
				<button
					type="button"
					className="button aggregator-fleet-probe-button"
					onClick={ runProbe }
					disabled={ probing }
				>
					{ probing
						? __( 'Probing…', 'newspack-nodes' )
						: __( 'Probe', 'newspack-nodes' ) }
				</button>
			</div>

			{ probeResult && ! probing && (
				<FleetRollup answer={ probeResult } />
			) }

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
	// Mount the graph (poll slices + interval) + the on-demand probe dispatch.
	const { setRefreshInterval, refreshInterval, probe, answerFor } =
		useAggregatorStatusGraph();

	// Two independent read surfaces — one per slice the graph publishes.
	const summary = useNodeState( 'summary:view', 'view' ) ?? EMPTY_SUMMARY;
	const serversSlice =
		useNodeState( 'servers:view', 'view' ) ?? EMPTY_SERVERS;
	// Header strip reads the summary slice (counts + clock + refresh marker).
	const { connected, idle, total, serverNow, lastRefresh } = summary;
	// Server cards read the servers slice (data + its own loading/error gate).
	const { servers, error, loading } = serversSlice;

	const [ , setTick ] = useState( 0 );

	// Tick every second to update relative timestamps (pure display — no poll).
	const bumpClock = useCallback( () => setTick( ( t ) => t + 1 ), [] );
	useRouterTick( { name: 'aggregator:clock', onTick: bumpClock } );

	// Refresh strip: node=portal→slot, null=pending, undefined=inline.
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
					{ /* Idle spokes are up: counting them missing reads as a
					     shortfall on a fleet where nothing is wrong. */ }
					<strong>{ connected + idle }</strong> / { total }{ ' ' }
					{ __( 'up', 'newspack-nodes' ) }
					{ idle > 0 && (
						<span className="aggregator-status-idle-count">
							{ sprintf(
								// translators: %d: number of spokes between streams.
								__( '%d idle', 'newspack-nodes' ),
								idle
							) }
						</span>
					) }
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

	return (
		<div className="aggregator-status-dashboard">
			<HeaderSlot slot={ headerControlsSlot }>{ controls }</HeaderSlot>

			{ /* Loading State */ }
			{ loading && (
				<div className="newspack-nodes-performance-loading aggregator-status-loading">
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
								probeResult={ answerFor( server.vault_id ) }
								onProbe={ probe }
							/>
						) )
					) : (
						<div className="newspack-nodes-empty-state aggregator-status-empty">
							{ __(
								'No servers configured. Add a server in the Vault tab, then wire a Remote_Source into an active topology.',
								'newspack-nodes'
							) }
						</div>
					) }
				</div>
			) }
		</div>
	);
}
