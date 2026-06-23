import { __ } from '@wordpress/i18n';
// Reuse the hub's exact d3 rate panel rather than reimplement it. Tradeoff: this
// pulls d3 (via the shared useTimeChart) into the devtools-hub bundle that hosts
// the overlay — accepted, since reimplementing the area chart is the worse cost.
import { TopicsChart } from '../../event-dashboards/TopicsChart';
import {
	formatBytes,
	formatByteRate,
	formatMsgRate,
	formatCount,
} from '../../event-dashboards/formatters';
import { useOverviewStats } from '../useOverviewStats';
import '../overview-tab.scss';

/**
 * One metric card. A pair card shows ↓in / ↑out rows; a single card shows one big
 * value (warnings / errors).
 *
 * @param {Object} props
 * @param {string} props.id         Card key (drives the data-testid).
 * @param {string} props.label      Card title.
 * @param {string} [props.inbound]  Formatted inbound value (pair cards).
 * @param {string} [props.outbound] Formatted outbound value (pair cards).
 * @param {string} [props.value]    Formatted single value (single cards).
 * @return {import('react').ReactElement} The card.
 */
function Card( { id, label, inbound, outbound, value } ) {
	return (
		<div
			className="nodes-debug-overview__card"
			data-testid={ `overview-card-${ id }` }
		>
			<div className="nodes-debug-overview__card-label">{ label }</div>
			{ undefined !== value ? (
				<div className="nodes-debug-overview__card-single">
					{ value }
				</div>
			) : (
				<div className="nodes-debug-overview__card-pair">
					<div className="nodes-debug-overview__io">
						<span className="nodes-debug-overview__io-arrow">
							↓
						</span>
						<span className="nodes-debug-overview__io-label">
							{ __( 'in', 'newspack-nodes' ) }
						</span>
						<span className="nodes-debug-overview__io-value">
							{ inbound }
						</span>
					</div>
					<div className="nodes-debug-overview__io">
						<span className="nodes-debug-overview__io-arrow">
							↑
						</span>
						<span className="nodes-debug-overview__io-label">
							{ __( 'out', 'newspack-nodes' ) }
						</span>
						<span className="nodes-debug-overview__io-value">
							{ outbound }
						</span>
					</div>
				</div>
			) }
		</div>
	);
}

/**
 * The Overview tab — the debug overlay's at-a-glance I/O board. Cards for the
 * current byte/message rates and cumulative byte/message/warning/error totals
 * (in vs out), plus the same two Tachikoma-style rate panels the hub Overview
 * shows (Message Rate, Byte Rate) but with In/Out series in place of per-topic.
 *
 * fullBleed: owns its own fixed header (panel drag + close) and a scrolling body,
 * so the drag handle never scrolls away. Data comes from useOverviewStats, fed by
 * the always-on IoTelemetry sampler.
 *
 * @param {Object}   props
 * @param {Function} props.onClose             Close the panel (host's setOpen(false)).
 * @param {Function} props.onHeaderPointerDown Header drag-start gesture from the host.
 * @param {Function} props.toggleMaximize      Maximize toggle from the host.
 * @return {import('react').ReactElement} The Overview tab.
 */
export default function OverviewTab( {
	onClose,
	onHeaderPointerDown,
	toggleMaximize,
} ) {
	const { totals, rates, msgRateSeries, byteRateSeries } = useOverviewStats();

	return (
		<div className="nodes-debug-overview" data-testid="overview-tab">
			<div
				className="nodes-debug-overview__header"
				data-testid="overview-header"
				onPointerDown={ onHeaderPointerDown }
				onDoubleClick={ ( e ) => {
					if ( e.target?.closest?.( 'button' ) ) {
						return;
					}
					toggleMaximize();
				} }
			>
				<span className="nodes-debug-overview__heading">
					{ __( 'I/O Overview', 'newspack-nodes' ) }
				</span>
				<button
					type="button"
					className="nodes-debug-overview__close"
					aria-label={ __( 'Close', 'newspack-nodes' ) }
					onClick={ onClose }
				>
					{ '✕' }
				</button>
			</div>
			<div className="nodes-debug-overview__body">
				<div className="nodes-debug-overview__cards">
					<Card
						id="byte-rate"
						label={ __( 'Byte Rate', 'newspack-nodes' ) }
						inbound={ formatByteRate( rates.byteIn ) }
						outbound={ formatByteRate( rates.byteOut ) }
					/>
					<Card
						id="message-rate"
						label={ __( 'Message Rate', 'newspack-nodes' ) }
						inbound={ formatMsgRate( rates.msgIn ) }
						outbound={ formatMsgRate( rates.msgOut ) }
					/>
					<Card
						id="total-messages"
						label={ __( 'Total Messages', 'newspack-nodes' ) }
						inbound={ formatCount( totals.msgsIn ) }
						outbound={ formatCount( totals.msgsOut ) }
					/>
					<Card
						id="total-bytes"
						label={ __( 'Total Bytes', 'newspack-nodes' ) }
						inbound={ formatBytes( totals.bytesIn ) }
						outbound={ formatBytes( totals.bytesOut ) }
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
				</div>
				<div className="nodes-debug-overview__charts">
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
			</div>
		</div>
	);
}
