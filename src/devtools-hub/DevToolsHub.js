/**
 * The full-page DevTools hub host. Renders the ONE shared brand header on top,
 * the `hub`-scope tabs (through the shared DevtoolsTabHost) below it, and the
 * floating debug overlay — inside a fixed, full-height admin-page container
 * (mirroring WorkerStatusPage) so a full-screen tab (the Console's CanvasFrame)
 * gets usable height. The header is brand-only; each tab's own controls (the
 * Console's path/edit/LIVE cluster) stay inside that tab. Empty state until a
 * plugin registers a hub tab. Capability-gating is the admin page's concern.
 *
 * Themed like the debug overlay: the hub is wrapped in a reactive
 * `.topology-app.theme-<slug>` token context, so its chrome reads --paper /
 * --ink (and a Console `set_skin` re-skins the hub via `publishTheme`) instead
 * of fixed --np-* tokens.
 */
import { useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import DevtoolsTabHost from '@newspack-nodes/shared/devtools/DevtoolsTabHost';
import useAdminMenuWidth from '@newspack-nodes/shared/hooks/useAdminMenuWidth';
import Header from '../topology-console/components/Header';
import { getStoredTheme } from '../topology-console/themes';
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
	// Theme drives the hub's token context; the Console publishes its live theme
	// up so a set_skin re-skins the whole hub, not just the canvas.
	const [ theme, setTheme ] = useState( getStoredTheme );
	// The active tab portals its own controls into this slot on the right of the
	// shared header (setState-as-callback-ref re-renders once the node mounts).
	const [ controlsSlot, setControlsSlot ] = useState( null );

	return (
		// display:contents themed token-provider so the hub + its chrome resolve
		// the active skin's --paper/--ink (no box, so the fixed layout is intact).
		<div
			className={ `topology-app newspack-nodes-theme theme-${ theme }` }
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
					background: 'var(--paper)',
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
						publishTheme: setTheme,
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
				{ activeTabId && CONSOLE_TAB_ID !== activeTabId && (
					<DebugOverlay
						storageKey={ `newspack-nodes:debug:hub:${ activeTabId }` }
					/>
				) }
			</div>
		</div>
	);
}
