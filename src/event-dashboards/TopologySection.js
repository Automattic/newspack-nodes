/**
 * TopologySection — one topology's section: a header summarizing its per-partition
 * processes (status pill + uptime + heartbeat + restart_pending) with an
 * ALL RUN / ALL DEAD badge and a fleet restart, followed by its node/log tree.
 *
 * The per-partition summary is process-level (one worker per topology+partition),
 * collapsed by `partitionSummaries`. The tree itself is rendered by `TreeEntity`
 * per root entity; fold state is owned by the caller via `collapsed` + `onToggle`.
 */

import { memo } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import TreeEntity from './TreeEntity';
import { partitionSummaries } from './partitionSummaries';
import { formatAge } from './formatters';

const TopologySection = memo( function TopologySection( props ) {
	const { section, workers, currentTime, onRestart } = props;
	const parts = partitionSummaries( workers );
	const allRunning =
		parts.length > 0 && parts.every( ( p ) => p.status === 'running' );
	const allDead =
		parts.length > 0 && parts.every( ( p ) => p.status === 'dead' );
	const anyPending = parts.some( ( p ) => p.restart_pending );

	return (
		<div className={ `topology-section ${ allDead ? 'dead' : '' }` }>
			<div className="topology-header">
				<span className="topology-name">{ section.topology }</span>
				{ parts.map( ( p ) => (
					<span key={ p.partition } className="topology-partition">
						<span
							className={ `worker-status-badge compact ${ p.status }` }
						>
							P{ p.partition }
						</span>
						<span className="supervisor-age">
							{ p.started_at && p.status === 'running'
								? formatAge( p.started_at, currentTime )
								: '' }
						</span>
						{ p.heartbeat_age !== null &&
							p.heartbeat_age !== undefined && (
								<span
									className={ `connector-heartbeat ${
										p.heartbeat_age > 30 ? 'stale' : ''
									}` }
								>
									{ p.heartbeat_age }s
								</span>
							) }
						{ p.restart_pending && (
							<span
								className="connector-restart-pending"
								title={ __(
									'Restart pending',
									'newspack-nodes'
								) }
							>
								⟳
							</span>
						) }
					</span>
				) ) }
				<span className="connector-trailing">
					{ allRunning && (
						<span className="worker-status-badge running small">
							{ __( 'ALL RUN', 'newspack-nodes' ) }
						</span>
					) }
					{ allDead && (
						<span className="worker-status-badge dead small">
							{ __( 'ALL DEAD', 'newspack-nodes' ) }
						</span>
					) }
					{ onRestart && ! allDead && ! anyPending && (
						<button
							type="button"
							className="worker-restart-btn"
							onClick={ () => onRestart( section.topology ) }
							title={ __(
								'Request graceful restart',
								'newspack-nodes'
							) }
						>
							↻
						</button>
					) }
					{ anyPending && (
						<span className="worker-restart-pending-label">
							{ __( 'restarting…', 'newspack-nodes' ) }
						</span>
					) }
				</span>
			</div>
			<div className="topology-body">
				{ section.tree.map( ( entity ) => (
					<TreeEntity
						key={ entity.key }
						{ ...props }
						entity={ entity }
						depth={ 0 }
					/>
				) ) }
			</div>
		</div>
	);
} );

export default TopologySection;
