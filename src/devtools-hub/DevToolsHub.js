/**
 * The full-page DevTools hub host. Renders the ONE shared brand header on top,
 * the `hub`-scope tabs (through the shared DevtoolsTabHost) below it, and the
 * floating debug overlay — inside a fixed, full-height admin-page container
 * (mirroring WorkerStatusPage) so a full-screen tab (the Console's CanvasFrame)
 * gets usable height. The header is brand-only; each tab's own controls (the
 * Console's path/edit/LIVE cluster) stay inside that tab. Empty state until a
 * plugin registers a hub tab. Capability-gating is the admin page's concern.
 *
 * Themed via the global skin: the hub is wrapped in the canonical non-graph
 * skin/UI provider, and the live skin is the single `theme-<slug>` class on
 * `<html>` (see shared/theme.js).
 */
import { useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import DevtoolsTabHost from '@newspack-nodes/shared/devtools/DevtoolsTabHost';
import useAdminMenuWidth from '@newspack-nodes/shared/hooks/useAdminMenuWidth';
import Header from '../topology-console/components/Header';
import DebugOverlay from '../debug-overlay/DebugOverlay';
import { registerLazyTabs } from './lazyTabs';
import './devtools-hub.scss';

// Overlay rides every tab; Console uses buildRepl=false (`_output` clash).
const CONSOLE_TAB_ID = 'topology-console';

// Runs after event-dashboards (enqueued first) registered the order-0 Overview.
registerLazyTabs();

/**
 * Renders the hub page: the shared brand header, the `hub`-scope tab host, and
 * the debug overlay, inside a fixed container that starts below the admin bar
 * and to the right of the (possibly collapsed) admin menu.
 *
 * @return {import('react').ReactElement} The hub page.
 */
export default function DevToolsHub() {
	const menuWidth = useAdminMenuWidth();
	const [ activeTabId, setActiveTabId ] = useState( null );
	// The active tab portals its own controls into this shared-header slot.
	const [ controlsSlot, setControlsSlot ] = useState( null );

	return (
		// Boxless provider: skin tokens + shared UI, without graph layout.
		<div
			className="newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui"
			style={ { display: 'contents' } }
		>
			<div
				className="nodes-devtools-hub"
				style={
					/** @type {import('react').CSSProperties} */ ( {
						position: 'fixed',
						top: '32px',
						left: `${ menuWidth }px`,
						right: '0',
						bottom: '0',
						zIndex: 99,
						// Opaque --paper-3: parent boxless, else bleeds white.
						background: 'var(--paper-3)',
						'--nodes-devtools-fg': 'var(--ink)',
						transition: 'left 0.1s ease-in-out',
						margin: 0,
						padding: 0,
						boxSizing: 'border-box',
						display: 'flex',
						flexDirection: 'column',
						overflow: 'hidden',
					} )
				}
			>
				{ /* ONE shared header — brand left, controls slot right. */ }
				<Header controlsSlotRef={ setControlsSlot } />
				<DevtoolsTabHost
					host="hub"
					syncUrl
					onActiveTabChange={ setActiveTabId }
					tabProps={ {
						headerControlsSlot: controlsSlot,
					} }
					emptyState={
						<p className="newspack-nodes-empty-state nodes-devtools__empty">
							{ __(
								'No tools registered yet.',
								'newspack-nodes'
							) }
						</p>
					}
				/>
				{ activeTabId && (
					<DebugOverlay
						storageKey={ `newspack-nodes:debug:hub:${ activeTabId }` }
						buildRepl={ CONSOLE_TAB_ID !== activeTabId }
					/>
				) }
			</div>
		</div>
	);
}
