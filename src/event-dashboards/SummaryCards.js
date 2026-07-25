/**
 * SummaryCards — the fleet-vitals card row shared by the Overview and Topologies
 * hub tabs. One small component, one set of derives, so both tabs show the SAME
 * numbers (topologies/active, worker liveness, on-disk partitions, health, global
 * R/W rates, current backlog, 24h produced totals) with no per-tab drift.
 *
 * All card math lives in pure derives (fleetSummary, probe24hTotals, the
 * formatters); this component is just the presentation + i18n.
 */

import { memo } from '@wordpress/element';
import { __, sprintf, _n } from '@wordpress/i18n';
import { fleetSummary } from './fleetSummary';
import { probe24hTotals } from './probe24hTotals';
import { globalMsgRate } from './globalMsgRate';
import { cacheSizeTotals } from './cacheSizeTotals';
import { backlogTotal } from './backlogTotal';
import {
	formatBytes,
	formatByteRate,
	formatMsgRate,
	formatCount,
} from './formatters';
import './styles/summary-cards.scss';

// One card: a big value + a muted label, keyed by `mod` for styling/tests.
function Card( { mod, value, label, extraClass = '' } ) {
	return (
		<div className={ `nodes-card nodes-card--${ mod }${ extraClass }` }>
			<span className="nodes-card__value">{ value }</span>
			<span className="nodes-card__label">{ label }</span>
		</div>
	);
}

/**
 * @param {Object}  props
 * @param {Array}   props.topologies    Topology rows from useTopologyManager.
 * @param {number}  props.readRate      Fleet-global read bytes/sec.
 * @param {number}  props.writeRate     Fleet-global write bytes/sec.
 * @param {number}  props.logPartitions On-disk log-partition count.
 * @param {?Object} props.consumers     topicprobe:view consumers (24h totals).
 * @return {import('react').ReactElement} The card row.
 */
function SummaryCards( {
	topologies,
	readRate,
	writeRate,
	logPartitions,
	consumers,
} ) {
	const fleet = fleetSummary( topologies );
	const totals = probe24hTotals( consumers );
	const cache = cacheSizeTotals( consumers );

	let healthLabel = __( 'all systems ok', 'newspack-nodes' );
	if ( fleet.stalledCount > 0 ) {
		healthLabel = sprintf(
			// translators: %d: number of stalled topologies.
			_n(
				'%d stalled',
				'%d stalled',
				fleet.stalledCount,
				'newspack-nodes'
			),
			fleet.stalledCount
		);
	} else if ( fleet.behindCount > 0 ) {
		healthLabel = sprintf(
			// translators: %d: number of lagging topologies.
			_n( '%d behind', '%d behind', fleet.behindCount, 'newspack-nodes' ),
			fleet.behindCount
		);
	}

	return (
		<div className="nodes-cards">
			<Card
				mod="topologies"
				value={ sprintf(
					// translators: %1$d: total topologies; %2$d: active count.
					__( '%1$d · %2$d active', 'newspack-nodes' ),
					fleet.topologyCount,
					fleet.activeCount
				) }
				label={ __( 'Topologies', 'newspack-nodes' ) }
			/>
			<Card
				mod="workers"
				value={ sprintf(
					// translators: %1$d: running workers; %2$d: expected workers.
					__( '%1$d / %2$d up', 'newspack-nodes' ),
					fleet.workersUp,
					fleet.workersTotal
				) }
				label={ __( 'Workers', 'newspack-nodes' ) }
			/>
			<Card
				mod="partitions"
				value={ String( logPartitions ?? 0 ) }
				label={ __( 'Partitions', 'newspack-nodes' ) }
			/>
			<Card
				mod="health"
				extraClass={ ` nodes-card--health-${ fleet.health }` }
				value={ healthLabel }
				label={ __( 'Health', 'newspack-nodes' ) }
			/>
			<Card
				mod="read"
				value={ formatByteRate( readRate ) }
				label={ __( 'Read', 'newspack-nodes' ) }
			/>
			<Card
				mod="write"
				value={ formatByteRate( writeRate ) }
				label={ __( 'Write', 'newspack-nodes' ) }
			/>
			<Card
				mod="msgrate"
				value={ formatMsgRate( globalMsgRate( consumers ) ) }
				label={ __( 'Messages/s', 'newspack-nodes' ) }
			/>
			<Card
				mod="backlog"
				value={ formatBytes( backlogTotal( consumers ) ) }
				label={ __( 'Backlog', 'newspack-nodes' ) }
			/>
			<Card
				mod="messages"
				value={ formatCount( totals.msgs ) }
				label={ __( 'Messages · 24h', 'newspack-nodes' ) }
			/>
			<Card
				mod="bytes"
				value={ formatBytes( totals.bytes ) }
				label={ __( 'Bytes · 24h', 'newspack-nodes' ) }
			/>
			<Card
				mod="cache-avg"
				value={ formatBytes( cache.avg ) }
				label={ __( 'Avg Cache', 'newspack-nodes' ) }
			/>
			<Card
				mod="cache-total"
				value={ formatBytes( cache.total ) }
				label={ __( 'Total Cache', 'newspack-nodes' ) }
			/>
		</div>
	);
}

// Memoized: its 24h derives are heavy; Overview re-renders every drag frame.
export default memo( SummaryCards );
