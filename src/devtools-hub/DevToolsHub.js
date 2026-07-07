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

// The overlay rides EVERY hub tab — its Overview tab shows the browser's own I/O
// while the Console shows a worker. On the Console tab it runs Overview-only
// (`buildRepl={false}`): the Console already IS a live graph+REPL, and a second
// overlay REPL would collide on the shared `_output` infra. The Inspector body
// builds no infra there and points back at the Console (see InspectorTab).
const CONSOLE_TAB_ID = 'topology-console';

export default function DevToolsHub() {
	const menuWidth = useAdminMenuWidth();
	const [ activeTabId, setActiveTabId ] = useState( null );
	// The active tab portals its own controls into this slot on the right of the
	// shared header (setState-as-callback-ref re-renders once the node mounts).
	const [ controlsSlot, setControlsSlot ] = useState( null );

	return (
		// display:contents token-provider so the hub + its chrome resolve the live
		// skin's --paper/--ink (from the global `<html>.theme-<slug>` scope); no
		// box, so the fixed layout is intact.
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
					// Theme tokens, independent of the WP admin color scheme — the
					// hub is a themed product surface; the tab bar's
					// `--nodes-devtools-fg` follows the ink so labels read on it.
					// `--paper-3` (the OPAQUE base) not `--paper`: the parent
					// `.topology-app` is `display:contents` (no box), so this is the
					// only backdrop — under a translucent skin (aurora's `--paper` is
					// rgba alpha) `--paper` would let the wp-admin white bleed through.
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
				{ /* The ONE shared header — brand on the left, an empty controls
				     slot on the right the active tab portals its controls into. */ }
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
