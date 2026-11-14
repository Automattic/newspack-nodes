import { useEffect, useMemo, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { StatTile, StatTiles } from '@newspack-nodes/shared/blocks/stats';
import { TimeChartPanels } from '@newspack-nodes/shared/blocks/time-chart';
import {
	formatBytes,
	formatByteRate,
	formatMsgRate,
	formatCount,
	formatAge,
} from '@newspack-nodes/shared/utils/formatters';
import { useOverviewStats } from '../useOverviewStats';
import { IoTelemetry } from '../../runtime/io-telemetry';
import { Core } from '../../runtime/core';
// Overlay-only additions, panel-scoped so they can't bleed into the station.
import './overview-tab.scss';

/**
 * The three levels IoTelemetry classifies, in chip order, each with the short
 * label its filter chip wears. A `level` here is the exact string
 * `recordError` / `recordWarning` / `recordDebug` push onto the message ring,
 * because the visibility map below is keyed by it — spell one differently and
 * that chip toggles nothing.
 *
 * @type {Array<{level:string,label:string}>}
 */
const MSG_LEVELS = [
	{ level: 'error', label: 'err' },
	{ level: 'warning', label: 'warn' },
	{ level: 'debug', label: 'dbg' },
];

/**
 * A compact in/out tile value: the inbound number carrying ↓, the outbound
 * carrying ↑. Each sits in its own fixed-width right-aligned `nodes-card__io`
 * cell, so the arrows hold their column as the digit count changes rather
 * than sliding around under them.
 *
 * @param {string} inbound  Formatted inbound value.
 * @param {string} outbound Formatted outbound value.
 * @return {import('react').ReactElement} The two cells, as a fragment.
 */
function inOut( inbound, outbound ) {
	return (
		<>
			<span className="nodes-card__io">
				{ inbound }
				{ '↓' }
			</span>
			<span className="nodes-card__io">
				{ outbound }
				{ '↑' }
			</span>
		</>
	);
}

/**
 * The Overview tab — the debug overlay's at-a-glance I/O board. The tiles carry
 * the live in/out byte and message rates, the cumulative in/out byte and message
 * totals, the warning, error and debug counts, and the client and SSE uptimes.
 * Under them sit the two rate panels (Message Rate, Byte Rate) with In/Out
 * series, a button that zeroes the telemetry, and the lines this browser
 * classified, newest first, behind err/warn/dbg chips. Those lines come from
 * the overlay itself, never from the server, which is what the "Messages
 * (this browser)" heading says out loud.
 *
 * The tiles and panels are the shared `StatTile` and `TimeChart`, the ones the
 * station and the stats and time-chart blocks draw, fed straight from
 * `useOverviewStats`, which the always-on IoTelemetry sampler feeds.
 *
 * Header-less: the panel owns the one shared header above the tab bar, so this
 * tab renders only the scrolling body, plus the panel-scoped additions in
 * `overview-tab.scss`. It publishes nothing to that header, because the
 * Overview has no graph cwd to navigate.
 *
 * @param {Object}   props
 * @param {Function} props.publishHeader Publish header extras to the panel's shared Header; the Overview clears them.
 * @return {import('react').ReactElement} The Overview tab.
 */
export default function OverviewTab( { publishHeader } ) {
	const { totals, rates, msgRateSeries, byteRateSeries } = useOverviewStats();

	// The Overview owns no header controls — clear any the Console left behind.
	useEffect( () => publishHeader?.( null ), [ publishHeader ] );

	// Per-level message visibility; on by default, local component state.
	const [ levels, setLevels ] = useState( {
		error: true,
		warning: true,
		debug: true,
	} );
	const levelsKey = MSG_LEVELS.map( ( { level } ) =>
		levels[ level ] ? 1 : 0
	).join( '' );

	// Uptimes read at render so they tick with the tiles' 20Hz refresh.
	const nowSec = Math.floor( Date.now() / 1000 );
	const clientUptime = formatAge(
		Math.floor( performance.timeOrigin / 1000 ),
		nowSec
	);
	const sseUptime = formatAge( totals.sseConnectedAt, nowSec );

	// Memoize the <li> list: reconcile when messages change, not every tick.
	const messages = totals.messages;
	// Seq, not length: the ring shifts at capacity, so length stalls.
	const messagesKey = totals.messageSeq;
	const messageList = useMemo( () => {
		if ( messages.length === 0 ) {
			return null;
		}
		return (
			<div
				className="nodes-overview__messages"
				data-testid="overview-messages"
			>
				<h3 className="newspack-nodes-stat-label">
					{ __( 'Messages (this browser)', 'newspack-nodes' ) }
				</h3>
				<div className="nodes-overview__msg-filters">
					{ MSG_LEVELS.map( ( { level, label } ) => (
						<button
							key={ level }
							type="button"
							data-testid={ `overview-chip-${ level }` }
							aria-pressed={ levels[ level ] }
							className={ `button button-small${
								levels[ level ] ? ' button-primary' : ''
							}` }
							onClick={ () =>
								setLevels( ( prev ) => ( {
									...prev,
									[ level ]: ! prev[ level ],
								} ) )
							}
						>
							{ label }
						</button>
					) ) }
				</div>
				<ul>
					{ messages
						.map( ( m, i ) => ( { m, i } ) )
						.filter( ( { m } ) => levels[ m.level ] )
						.reverse()
						.map( ( { m, i } ) => (
							<li
								key={ i }
								className={ `nodes-overview__msg nodes-overview__msg--${ m.level }` }
							>
								<span className="nodes-overview__msg-text">
									{ Core.logPrefixed( m.text, m.ts ).replace(
										/\n$/,
										''
									) }
								</span>
							</li>
						) ) }
				</ul>
			</div>
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ messagesKey, levelsKey ] );

	return (
		// A self-scrolling body; flex/overflow plumbing, visuals from classes.
		<div
			data-testid="overview-tab"
			className="nodes-overview"
			style={ {
				flex: 1,
				minHeight: 0,
				overflowY: 'auto',
			} }
		>
			<StatTiles>
				<StatTile
					id="byte-rate"
					label={ __( 'Byte Rate', 'newspack-nodes' ) }
					value={ inOut(
						formatByteRate( rates.byteIn ),
						formatByteRate( rates.byteOut )
					) }
				/>
				<StatTile
					id="message-rate"
					label={ __( 'Message Rate', 'newspack-nodes' ) }
					value={ inOut(
						formatMsgRate( rates.msgIn ),
						formatMsgRate( rates.msgOut )
					) }
				/>
				<StatTile
					id="total-messages"
					label={ __( 'Total Messages', 'newspack-nodes' ) }
					value={ inOut(
						formatCount( totals.msgsIn ),
						formatCount( totals.msgsOut )
					) }
				/>
				<StatTile
					id="total-bytes"
					label={ __( 'Total Bytes', 'newspack-nodes' ) }
					value={ inOut(
						formatBytes( totals.bytesIn ),
						formatBytes( totals.bytesOut )
					) }
				/>
				<StatTile
					id="warnings"
					label={ __( 'Warnings', 'newspack-nodes' ) }
					value={ formatCount( totals.warnings ) }
				/>
				<StatTile
					id="errors"
					label={ __( 'Errors', 'newspack-nodes' ) }
					value={ formatCount( totals.errors ) }
				/>
				<StatTile
					id="debug"
					label={ __( 'Debug', 'newspack-nodes' ) }
					value={ formatCount( totals.debug ) }
				/>
				<StatTile
					id="client-uptime"
					label={ __( 'Client Uptime', 'newspack-nodes' ) }
					value={ clientUptime }
				/>
				<StatTile
					id="sse-uptime"
					label={ __( 'SSE Uptime', 'newspack-nodes' ) }
					value={ sseUptime }
				/>
			</StatTiles>
			<TimeChartPanels
				panels={ [
					{
						storageKey: 'newspack-nodes:debug:chart:message-rate',
						title: __( 'Message Rate', 'newspack-nodes' ),
						yLabel: __( 'Messages', 'newspack-nodes' ),
						series: msgRateSeries,
						formatValue: formatMsgRate,
					},
					{
						storageKey: 'newspack-nodes:debug:chart:byte-rate',
						title: __( 'Byte Rate', 'newspack-nodes' ),
						yLabel: __( 'Bytes', 'newspack-nodes' ),
						series: byteRateSeries,
						formatValue: formatByteRate,
					},
				] }
			/>
			<div className="nodes-overview__toolbar">
				<button
					type="button"
					className="button button-small nodes-overview__reset"
					onClick={ () => IoTelemetry.clear() }
				>
					{ __( 'Reset stats', 'newspack-nodes' ) }
				</button>
			</div>
			{ messageList }
		</div>
	);
}
