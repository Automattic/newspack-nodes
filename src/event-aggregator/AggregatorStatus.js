/**
 * Aggregator Status — the hub's screen for every spoke whose log it pulls.
 *
 * A thin view over the `aggregator:*` node graph `useAggregatorStatusGraph`
 * mounts. That graph polls two independent slices, each on its own verb with
 * its own reply path:
 *
 *   summary:view — the header strip: connected/idle/total counts and the
 *                  server's snapshot clock.
 *   servers:view — one card per wired `Remote_Source`, each holding a grid of
 *                  that spoke's partitions.
 *
 * This component reads each slice through its own `useNodeState` and renders
 * it. The split belongs to the graph rather than to the layout: a reply is
 * addressed to its own view node, so a slice that errors leaves the other one
 * on screen ([ADR-7](../../docs/architecture-decisions.md)). Both slices still
 * ride one POST per tick.
 *
 * Ages on the screen are measured against the server's snapshot clock, which
 * arrives on the summary slice and is handed down to the cards — a workstation
 * clock minutes out would otherwise read a healthy spoke as stale. The
 * one-second tick lives here because re-rendering those ages asks the server
 * for nothing.
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

/**
 * The header slice a first render reads, before the graph exists.
 *
 * `useNodeState` answers undefined until `summary:view` is mounted, and the
 * effect that builds the graph runs after that first render. The shape mirrors
 * the view node's own `empty` declaration in `nodes/register.js`: this screen
 * reads the counts, the clock and `lastRefresh`, and carries the rest so the
 * two models stay one shape.
 */
const EMPTY_SUMMARY = {
	connected: 0,
	idle: 0,
	total: 0,
	serverNow: null,
	error: null,
	loading: true,
	lastRefresh: null,
};

/**
 * The server-cards slice a first render reads, on the same terms.
 *
 * This slice, not the summary, gates the body of the page: `loading: true`
 * holds the spinner up until the first reply, and `servers: null` keeps the
 * header's up/total count hidden until the cards it counts have arrived.
 */
const EMPTY_SERVERS = {
	servers: null,
	error: null,
	loading: true,
};

/**
 * Render a Unix timestamp as an age, or as a date once an age stops meaning
 * anything: seconds under the minute, minutes under the hour, and the local
 * date and time beyond that, where a bare clock reading could be any day.
 *
 * @param {?number} timestamp Unix timestamp in seconds; falsy renders "-".
 * @param {?number} [now]     The server's snapshot clock, which is what an age
 *                            is measured against so client drift cannot age a
 *                            healthy spoke. Omitted or null measures against
 *                            the browser clock — right for a browser-minted
 *                            timestamp such as `lastRefresh`, and the state
 *                            before the summary slice's first reply.
 * @return {string} The age, the local date and time, or "-".
 */
const formatTime = ( timestamp, now ) => {
	if ( ! timestamp ) {
		return '-';
	}

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
 * Format a round-trip time in milliseconds at the precision its magnitude
 * earns: two decimals below 1ms, one below 100ms, whole milliseconds above. A
 * same-host heartbeat would otherwise render as a flat "0".
 *
 * @param {?number} rtt Round-trip time in milliseconds.
 * @return {?string} The formatted reading, or null when there is none.
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
 * The status modifier for one RTT reading: `error` above 500ms, `warning`
 * above 200ms, `success` below, and `muted` when the spoke has answered no
 * heartbeat yet. It modifies the shared `newspack-nodes-status` class, so the
 * colours are the design system's rather than this dashboard's.
 *
 * @param {?number} rtt Round-trip time in milliseconds.
 * @return {string} One of muted|error|warning|success.
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
 * One partition's four-state connection reading. A stream the server closed at
 * EOF is IDLE — healthy, and due back at `scheduled_reconnect_at`. A socket
 * still opening is CONNECTING — `connected` is the handshake, not the handle.
 * Neither is the failure a bare `! connected` would make it.
 *
 * @param {?Object} status That partition's status snapshot, empty when the
 *                         reader has published nothing for it yet.
 * @return {string} One of connected|idle|connecting|disconnected.
 */
const partitionState = ( status ) => {
	if ( status?.connected ) {
		return 'connected';
	}
	if ( status?.scheduled_reconnect_at ) {
		return 'idle';
	}
	return status?.connecting ? 'connecting' : 'disconnected';
};

/**
 * What broke, in a phrase. A status card carries the diagnosis; the transport's
 * own wording stays reachable in the hover title beside it.
 *
 * @param {?string} error Raw `last_error` from the partition snapshot.
 * @return {?string} A short phrase, or the input when there is nothing to trim.
 */
const shortError = ( error ) => {
	if ( ! error ) {
		return error;
	}
	if ( /timed out|timeout/i.test( error ) ) {
		return __( 'timed out', 'newspack-nodes' );
	}
	if ( /SSE stream ended/.test( error ) ) {
		return __( 'stream ended', 'newspack-nodes' );
	}
	// libcurl's parenthetical is its human half; the detail only restates it.
	const curl = /^cURL error \d+ \(([^)]+)\)/.exec( error );
	if ( curl ) {
		return curl[ 1 ].toLowerCase();
	}
	// Everything else already reads as a phrase; drop the parenthetical detail.
	return error.replace( /\s*\([^)]*\)/g, '' ).trim() || error;
};

/**
 * How long until a stream closed at EOF comes back — the useful fact about an
 * idle spoke, where a last-attempt timestamp says nothing.
 *
 * @param {number}  timestamp Unix second the reopen is due.
 * @param {?number} [now]     Server snapshot clock; browser clock when omitted.
 * @return {string} The wait, never negative — a reopen already due reads
 *                  "in 0s" rather than counting up past it.
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
 * One partition tile: its connection state, the timestamps behind that state,
 * and either the error that explains it or the client-heartbeat verdict.
 *
 * The left rail's health class is deliberately coarser than the badge. A
 * partition that is connected but has answered no client heartbeat rails
 * `degraded` rather than `ok` — the socket is up and the round trip is not.
 *
 * @param {Object}  props           Component props.
 * @param {number}  props.partition Partition number.
 * @param {Object}  props.status    That partition's status snapshot.
 * @param {?number} props.now       Server snapshot clock; null before the
 *                                  summary slice's first reply.
 * @return {import('react').ReactElement} Rendered component.
 */
function PartitionStatus( { partition, status, now } ) {
	const connectionStatus = partitionState( status );
	const connected = 'connected' === connectionStatus;
	const idle = 'idle' === connectionStatus;
	// Gate on connected: heartbeat ts is sticky, else dead spoke latches OK.
	const heartbeatStatus =
		connected && status.last_heartbeat_response ? 'success' : 'pending';
	// Health rails the left edge: ok / degraded / idle / connecting / down.
	let health =
		'disconnected' === connectionStatus ? 'down' : connectionStatus;
	if ( connected ) {
		health = heartbeatStatus === 'success' ? 'ok' : 'degraded';
	}
	const errorMessage = shortError( status.last_error );
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
						{ /* The error outranks the heartbeat it explains. */ }
						{ errorMessage ? (
							<span
								className="newspack-nodes-status-badge aggregator-partition-error small is-error"
								title={ status.last_error }
							>
								{ errorMessage }
							</span>
						) : (
							<span
								className={ `newspack-nodes-status-badge aggregator-heartbeat-badge small ${ heartbeatStatus }` }
							>
								{ heartbeatStatus.replace( /_/g, ' ' ) }
							</span>
						) }
						{ /* HTTP code as a muted caption on Status line. */ }
						{ status.last_http_code && (
							<span className="aggregator-http-code">
								HTTP { status.last_http_code }
							</span>
						) }
					</span>
				</div>
			</div>
		</div>
	);
}

/**
 * Fleet roll-up panel: the on-demand deep-probe result for one spoke — worker
 * live/stale/dead counts, worst consumer distance, dead-letter total. The
 * polled slices carry connection health only, so this line is the one place
 * the fleet behind a spoke shows, and it appears once a Probe click has
 * answered. A refused probe shows its error instead, full text in the title.
 *
 * @param {Object} props        Component props.
 * @param {Object} props.answer The probe answer as `onAnswer` delivered it:
 *                              `{ result, error }`, one of the two set.
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
 * One spoke's card: which server it is, how many of its partitions are up, the
 * Probe button, the last probe's roll-up, and a tile per partition.
 *
 * @param {Object}   props         Component props.
 * @param {Object}   props.server  One row of the servers slice: `id`, `url`,
 *                                 `vault_id`, and a snapshot per partition.
 * @param {?number}  props.now     Server snapshot clock; null before the
 *                                 summary slice's first reply.
 * @param {?Object}  props.answer  This spoke's last probe answer, or null.
 * @param {boolean}  props.probing Whether a probe of this spoke is outstanding.
 * @param {Function} props.onProbe Probe callback, taking the spoke's Vault id —
 *                                 what `cmd_probe` looks its credentials up by,
 *                                 never the `Remote_Source` node name.
 * @return {import('react').ReactElement} Rendered component.
 */
function ServerCard( { server, now, answer, probing, onProbe } ) {
	const partitions = server.partitions || {};
	const partitionKeys = Object.keys( partitions ).sort(
		( a, b ) => Number( a ) - Number( b )
	);

	// Up is anything but disconnected: streaming, idle, or still opening.
	const connectedPartitions = partitionKeys.filter(
		( p ) => 'disconnected' !== partitionState( partitions[ p ] )
	).length;

	return (
		<div className="newspack-nodes-card newspack-nodes-card--elevated aggregator-server-card">
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
					onClick={ () => onProbe( server.vault_id ) }
					disabled={ probing }
				>
					{ probing
						? __( 'Probing…', 'newspack-nodes' )
						: __( 'Probe', 'newspack-nodes' ) }
				</button>
			</div>

			{ answer && ! probing && <FleetRollup answer={ answer } /> }

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
 * The Aggregator Status dashboard: mount the graph, place the refresh strip in
 * the hub's header, and list one card per spoke.
 *
 * @param {Object}   props                      Component props.
 * @param {?Element} [props.headerControlsSlot] Hub shared-header slot to portal
 *                                              the refresh strip into; null
 *                                              renders none, undefined renders
 *                                              it inline.
 * @return {import('react').ReactElement} Rendered component.
 */
export default function AggregatorStatus( { headerControlsSlot } ) {
	// @longform Each spoke's last probe answer, put there BY the reply that
	// named it. Not a correlation table: the graph did the matching in the
	// ADDRESS, before this screen saw it — which is why one card keeps its
	// roll-up while a sibling is probed.
	const [ answers, setAnswers ] = useState( {} );
	const { setRefreshInterval, refreshInterval, probeServer, isPending } =
		useAggregatorStatusGraph( {
			onAnswer: ( { subject, result, error: refusal } ) =>
				setAnswers( ( prior ) => ( {
					...prior,
					[ subject ]: { result, error: refusal },
				} ) ),
		} );

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

	// Refresh strip: a slot portals, null withholds, undefined inlines.
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
					{ /* Idle spokes are healthy; they count as up. */ }
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
				aria-label={ __( 'Refresh interval', 'newspack-nodes' ) }
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

			{ loading && (
				<div className="newspack-nodes-performance-loading aggregator-status-loading">
					<div className="spinner" />
					<span>
						{ __( 'Loading server status…', 'newspack-nodes' ) }
					</span>
				</div>
			) }

			{ ! loading && (
				<ConnectionBanner
					connectionError={ !! error }
					message={ error }
				/>
			) }

			{ ! loading && ! error && (
				<div className="aggregator-status-servers">
					{ servers && servers.length > 0 ? (
						servers.map( ( server ) => (
							<ServerCard
								key={ server.id }
								server={ server }
								now={ serverNow }
								answer={ answers[ server.vault_id ] ?? null }
								probing={ isPending( server.vault_id ) }
								onProbe={ probeServer }
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
