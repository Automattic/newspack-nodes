/**
 * The full-page DevTools hub host. Renders the ONE shared brand header on top,
 * the `hub`-scope tabs (through the shared DevtoolsTabHost) below it, and the
 * floating debug overlay — inside a fixed, full-height admin-page container
 * (mirroring WorkerStatusPage) so a full-screen tab (the Console's CanvasFrame)
 * gets usable height. The header is brand-only; each tab's own controls (the
 * Console's path/edit/LIVE cluster) stay inside that tab. Empty state until a
 * plugin registers a hub tab. Capability-gating is the admin page's concern.
 *
 * Themed via the global skin: the hub is wrapped in a `.topology-app` token
 * context, and the live skin is the single `theme-<slug>` class on `<html>`
 * (see shared/theme.js), so its chrome reads --paper / --ink from the CSS
 * `.theme-<slug> .topology-app` scope — a `set_skin` on ANY surface re-skins it.
 */
import { useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import DevtoolsTabHost from '@newspack-nodes/shared/devtools/DevtoolsTabHost';
import useAdminMenuWidth from '@newspack-nodes/shared/hooks/useAdminMenuWidth';
import Header from '../topology-console/components/Header';
import DebugOverlay from '../debug-overlay/DebugOverlay';
import './devtools-hub.scss';

// The overlay rides every hub tab, Overview-only on the Console tab
// (buildRepl=false) since its own REPL would collide on `_output`.
const CONSOLE_TAB_ID = 'topology-console';

export default function DevToolsHub() {
	const menuWidth = useAdminMenuWidth();
	const [ activeTabId, setActiveTabId ] = useState( null );
	// The active tab portals its own controls into this shared-header slot.
	const [ controlsSlot, setControlsSlot ] = useState( null );

	return (
		// display:contents token host so the hub chrome resolves the live skin.
		<div
			className="topology-app newspack-nodes-theme"
			style={ { display: 'contents' } }
		>
			<div
				className="nodes-devtools-hub newspack-nodes-theme"
				style={ {
					position: 'fixed',
					top: '32px',
					left: `${ menuWidth }px`,
					right: '0',
					bottom: '0',
					zIndex: 99,
					// `--paper-3` (opaque base) not `--paper`: the display:contents
					// parent has no box, so a translucent skin would bleed wp-admin white.
					background: 'var(--paper-3)',
					'--nodes-devtools-fg': 'var(--ink)',
					transition: 'left 0.1s ease-in-out',
					margin: 0,
					padding: 0,
					boxSizing: 'border-box',
					display: 'flex',
					flexDirection: 'column',
					overflow: 'hidden',
				} }
			>
				{ /* The ONE shared header — brand left, controls slot right. */ }
				<Header controlsSlotRef={ setControlsSlot } />
				<DevtoolsTabHost
					host="hub"
					syncUrl
					onActiveTabChange={ setActiveTabId }
					tabProps={ {
						headerControlsSlot: controlsSlot,
					} }
					emptyState={
						<p className="nodes-devtools__empty">
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
