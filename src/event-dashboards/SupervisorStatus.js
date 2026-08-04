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
 * Props for the supervisor status card.
 *
 * @typedef  {Object}   SupervisorStatusProps
 * @property {?Object}  supervisor  Supervisor descriptor from the workers
 *                                  snapshot: `status`, `started_at`,
 *                                  `heartbeat_age`, `restart_pending`. Null
 *                                  renders nothing.
 * @property {number}   currentTime Current time in unix seconds; uptime is its
 *                                  distance from `started_at`.
 * @property {Function} onRestart   Called with `'supervisor'` to request a
 *                                  graceful restart. Falsy hides the button.
 */

/**
 * Supervisor status row.
 *
 * @param {SupervisorStatusProps} props Component props.
 * @return {?import('react').ReactElement} The card, or null with no supervisor.
 */
export const SupervisorStatus = memo( function SupervisorStatus(
	/** @type {SupervisorStatusProps} */ { supervisor, currentTime, onRestart }
) {
	if ( ! supervisor ) {
		return null;
	}

	const isDead = supervisor.status === 'dead';

	return (
		<div className="supervisor-section">
			<div className="supervisor-list">
				<div className={ `supervisor-row ${ isDead ? 'dead' : '' }` }>
					<span className="supervisor-name">
						{ __( 'Supervisor', 'newspack-nodes' ) }
					</span>
					<div className="supervisor-instance">
						<span
							className={ `newspack-nodes-status-badge worker-status-badge compact ${ supervisor.status }` }
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
									className="nodes-ctl__restart button button-small"
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
