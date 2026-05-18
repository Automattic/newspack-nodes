/**
 * Raw Logs Page Component
 *
 * Full-page view for browsing raw log files.
 */

import RawLogs from './RawLogs';
import useAdminMenuWidth from '../shared/hooks/useAdminMenuWidth';

/**
 * Raw Logs page - dedicated view for raw log file content.
 *
 * @return {import('react').ReactElement} Rendered component.
 */
export default function RawLogsPage() {
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
				overflowY: 'hidden',
			} }
		>
			<RawLogs />
		</div>
	);
}
