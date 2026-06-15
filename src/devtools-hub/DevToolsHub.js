/**
 * The full-page DevTools hub host. Renders the `hub`-scope tabs through the
 * shared DevtoolsTabHost inside a fixed, full-height admin-page container
 * (mirroring WorkerStatusPage) so a full-screen tab — the Topology Console's
 * CanvasFrame — gets usable height. Empty state until a plugin registers a hub
 * tab. Capability-gating is the admin page's concern (server-side); this
 * component just renders.
 */
import { __ } from '@wordpress/i18n';
import DevtoolsTabHost from '@newspack-nodes/shared/devtools/DevtoolsTabHost';
import useAdminMenuWidth from '@newspack-nodes/shared/hooks/useAdminMenuWidth';
import './devtools-hub.scss';

export default function DevToolsHub() {
	const menuWidth = useAdminMenuWidth();

	return (
		<div
			className="nodes-devtools-hub"
			style={ {
				position: 'fixed',
				top: '32px',
				left: `${ menuWidth }px`,
				right: '0',
				bottom: '0',
				zIndex: 99,
				transition: 'left 0.1s ease-in-out',
				margin: 0,
				padding: 0,
				boxSizing: 'border-box',
				display: 'flex',
				flexDirection: 'column',
				overflow: 'hidden',
			} }
		>
			<DevtoolsTabHost
				host="hub"
				emptyState={
					<p className="nodes-devtools__empty">
						{ __( 'No tools registered yet.', 'newspack-nodes' ) }
					</p>
				}
			/>
		</div>
	);
}
