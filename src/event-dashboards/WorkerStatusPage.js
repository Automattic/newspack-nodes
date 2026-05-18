/**
 * Worker Status Page Component
 *
 * Full-page view for worker status monitoring.
 */

import WorkerStatus from './WorkerStatus';
import useAdminMenuWidth from '../shared/hooks/useAdminMenuWidth';

/**
 * Worker Status page - dedicated view for worker monitoring.
 *
 * @return {import('react').ReactElement} Rendered component.
 */
export default function WorkerStatusPage() {
	const menuWidth = useAdminMenuWidth();

	return (
		<div
			style={ {
				position: 'fixed',
				top: '32px',
				left: `${ menuWidth }px`,
				right: '0',
				bottom: '0',
				zIndex: 99,
				background: '#1e1e1e',
				transition: 'left 0.1s ease-in-out',
				margin: 0,
				padding: 0,
				boxSizing: 'border-box',
				overflowX: 'hidden',
				overflowY: 'auto',
			} }
		>
			<WorkerStatus refreshMs={ 2000 } fullPage />
		</div>
	);
}
