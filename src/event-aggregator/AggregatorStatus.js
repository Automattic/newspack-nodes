/**
 * Aggregator Status — the hub's screen for every spoke whose log it pulls.
 *
 * A thin view over the `aggregator:*` node graph `useAggregatorStatusGraph`
 * mounts. That graph polls two independent slices, each on its own verb with
 * its own reply path:
 *
 *   summary:view — the header strip: connected/idle/total counts, the
 *                  server's snapshot clock, and each active topology that
 *                  will not read, whose spokes the cards therefore omit.
 *   servers:view — one card per wired `Remote_Source`, each holding a line
 *                  per partition and a line of its stream readers' cursors.
 *
 * This component reads each slice through its own `useNodeField` and renders
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

import { useNodeField } from '@newspack-nodes/runtime';
import {
	useAggregatorStatusGraph,
	REFRESH_OPTIONS,
} from './hooks/useAggregatorStatusGraph';
import ConnectionBanner from '@newspack-nodes/shared/components/ConnectionBanner';
import UnreadableNotice from '@newspack-nodes/shared/components/UnreadableNotice';
import useRouterTick from '@newspack-nodes/shared/hooks/useRouterTick';
import { formatLocalDateTime } from '@newspack-nodes/shared/utils/formatUtils';
import { formatBytes } from '@newspack-nodes/shared/utils/formatters';
import { sourceName } from '../runtime/log-stamp';
import './styles/aggregator-status.scss';
import { HeaderSlot } from '@newspack-nodes/shared/components/HeaderSlot';

/**
 * The header slice a first render reads, before the graph exists.
 *
 * `useNodeField` answers undefined until `summary:view` is mounted, and the
 * effect that builds the graph runs after that first render. The shape mirrors
 * the view node's own `empty` declaration in `nodes/register.js`: this screen
 * reads the counts, the clock, `unreadable` and `lastRefresh`, and carries
 * the rest so the two models stay one shape.
 */
const EMPTY_SUMMARY = {
	connected: 0,
	idle: 0,
	total: 0,
	serverNow: null,
	unreadable: {},
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

/** What a timings cell shows for a reading the spoke has not reported. */
const ABSENT = '—';

/**
 * Render a Unix timestamp as an age, or as a date once an age stops meaning
 * anything: seconds under the minute, minutes under the hour, and the local
 * date and time beyond that, where a bare clock reading could be any day.
 *
 * @param {?number} timestamp Unix timestamp in seconds; falsy renders "—".
 * @param {?number} [now]     The server's snapshot clock, which is what an age
 *                            is measured against so client drift cannot age a
 *                            healthy spoke. Omitted or null measures against
 *                            the browser clock — right for a browser-minted
 *                            timestamp such as `lastRefresh`, and the state
 *                            before the summary slice's first reply.
 * @return {string} The age, the local date and time, or "—".
 */
const formatTime = ( timestamp, now ) => {
	if ( ! timestamp ) {
		return ABSENT;
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
 * same-host round trip would otherwise render as a flat "0".
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
 * round trip yet. It modifies the shared `newspack-nodes-status` class, so the
 * design system sets the colours rather than this dashboard.
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
 * One cell of a partition's timings grid: its label over its value, which
 * is clipped to one line with the whole reading in its title.
 *
 * @param {Object} props             Component props.
 * @param {string} props.label       The reading's label.
 * @param {string} [props.title]     The whole reading, for hover.
 * @param {string} [props.className] A class beside the cell's own.
 * @param {*}      props.children    The value.
 * @return {import('react').ReactElement} Rendered component.
 */
function Stat( { label, title, className = '', children } ) {
	return (
		<span className={ `aggregator-stat ${ className }`.trim() }>
			<span className="newspack-nodes-stat-label">{ label }</span>
			<span
				className="newspack-nodes-stat-value aggregator-stat-value"
				title={ title }
			>
				{ children }
			</span>
		</span>
	);
}

/**
 * A connection-state pill, for one partition or a whole spoke.
 *
 * @param {Object} props          Component props.
 * @param {string} props.state    One of connected|idle|connecting|disconnected.
 * @param {*}      props.children The pill's text.
 * @return {import('react').ReactElement} Rendered component.
 */
function StateBadge( { state, children } ) {
	return (
		<span
			className={ `newspack-nodes-status-badge aggregator-status-badge small ${ state }` }
		>
			{ children }
		</span>
	);
}

/**
 * The label of a partition's first reading: when the link reconnects while
 * idle, when it connected while up, and when it last tried otherwise.
 *
 * @param {boolean} idle      Whether the partition sits closed on purpose.
 * @param {boolean} connected Whether the partition streams.
 * @return {string} The label.
 */
function attemptLabel( idle, connected ) {
	if ( idle ) {
		return __( 'Reconnects', 'newspack-nodes' );
	}
	return connected
		? __( 'Connected', 'newspack-nodes' )
		: __( 'Attempt', 'newspack-nodes' );
}

/**
 * One partition's health, coarser than its connection state: a partition
 * that is connected but has answered no round trip is `degraded` rather than
 * `ok` — the socket is up and the round trip is not.
 *
 * @param {Object} status That partition's status snapshot.
 * @return {string} One of ok|degraded|idle|connecting|down.
 */
function partitionHealth( status ) {
	const state = partitionState( status );
	if ( 'connected' === state ) {
		return status.last_response ? 'ok' : 'degraded';
	}
	return 'disconnected' === state ? 'down' : state;
}

/** Health readings, best first: a card rails its worst partition. */
const HEALTH_RANK = [ 'ok', 'idle', 'connecting', 'degraded', 'down' ];

/** Connection states, best first: a summed badge wears its worst. */
const STATE_RANK = [ 'connected', 'idle', 'connecting', 'disconnected' ];

/**
 * The worst of several readings by a best-first rank, and the rank's worst
 * when there are none, so a spoke reporting no partition reads as down.
 *
 * @param {Array<string>} values The readings.
 * @param {Array<string>} rank   Every reading, best first.
 * @return {string} The worst reading.
 */
const worst = ( values, rank ) =>
	rank[ Math.max( ...values.map( ( value ) => rank.indexOf( value ) ) ) ] ??
	rank[ rank.length - 1 ];

/**
 * The host a spoke URL names, which is what tells two spokes apart; the URL
 * itself when it names none or will not parse.
 *
 * @param {string} url The spoke's stored URL.
 * @return {string} Its host, or the URL as given.
 */
function hostOf( url ) {
	try {
		return new URL( url ).host || url;
	} catch {
		return url;
	}
}

/**
 * One partition's timings as a fixed grid of five cells, the same on every
 * card: since when it streams (or when it last tried, or when it reopens),
 * the server heartbeat, the round trip with its RTT verdict, the status —
 * the error that explains it outranking the response badge — and the HTTP
 * code. A reading not yet reported shows a dash rather than dropping its
 * cell. On a card holding several partitions a head row above the cells
 * names the partition and gives it its own state pill.
 *
 * @param {Object}  props        Component props.
 * @param {?string} props.label  `p<N>` on a multi-partition card, else null.
 * @param {Object}  props.status That partition's status snapshot.
 * @param {?number} props.now    Server snapshot clock; null before the
 *                               summary slice's first reply.
 * @return {import('react').ReactElement} Rendered component.
 */
function PartitionLine( { label, status, now } ) {
	const connectionStatus = partitionState( status );
	const connected = 'connected' === connectionStatus;
	const idle = 'idle' === connectionStatus;
	// Gate on connected: response ts is sticky, else dead spoke latches OK.
	const responseStatus =
		connected && status.last_response ? 'success' : 'pending';
	const errorMessage = shortError( status.last_error );
	const rtt = status.last_rtt;
	const rttFormatted = formatRtt( rtt );
	const since = idle
		? formatCountdown( status.scheduled_reconnect_at, now )
		: formatTime( status.last_connection_attempt, now );
	const heartbeat = formatTime( status.last_sse_heartbeat, now );
	const responded = formatTime( status.last_response, now );
	const httpCode = String( status.last_http_code || ABSENT );

	return (
		<div className="aggregator-partition-line">
			{ label && (
				<div className="aggregator-partition-head">
					<span className="aggregator-partition-label">
						{ label }
					</span>
					<StateBadge state={ connectionStatus }>
						{ connectionStatus }
					</StateBadge>
				</div>
			) }
			<Stat label={ attemptLabel( idle, connected ) } title={ since }>
				{ since }
			</Stat>
			<Stat
				label={ __( 'Server HB', 'newspack-nodes' ) }
				title={ heartbeat }
			>
				{ heartbeat }
			</Stat>
			<Stat
				label={ __( 'Round trip', 'newspack-nodes' ) }
				title={
					rttFormatted
						? `${ rttFormatted }ms ${ responded }`
						: responded
				}
			>
				{ rttFormatted && (
					<>
						<span
							className={ `newspack-nodes-status aggregator-rtt small ${ getRttClass(
								rtt
							) }` }
						>
							{ rttFormatted }ms
						</span>{ ' ' }
					</>
				) }
				{ responded }
			</Stat>
			<Stat
				label={ __( 'Status', 'newspack-nodes' ) }
				className="is-wide"
			>
				{ /* The error outranks the response it explains. */ }
				{ errorMessage ? (
					<span
						className="newspack-nodes-status-badge aggregator-partition-error small is-error"
						title={ status.last_error }
					>
						{ errorMessage }
					</span>
				) : (
					<span
						className={ `newspack-nodes-status-badge aggregator-response-badge small ${ responseStatus }` }
					>
						{ responseStatus }
					</span>
				) }
			</Stat>
			<Stat label={ __( 'HTTP', 'newspack-nodes' ) } title={ httpCode }>
				{ httpCode }
			</Stat>
		</div>
	);
}

/**
 * Fleet roll-up panel: the on-demand deep-probe result for one spoke — its
 * worker count in each state `wp nodes status` reports, worst consumer distance
 * (unknown when no reader can measure one), dead-letter total. The
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
			<span>
				{ sprintf(
					// translators: 1: live, 2: stale, 3: held, 4: idle, 5: down workers.
					__(
						'Workers %1$d live / %2$d stale / %3$d held / %4$d idle / %5$d down',
						'newspack-nodes'
					),
					workers.live || 0,
					workers.stale || 0,
					workers.held || 0,
					workers.idle || 0,
					workers.down || 0
				) }
			</span>
			<span>
				{ null === worstDistance
					? __( 'Worst lag unknown', 'newspack-nodes' )
					: sprintf(
							// translators: %d: worst consumer lag in bytes.
							__( 'Worst lag %d B', 'newspack-nodes' ),
							worstDistance
					  ) }
			</span>
			<span>
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
 * The broker's readers on one line, each as its log and how far behind it is,
 * with its stamp and `segment:offset` cursor on hover. A hub reader's lag is
 * null until its spoke first reports one, and a null lag reads as unknown
 * rather than as caught up. A multi-partition card prefixes each reader with
 * the worker partition reading it. Nothing renders for a broker whose readers
 * have reported no position yet.
 *
 * @param {Object}        props         Component props.
 * @param {Array<Object>} props.readers The server row's `readers`: `stamp`,
 *                                      `partition`, `cursor` and `distance`.
 * @param {boolean}       props.multi   Whether the card holds several
 *                                      partitions.
 * @return {?import('react').ReactElement} Rendered component, or null.
 */
function CursorLine( { readers, multi } ) {
	if ( ! readers.length ) {
		return null;
	}
	return (
		<div className="aggregator-cursors">
			{ readers.map( ( reader ) => {
				const behind =
					null === reader.distance
						? __( 'lag unknown', 'newspack-nodes' )
						: formatBytes( reader.distance );
				return (
					<span
						key={ `${ reader.partition }:${ reader.stamp }` }
						className="aggregator-cursor"
						title={ `${ reader.stamp } ${ reader.cursor }` }
					>
						{ `${ multi ? `p${ reader.partition } ` : '' }${
							sourceName( reader.stamp ) ?? reader.stamp
						} ${ behind }` }
					</span>
				);
			} ) }
		</div>
	);
}

/**
 * One spoke's card: its id and connection badge, its host, one timings line
 * per partition, its readers' cursors, the last probe's roll-up and the Probe
 * button. A one-partition spoke's badge is that partition's state; a card
 * holding several sums them as `<up>/<total> up`, idle counted up, wears the
 * worst state, and labels each line. The left rail takes the worst
 * partition's health, so one partition down shows on the card.
 *
 * @param {Object}   props         Component props.
 * @param {Object}   props.server  One row of the servers slice: `id`, `url`,
 *                                 `vault_id`, a snapshot per partition, and
 *                                 its `readers`.
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
	const statuses = partitionKeys.map( ( p ) => partitions[ p ] || {} );
	const states = statuses.map( partitionState );
	const multi = 1 !== partitionKeys.length;
	const health = worst( statuses.map( partitionHealth ), HEALTH_RANK );

	return (
		<div
			className={ `newspack-nodes-card newspack-nodes-card--elevated aggregator-server-card is-${ health }` }
			style={
				partitionKeys.length > 1
					? { gridRow: `span ${ partitionKeys.length }` }
					: undefined
			}
		>
			<div className="aggregator-server-header">
				<span className="aggregator-server-id" title={ server.id }>
					{ server.id }
				</span>
				<StateBadge state={ worst( states, STATE_RANK ) }>
					{ multi
						? sprintf(
								// translators: 1: partitions up (idle counts), 2: all partitions.
								__( '%1$d/%2$d up', 'newspack-nodes' ),
								states.filter( ( s ) => 'disconnected' !== s )
									.length,
								states.length
						  )
						: states[ 0 ] }
				</StateBadge>
			</div>
			<div className="aggregator-server-url" title={ server.url }>
				{ hostOf( server.url ) }
			</div>

			{ partitionKeys.map( ( p, index ) => (
				<PartitionLine
					key={ p }
					label={ multi ? `p${ p }` : null }
					status={ statuses[ index ] }
					now={ now }
				/>
			) ) }

			<CursorLine readers={ server.readers || [] } multi={ multi } />

			{ answer && ! probing && <FleetRollup answer={ answer } /> }

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
	);
}

/**
 * The Aggregator Status dashboard: mount the graph, place the refresh strip in
 * the station's header, and list one card per spoke.
 *
 * @param {Object}   props                      Component props.
 * @param {?Element} [props.headerControlsSlot] Station shared-header slot to portal
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
	const summary = useNodeField( 'summary:view', 'view' ) ?? EMPTY_SUMMARY;
	const serversSlice =
		useNodeField( 'servers:view', 'view' ) ?? EMPTY_SERVERS;
	// Summary slice: counts, clock, refresh marker, unreadable topologies.
	const { connected, idle, total, serverNow, unreadable, lastRefresh } =
		summary;
	// Server cards read the servers slice (data + its own loading/error gate).
	const { servers, error, loading } = serversSlice;

	const [ , setTick ] = useState( 0 );

	// Tick every second to update relative timestamps (pure display — no poll).
	const bumpClock = useCallback( () => setTick( ( t ) => t + 1 ), [] );
	useRouterTick( { name: 'aggregator-clock:timer', onTick: bumpClock } );

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

			<UnreadableNotice
				failures={ unreadable }
				describe={ ( name, message ) =>
					sprintf(
						// translators: 1: topology name, 2: why it will not read.
						__(
							'Topology %1$s will not read, so its servers are not listed: %2$s',
							'newspack-nodes'
						),
						name,
						message
					)
				}
			/>

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
