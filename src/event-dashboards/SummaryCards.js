/**
 * The fleet-vitals card row across the top of the Overview station tab:
 * topology and active counts, worker liveness, on-disk partitions, worst
 * health, global read and write rates, current message rate and backlog, the
 * 24h totals, the total offsetlog cache size, and the partitions' total size
 * and the disk it takes.
 *
 * Every number is computed outside this component. `readRate`, `writeRate` and
 * `logPartitions` arrive as props from `useTopologyManager`; the pure
 * modules beside this one — `fleetSummary`, `probe24hTotals` and `liveTotal`
 * — roll the topology rows and the `topicprobe:view` consumers and partitions
 * up into the rest, and the shared formatters turn
 * each figure into its display string. What is left here is the layout and the
 * translated labels, which is what lets a card's rule be tested without
 * rendering anything.
 *
 * Every card is a sum. A reader card sums per reader, co-readers of one
 * partition each counted, so the message and 24h cards say "read": a log two
 * workers read counts twice there. The Write card counts each partition's
 * head once, so it is the one bytes-written figure.
 * The "Msgs read/s", "Backlog" and "Total Cache" cards are LIVE: each sums
 * every live reader's newest sample, the same series its Overview chart
 * stacks, counting a reader only while it names a source and that sample is
 * within a minute of the newest message seen (`streamHead`, `liveTotal`).
 * "Total Size" and "Total On Disk" apply the same rule per partition: each
 * live partition's newest reading counts once, whichever worker took it.
 * The 24h read cards sum every reader's consumption over every retained bucket.
 */

import { memo } from '@wordpress/element';
import { __, sprintf, _n } from '@wordpress/i18n';
import { fleetSummary } from './fleetSummary';
import { probe24hTotals } from './probe24hTotals';
import { liveTotal, streamHead } from './liveSample';
import {
	formatBytes,
	formatByteRate,
	formatMsgRate,
	formatCount,
} from '@newspack-nodes/shared/utils/formatters';
import { StatTile, StatTiles } from '@newspack-nodes/shared/blocks/stats';
import './styles/summary-cards.scss';

/**
 * Render the card row.
 *
 * Every card is the shared `StatTile`. Health is the one card that says more
 * than a number: it reports the worst level among the ACTIVE topologies and
 * how many sit there ("2 stalled"), and tints itself through a
 * `nodes-card--health-{level}` modifier. Stalled outranks behind, so a fleet
 * carrying both reports the stalled count; a fleet with neither reads "ok".
 *
 * @param {Object}  props
 * @param {?Array}  props.topologies    Topology rows from `useTopologyManager`.
 * @param {number}  props.readRate      Fleet-global read bytes/sec.
 * @param {number}  props.writeRate     Fleet-global write bytes/sec.
 * @param {?number} props.logPartitions On-disk log-partition count; absent renders 0.
 * @param {?Object} props.consumers     The `topicprobe:view` consumers map behind the rate, backlog, cache and 24h cards.
 * @param {?Object} props.partitions    The `topicprobe:view` partitions map behind the size and disk cards.
 * @return {import('react').ReactElement} The card row.
 */
function SummaryCards( {
	topologies,
	readRate,
	writeRate,
	logPartitions,
	consumers,
	partitions,
} ) {
	const fleet = fleetSummary( topologies );
	const totals = probe24hTotals( consumers );
	const headS = streamHead( consumers );
	const partitionHeadS = streamHead( partitions );

	/** @type {string} */
	let healthLabel = __( 'ok', 'newspack-nodes' );
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
		<StatTiles>
			<StatTile
				id="topologies"
				value={ sprintf(
					// translators: %1$d: total topologies; %2$d: active count.
					__( '%1$d · %2$d active', 'newspack-nodes' ),
					fleet.topologyCount,
					fleet.activeCount
				) }
				label={ __( 'Topologies', 'newspack-nodes' ) }
			/>
			<StatTile
				id="workers"
				value={ sprintf(
					// translators: %1$d: running workers; %2$d: expected workers.
					__( '%1$d / %2$d up', 'newspack-nodes' ),
					fleet.workersUp,
					fleet.workersTotal
				) }
				label={ __( 'Workers', 'newspack-nodes' ) }
			/>
			<StatTile
				id="partitions"
				value={ String( logPartitions ?? 0 ) }
				label={ __( 'Partitions', 'newspack-nodes' ) }
			/>
			<StatTile
				id="health"
				className={ `nodes-card--health-${ fleet.health }` }
				value={ healthLabel }
				label={ __( 'Health', 'newspack-nodes' ) }
			/>
			<StatTile
				id="read"
				value={ formatByteRate( readRate ) }
				label={ __( 'Read', 'newspack-nodes' ) }
			/>
			<StatTile
				id="write"
				value={ formatByteRate( writeRate ) }
				label={ __( 'Write', 'newspack-nodes' ) }
			/>
			<StatTile
				id="msgrate"
				value={ formatMsgRate(
					liveTotal( consumers, headS, 'msgRate' )
				) }
				label={ __( 'Msgs read/s', 'newspack-nodes' ) }
			/>
			<StatTile
				id="backlog"
				value={ formatBytes(
					liveTotal( consumers, headS, 'backlog' )
				) }
				label={ __( 'Backlog', 'newspack-nodes' ) }
			/>
			<StatTile
				id="messages"
				value={ formatCount( totals.msgs ) }
				label={ __( 'Msgs read · 24h', 'newspack-nodes' ) }
			/>
			<StatTile
				id="bytes"
				value={ formatBytes( totals.bytes ) }
				label={ __( 'Bytes read · 24h', 'newspack-nodes' ) }
			/>
			<StatTile
				id="cache-total"
				value={ formatBytes(
					liveTotal( consumers, headS, 'cacheSize' )
				) }
				label={ __( 'Total Cache', 'newspack-nodes' ) }
			/>
			<StatTile
				id="size-total"
				value={ formatBytes(
					liveTotal( partitions, partitionHeadS, 'endBytes' )
				) }
				label={ __( 'Total Size', 'newspack-nodes' ) }
			/>
			<StatTile
				id="disk-total"
				value={ formatBytes(
					liveTotal( partitions, partitionHeadS, 'diskBytes' )
				) }
				label={ __( 'Total On Disk', 'newspack-nodes' ) }
			/>
		</StatTiles>
	);
}

// Memoized: its 24h derives are heavy; Overview re-renders every drag frame.
export default memo( SummaryCards );
