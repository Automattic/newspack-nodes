/**
 * The full-page DevTools hub host. Renders the `hub`-scope tabs through the
 * shared DevtoolsTabHost inside a fixed, full-height admin-page container
 * (mirroring WorkerStatusPage) so a full-screen tab — the Topology Console's
 * CanvasFrame — gets usable height. Empty state until a plugin registers a hub
 * tab. Capability-gating is the admin page's concern (server-side); this
 * component just renders.
 */
import { useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import DevtoolsTabHost from '@newspack-nodes/shared/devtools/DevtoolsTabHost';
import useAdminMenuWidth from '@newspack-nodes/shared/hooks/useAdminMenuWidth';
import DebugOverlay from '../debug-overlay/DebugOverlay';
import './devtools-hub.scss';

// The Console tab IS a live-graph view; mounting the floating overlay there
// nests a console-in-a-console (and binds to no interpreter). Gate the overlay
// to every OTHER hub tab — the manager mounts the canonical
// `_command_interpreter` exospine, giving the overlay's REPL a real backbone.
const CONSOLE_TAB_ID = 'topology-console';

export default function DevToolsHub() {
	const menuWidth = useAdminMenuWidth();
	const [ activeTabId, setActiveTabId ] = useState( null );

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
				background: '#1e1e1e',
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
				syncUrl
				onActiveTabChange={ setActiveTabId }
				emptyState={
					<p className="nodes-devtools__empty">
						{ __( 'No tools registered yet.', 'newspack-nodes' ) }
					</p>
				}
			/>
			{ activeTabId && CONSOLE_TAB_ID !== activeTabId && (
				<DebugOverlay
					storageKey={ `newspack-nodes:debug:hub:${ activeTabId }` }
				/>
			) }
		</div>
	);
}
