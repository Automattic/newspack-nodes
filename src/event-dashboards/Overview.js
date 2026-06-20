/**
 * Overview — the hub's at-a-glance landing tab (the default first paint). A thin
 * view over useTopologyManager: a topology-count summary + supervisor card, then
 * a card per topology (health/state badge + console "open"/"edit" deep-links) and
 * a New-Topology link. Deliberately lighter than the Topologies tab — it's the
 * glance + navigation surface, not the full live-tree manager. Reuses the same
 * `consoleHref` deep-links so the hub's navigation stays single-sourced.
 */

import { __, sprintf, _n } from '@wordpress/i18n';
import ConnectionBanner from '@newspack-nodes/shared/components/ConnectionBanner';
import { useTopologyManager } from './hooks/useTopologyManager';
import { SupervisorStatus } from './SupervisorStatus';
import { consoleHref } from './TopologyManager';
import './styles/overview.scss';

// Health → label (only shown for active topologies; a stopped one reports state).
const HEALTH_LABELS = {
	ok: __( 'ok', 'newspack-nodes' ),
	behind: __( 'behind', 'newspack-nodes' ),
	stalled: __( 'stalled', 'newspack-nodes' ),
};

/**
 * Overview hub tab.
 *
 * @return {import('react').ReactElement} Rendered component.
 */
export default function Overview() {
	const { topologies, supervisor, currentTime, restart, connected } =
		useTopologyManager();
	const activeCount = topologies.filter( ( t ) => t.active ).length;
	// Active first, then alphabetical — the running topologies are what you
	// glance at first.
	const sorted = [ ...topologies ].sort( ( a, b ) => {
		const aActive = !! a.active;
		const bActive = !! b.active;
		if ( aActive !== bActive ) {
			return aActive ? -1 : 1;
		}
		return a.name.localeCompare( b.name );
	} );

	return (
		<div className="nodes-overview">
			<ConnectionBanner
				connectionError={ ! connected }
				message={ __( 'Disconnected — retrying…', 'newspack-nodes' ) }
			/>
			<div className="nodes-overview__toolbar">
				<span className="nodes-overview__summary">
					{ sprintf(
						// translators: %1$d: total topologies; %2$d: active count.
						_n(
							'%1$d topology · %2$d active',
							'%1$d topologies · %2$d active',
							topologies.length,
							'newspack-nodes'
						),
						topologies.length,
						activeCount
					) }
				</span>
				<a
					className="nodes-overview__new"
					href={ consoleHref( '', { isNew: true } ) }
					title={ __(
						'Create a new topology in the console',
						'newspack-nodes'
					) }
				>
					{ __( '+ New Topology', 'newspack-nodes' ) }
				</a>
			</div>
			{ supervisor && (
				<SupervisorStatus
					supervisor={ supervisor }
					currentTime={ currentTime }
					onRestart={ () => restart( 'supervisor' ) }
				/>
			) }
			<div className="nodes-overview__grid">
				{ sorted.map( ( t ) => (
					<div key={ t.name } className="nodes-overview__card">
						<a
							className="nodes-overview__name"
							href={ consoleHref( t.name ) }
						>
							{ t.name }
						</a>
						{ t.active ? (
							<span
								className={ `nodes-overview__health nodes-overview__health--${ t.health }` }
							>
								{ HEALTH_LABELS[ t.health ] ?? t.health }
							</span>
						) : (
							<span className="nodes-overview__state">
								{ __( 'stopped', 'newspack-nodes' ) }
							</span>
						) }
						<a
							className="nodes-overview__edit"
							href={ consoleHref( t.name, { edit: true } ) }
							title={ __(
								'Edit this topology in the console',
								'newspack-nodes'
							) }
						>
							{ __( 'Edit', 'newspack-nodes' ) }
						</a>
					</div>
				) ) }
			</div>
		</div>
	);
}
