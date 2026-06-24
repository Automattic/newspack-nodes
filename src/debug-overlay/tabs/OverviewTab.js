import { useEffect } from '@wordpress/element';
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
// The Overview tab reuses the hub's card + overview LAYOUT classes
// (`.nodes-card(s)`, `.nodes-overview(__panels)`), whose styles live in the
// event-dashboards bundle. The hub page loads that bundle; pages that merely
// EMBED the overlay don't — so import the styles here to ship them in whatever
// bundle carries this tab, keeping the overlay self-contained anywhere.
import '../../event-dashboards/styles/summary-cards.scss';
import '../../event-dashboards/styles/overview.scss';

// One metric card — the same `.nodes-card` markup the hub SummaryCards uses, so
// it inherits the existing card styling (no overlay-specific stylesheet).
function Card( { id, label, value } ) {
	return (
		<div
			className={ `nodes-card nodes-card--${ id }` }
			data-testid={ `overview-card-${ id }` }
		>
			<span className="nodes-card__value">{ value }</span>
			<span className="nodes-card__label">{ label }</span>
		</div>
	);
}

// Compact in/out value for a single card: ↓ inbound · ↑ outbound.
function inOut( inbound, outbound ) {
	return `↓ ${ inbound }  ↑ ${ outbound }`;
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

	return (
		// Fullbleed scrolling body on the hub's Newspack surface. The flex/overflow
		// is layout plumbing only — every visual rule comes from the reused classes.
		<div
			data-testid="overview-tab"
			className="nodes-overview"
			style={ {
				flex: 1,
				minHeight: 0,
				overflowY: 'auto',
				background: 'var(--np-surface-subtle, #fff)',
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
		</div>
	);
}
