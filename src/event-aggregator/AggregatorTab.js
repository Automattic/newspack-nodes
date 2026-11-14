/**
 * The Aggregator station tab, a composed page on `StationLayout` over this
 * bundle's views: the hub's screen for every spoke whose log it pulls.
 *
 * Its controls in the station header say when the summary last answered,
 * how many spokes are up, and pick the cadence both polls ask at, which the
 * browser keeps. The age of the last answer re-renders on a one-second tick
 * that asks the server for nothing.
 */

import { useCallback, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { usePageState } from '@newspack-nodes/shared/composition/page/pageState';
import { useSource } from '@newspack-nodes/shared/sources';
import RefreshPicker from '@newspack-nodes/shared/components/RefreshPicker';
import useRouterTick from '@newspack-nodes/shared/hooks/useRouterTick';
import { writeStorage } from '@newspack-nodes/shared/utils/storage';
import StationLayout from '../station/StationLayout';
import { formatTime } from './blocks/server-cards';
import { BLOCK_VIEWS, REFRESH_KEY, REFRESH_OPTIONS } from './aggregatorSources';

/**
 * The header strip: the last answer's age, the spokes up, and the cadence.
 *
 * @return {import('react').ReactElement} The strip.
 */
function Controls() {
	const [ refresh, setRefresh ] = usePageState( 'refresh', {
		writes: true,
	} );
	const summary = useSource( 'nodes/aggregator-summary' );
	const servers = useSource( 'nodes/aggregator-servers' );
	const [ , setTick ] = useState( 0 );
	const bumpClock = useCallback( () => setTick( ( t ) => t + 1 ), [] );
	useRouterTick( { name: 'aggregator-clock:timer', onTick: bumpClock } );
	const {
		connected = 0,
		idle = 0,
		total = 0,
		lastRefresh = null,
	} = summary.model ?? {};
	const pick = ( next ) => {
		writeStorage( REFRESH_KEY, next );
		setRefresh( next );
	};
	return (
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
			{ servers.model?.servers && (
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
			<RefreshPicker
				value={ refresh }
				options={ REFRESH_OPTIONS }
				onChange={ pick }
			/>
		</div>
	);
}

/**
 * The Aggregator tab.
 *
 * @param {Object}   props                      Component props.
 * @param {?Element} [props.headerControlsSlot] The station header's slot.
 * @return {import('react').ReactElement} The tab.
 */
export function AggregatorTab( { headerControlsSlot } ) {
	return (
		<StationLayout
			page="station-aggregator"
			views={ BLOCK_VIEWS }
			headerControlsSlot={ headerControlsSlot }
			controls={ <Controls /> }
		/>
	);
}
