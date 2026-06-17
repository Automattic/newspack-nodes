/**
 * SupervisorStatus — the supervisor status card.
 *
 * Shared by the worker-status tree (WorkerStatus.js) and the Topology Manager.
 * Extracted from WorkerStatus.js so the manager doesn't depend on that module.
 */

import { memo } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { formatAge } from './formatters';

/**
 * Supervisor status row.
 *
 * @param {Object}   props             Component props.
 * @param {Object}   props.supervisor  Supervisor status descriptor.
 * @param {number}   props.currentTime Current timestamp for age calculation.
 * @param {Function} props.onRestart   Callback to restart the supervisor.
 * @return {import('react').ReactElement} Rendered component.
 */
export const SupervisorStatus = memo( function SupervisorStatus( {
	supervisor,
	currentTime,
	onRestart,
} ) {
	if ( ! supervisor ) {
		return null;
	}

	const isDead = supervisor.status === 'dead';

	return (
		<div className="supervisor-section">
			<div className="supervisor-header">
				<span className="supervisor-title">
					{ __( 'Supervisor', 'newspack-nodes' ) }
				</span>
			</div>
			<div className="supervisor-list">
				<div className={ `supervisor-row ${ isDead ? 'dead' : '' }` }>
					<span className="supervisor-name">
						{ __( 'Supervisor', 'newspack-nodes' ) }
					</span>
					<div className="supervisor-instance">
						<span
							className={ `worker-status-badge compact ${ supervisor.status }` }
						>
							{ supervisor.status === 'running'
								? __( 'RUN', 'newspack-nodes' )
								: __( 'DEAD', 'newspack-nodes' ) }
						</span>
						<span
							className="supervisor-age"
							title={ __( 'Uptime', 'newspack-nodes' ) }
						>
							{ supervisor.started_at &&
							supervisor.status === 'running'
								? formatAge(
										supervisor.started_at,
										currentTime
								  )
								: '' }
						</span>
						{ supervisor.heartbeat_age !== null &&
							supervisor.heartbeat_age !== undefined && (
								<span
									className={ `connector-heartbeat ${
										supervisor.heartbeat_age > 30
											? 'stale'
											: ''
									}` }
									title={ __(
										'Heartbeat age',
										'newspack-nodes'
									) }
								>
									{ supervisor.heartbeat_age }s
								</span>
							) }
						{ supervisor.restart_pending && (
							<span
								className="connector-restart-pending"
								title="Restart pending"
							>
								⟳
							</span>
						) }
					</div>
					<span className="connector-trailing">
						{ onRestart &&
							! isDead &&
							! supervisor.restart_pending && (
								<button
									type="button"
									className="nodes-tm__restart"
									onClick={ () => onRestart( 'supervisor' ) }
									title={ __(
										'Request graceful restart',
										'newspack-nodes'
									) }
								>
									↻
								</button>
							) }
						{ supervisor.restart_pending && (
							<span className="worker-restart-pending-label">
								{ __( 'restarting…', 'newspack-nodes' ) }
							</span>
						) }
					</span>
				</div>
			</div>
		</div>
	);
} );
