/**
 * The Overview, Jobs and Tables station tabs, each a composed page on
 * `StationLayout` over this bundle's views: what each page shows is its
 * layout, and the chrome above it says what the page could not read.
 *
 * The Overview puts **+ New Topology** in the station header and, above its
 * layout, the board's connection banner and what the board and the topic
 * probe could not read. Jobs and Tables say which lines of their probe logs
 * would not parse.
 */

import { __, sprintf } from '@wordpress/i18n';
import ConnectionBanner from '@newspack-nodes/shared/components/ConnectionBanner';
import UnparseableLinesNotice from '@newspack-nodes/shared/components/UnparseableLinesNotice';
import UnreadableNotice from '@newspack-nodes/shared/components/UnreadableNotice';
import StationLayout from '../station/StationLayout';
import { useConnected, useTopologyBoard } from './hooks/useTopologyManager';
import { consoleHref } from './TopologyRow';
import { BLOCK_VIEWS, PROBE_LOGS } from './views';

/**
 * What the fleet board and the topic probe could not read.
 *
 * @return {import('react').ReactElement} The notices.
 */
function OverviewNotices() {
	const board = useTopologyBoard();
	const connected = useConnected( board );
	return (
		<>
			<ConnectionBanner
				connectionError={ ! connected }
				message={ __( 'Disconnected — retrying…', 'newspack-nodes' ) }
			/>
			<UnreadableNotice
				failures={ board.unreadable }
				describe={ ( name, message ) =>
					sprintf(
						// translators: 1: topology name, 2: why it will not read.
						__(
							'Topology %1$s will not read, so this board leaves it out: %2$s',
							'newspack-nodes'
						),
						name,
						message
					)
				}
			/>
			<UnreadableNotice
				failures={ board.refusedProducers }
				describe={ ( name, message ) =>
					sprintf(
						// translators: 1: log producer template, 2: why it was refused.
						__(
							'The log catalog leaves out %1$s, and the log sweep refuses to run: %2$s',
							'newspack-nodes'
						),
						name,
						message
					)
				}
			/>
			<UnparseableLinesNotice
				source={ __( 'Consumer rows', 'newspack-nodes' ) }
				count={ board.unparseableLines }
			/>
			<UnparseableLinesNotice
				source={ __( 'Topics charts', 'newspack-nodes' ) }
				subscribe={ [ PROBE_LOGS.topicprobe ] }
			/>
		</>
	);
}

/**
 * The Overview tab.
 *
 * @param {Object}   props                      Component props.
 * @param {?Element} [props.headerControlsSlot] The station header's slot.
 * @return {import('react').ReactElement} The tab.
 */
export function OverviewTab( { headerControlsSlot } ) {
	return (
		<StationLayout
			page="station-overview"
			views={ BLOCK_VIEWS }
			headerControlsSlot={ headerControlsSlot }
			controls={
				<a
					className="nodes-cards__new button"
					href={ consoleHref( '', { isNew: true } ) }
				>
					{ __( '+ New Topology', 'newspack-nodes' ) }
				</a>
			}
		>
			<OverviewNotices />
		</StationLayout>
	);
}

/**
 * The Jobs tab.
 *
 * @param {Object}   props                      Component props.
 * @param {?Element} [props.headerControlsSlot] The station header's slot.
 * @return {import('react').ReactElement} The tab.
 */
export function JobsTab( { headerControlsSlot } ) {
	return (
		<StationLayout
			page="station-jobs"
			views={ BLOCK_VIEWS }
			headerControlsSlot={ headerControlsSlot }
		>
			<UnparseableLinesNotice
				source={ __( 'Job statistics', 'newspack-nodes' ) }
				subscribe={ [ PROBE_LOGS.jobstats ] }
			/>
			<UnparseableLinesNotice
				source={ __( 'Job backlog', 'newspack-nodes' ) }
				subscribe={ [ PROBE_LOGS.topicprobe ] }
			/>
		</StationLayout>
	);
}

/**
 * The Tables tab.
 *
 * @param {Object}   props                      Component props.
 * @param {?Element} [props.headerControlsSlot] The station header's slot.
 * @return {import('react').ReactElement} The tab.
 */
export function TablesTab( { headerControlsSlot } ) {
	return (
		<StationLayout
			page="station-tables"
			views={ BLOCK_VIEWS }
			headerControlsSlot={ headerControlsSlot }
		>
			<UnparseableLinesNotice
				source={ __( 'Table statistics', 'newspack-nodes' ) }
				subscribe={ [ PROBE_LOGS.tablestats ] }
			/>
		</StationLayout>
	);
}
