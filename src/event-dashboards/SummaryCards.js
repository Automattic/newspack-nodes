/**
 * The fleet-vitals card row across the top of the Overview hub tab: topology and
 * active counts, worker liveness, on-disk partitions, worst health, global read
 * and write rates, current message rate and backlog, the 24h produced totals,
 * and offsetlog cache size.
 *
 * Every number is computed outside this component. `readRate`, `writeRate` and
 * `logPartitions` arrive as props from `useTopologyManager`; the five pure
 * modules beside this one — `fleetSummary`, `probe24hTotals`, `globalMsgRate`,
 * `cacheSizeTotals` and `backlogTotal` — roll the topology rows and the
 * `topicprobe:view` consumers up into the rest, and the shared formatters turn
 * each figure into its display string. What is left here is the layout and the
 * translated labels, which is what lets a card's rule be tested without
 * rendering anything. Those rules differ card by card — the rate cards dedup
 * co-readers of one source, the backlog and cache cards sum per reader — and
 * each derive's own header says why.
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
} from '@newspack-nodes/shared/utils/formatters';
import './styles/summary-cards.scss';

/**
 * One card: a big value over a muted label.
 *
 * `mod` is the card's identity, naming both the BEM modifier the stylesheet
 * targets and the selector the unit tests query, so the two move together.
 * Both class names are load-bearing: `newspack-nodes-card` is the shared
 * surface — background, border, radius — every Newspack card wears, and
 * `nodes-card` carries this row's own layout and typography.
 *
 * @param {Object} props
 * @param {string} props.mod          Card identity, appended to `nodes-card--`.
 * @param {string} props.value        The big value line, already formatted.
 * @param {string} props.label        The muted caption beneath it.
 * @param {string} [props.extraClass] Further classes, concatenated verbatim, so a caller supplies its own leading space.
 * @return {import('react').ReactElement} The card.
 */
function Card( { mod, value, label, extraClass = '' } ) {
	return (
		<div
			className={ `newspack-nodes-card nodes-card nodes-card--${ mod }${ extraClass }` }
		>
			<span className="nodes-card__value">{ value }</span>
			<span className="nodes-card__label">{ label }</span>
		</div>
	);
}

/**
 * Render the card row.
 *
 * Health is the one card that says more than a number: it reports the worst
 * level among the ACTIVE topologies and how many sit there ("2 stalled"), and
 * tints itself through a `nodes-card--health-{level}` modifier. Stalled
 * outranks behind, so a fleet carrying both reports the stalled count; a fleet
 * with neither reads "all systems ok".
 *
 * @param {Object}  props
 * @param {?Array}  props.topologies    Topology rows from `useTopologyManager`.
 * @param {number}  props.readRate      Fleet-global read bytes/sec.
 * @param {number}  props.writeRate     Fleet-global write bytes/sec.
 * @param {?number} props.logPartitions On-disk log-partition count; absent renders 0.
 * @param {?Object} props.consumers     The `topicprobe:view` consumers map behind the rate, backlog, cache and 24h cards.
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

	/** @type {string} */
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
