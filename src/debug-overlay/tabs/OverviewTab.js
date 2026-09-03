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
import { Core } from '../../runtime/core';
// Ship the hub's card/overview layout styles so the overlay is self-contained.
import '../../event-dashboards/styles/summary-cards.scss';
import '../../event-dashboards/styles/overview.scss';
// Overlay-only additions, panel-scoped so they can't bleed into the hub.
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
 * One metric card, on the hub SummaryCards markup: `newspack-nodes-card` for
 * the canonical surface role and `nodes-card` for the value/label layout, so
 * the overlay inherits the hub's card look instead of restating it.
 *
 * @param {Object}                    props
 * @param {string}                    props.id    Card id; names both the `nodes-card--<id>` modifier and the test id.
 * @param {string}                    props.label Caption under the value.
 * @param {import('react').ReactNode} props.value Formatted value, either a plain string or an `inOut` pair.
 * @return {import('react').ReactElement} The card.
 */
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

/**
 * A compact in/out card value: the inbound number carrying ↓, the outbound
 * carrying ↑. Each sits in its own fixed-width right-aligned `nodes-card__io`
 * cell, so the arrows hold their column as the digit count changes rather than
 * sliding around under them.
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
 * The Overview tab — the debug overlay's at-a-glance I/O board. The cards carry
 * the live in/out byte and message rates, the cumulative in/out byte and message
 * totals, the warning, error and debug counts, and the client and SSE uptimes.
 * Under them sit the same two Tachikoma-style rate panels the hub Overview shows
 * (Message Rate, Byte Rate) with In/Out series in place of per-topic, a button
 * that zeroes the telemetry, and the lines this browser classified, newest
 * first, behind err/warn/dbg chips. Those lines are the overlay's own, never the
 * server's, which is what the "Messages (this browser)" heading says out loud.
 *
 * Header-less: the panel owns the one shared header above the tab bar, so this
 * tab renders only the scrolling body, on the hub's card, panel and chart
 * classes plus the panel-scoped additions in `overview-tab.scss`. It publishes
 * nothing to that header, because the Overview has no graph cwd to navigate.
 * Data comes from `useOverviewStats`, fed by the always-on IoTelemetry sampler.
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

	// Uptimes read at render so they tick with the cards' 20Hz refresh.
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
									{ Core.log_prefixed( m.text, m.ts ).replace(
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
