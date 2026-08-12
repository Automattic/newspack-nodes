import { useEffect, useMemo, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
// Reuse the hub's d3 rate panel (pulls d3 in) — cheaper than reimplementing it.
import { TopicsChart } from '../../event-dashboards/TopicsChart';
import {
	formatBytes,
	formatByteRate,
	formatMsgRate,
	formatCount,
	formatAge,
} from '@newspack-nodes/shared/utils/formatters';
import { useOverviewStats } from '../useOverviewStats';
import { IoTelemetry } from '../../runtime/io-telemetry';
// Ship the hub's card/overview layout styles so the overlay is self-contained.
import '../../event-dashboards/styles/summary-cards.scss';
import '../../event-dashboards/styles/overview.scss';
// Overlay-only additions, panel-scoped so they can't bleed into the hub.
import './overview-tab.scss';

// Message levels, in chip order: error / warning / debug.
const MSG_LEVELS = [
	{ level: 'error', label: 'err' },
	{ level: 'warning', label: 'warn' },
	{ level: 'debug', label: 'dbg' },
];

// One metric card — reuses the hub SummaryCards `.nodes-card` markup + styling.
function Card( { id, label, value } ) {
	return (
		<div
			className={ `newspack-nodes-card nodes-card nodes-card--${ id }` }
			data-testid={ `overview-card-${ id }` }
		>
			<span className="nodes-card__value">{ value }</span>
			<span className="nodes-card__label">{ label }</span>
		</div>
	);
}

// Compact in/out value: ↓ inbound ↑ outbound; fixed-width cells so arrows hold.
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
 * The Overview tab — the debug overlay's at-a-glance I/O board. Cards for the
 * current byte/message rates and cumulative byte/message/warning/error totals
 * (in vs out), plus the same two Tachikoma-style rate panels the hub Overview
 * shows (Message Rate, Byte Rate) but with In/Out series in place of per-topic.
 *
 * Header-less: the panel owns the one shared header above the tab bar, so this
 * tab is just the scrolling body, on the hub's own card / panel / chart classes
 * (no styles of its own) and the Newspack surface backdrop. It publishes nothing
 * to the shared header (the Overview has no graph cwd to navigate). Data comes
 * from useOverviewStats, fed by the always-on IoTelemetry sampler.
 *
 * @param {Object}   props
 * @param {Function} props.publishHeader Publish header extras to the panel's shared Header (the Overview clears them).
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

	// Uptimes read at render so they tick with the cards' 20Hz refresh.
	const nowSec = Math.floor( Date.now() / 1000 );
	const clientUptime = formatAge(
		Math.floor( performance.timeOrigin / 1000 ),
		nowSec
	);
	const sseUptime = formatAge( totals.sseConnectedAt, nowSec );

	// Memoize the <li> list: reconcile when messages change, not every tick.
	const messages = totals.messages;
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
				<h3>{ __( 'Messages (this browser)', 'newspack-nodes' ) }</h3>
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
									{ m.text }
								</span>
								<time className="nodes-overview__msg-age">
									{ formatAge( Math.floor( m.ts ), nowSec ) }{ ' ' }
									{ __( 'ago', 'newspack-nodes' ) }
								</time>
							</li>
						) ) }
				</ul>
			</div>
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ messagesKey, levelsKey ] );

	return (
		// Fullbleed body; flex/overflow plumbing, visuals from classes.
		<div
			data-testid="overview-tab"
			className="nodes-overview"
			style={ {
				flex: 1,
				minHeight: 0,
				overflowY: 'auto',
			} }
		>
			<div className="nodes-cards">
				<Card
					id="byte-rate"
					label={ __( 'Byte Rate', 'newspack-nodes' ) }
					value={ inOut(
						formatByteRate( rates.byteIn ),
						formatByteRate( rates.byteOut )
					) }
				/>
				<Card
					id="message-rate"
					label={ __( 'Message Rate', 'newspack-nodes' ) }
					value={ inOut(
						formatMsgRate( rates.msgIn ),
						formatMsgRate( rates.msgOut )
					) }
				/>
				<Card
					id="total-messages"
					label={ __( 'Total Messages', 'newspack-nodes' ) }
					value={ inOut(
						formatCount( totals.msgsIn ),
						formatCount( totals.msgsOut )
					) }
				/>
				<Card
					id="total-bytes"
					label={ __( 'Total Bytes', 'newspack-nodes' ) }
					value={ inOut(
						formatBytes( totals.bytesIn ),
						formatBytes( totals.bytesOut )
					) }
				/>
				<Card
					id="warnings"
					label={ __( 'Warnings', 'newspack-nodes' ) }
					value={ formatCount( totals.warnings ) }
				/>
				<Card
					id="errors"
					label={ __( 'Errors', 'newspack-nodes' ) }
					value={ formatCount( totals.errors ) }
				/>
				<Card
					id="debug"
					label={ __( 'Debug', 'newspack-nodes' ) }
					value={ formatCount( totals.debug ) }
				/>
				<Card
					id="client-uptime"
					label={ __( 'Client Uptime', 'newspack-nodes' ) }
					value={ clientUptime }
				/>
				<Card
					id="sse-uptime"
					label={ __( 'SSE Uptime', 'newspack-nodes' ) }
					value={ sseUptime }
				/>
			</div>
			<div className="nodes-overview__panels">
				<TopicsChart
					title={ __( 'Message Rate', 'newspack-nodes' ) }
					series={ msgRateSeries }
					formatValue={ formatMsgRate }
				/>
				<TopicsChart
					title={ __( 'Byte Rate', 'newspack-nodes' ) }
					series={ byteRateSeries }
					formatValue={ formatByteRate }
				/>
			</div>
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
