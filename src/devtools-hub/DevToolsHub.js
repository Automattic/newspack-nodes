/**
 * The full-page DevTools hub host — the React root behind the top-level "Nodes"
 * admin page. It renders the ONE shared brand header, the `hub`-scope tabs
 * under it (through the shared DevtoolsTabHost) and the floating debug overlay,
 * inside a fixed, full-height admin-page container so a full-screen tab (the
 * Console's CanvasFrame) has a height to fill. The header carries the brand and
 * an empty slot the active tab portals its own controls into (the Console's
 * path/edit/LIVE cluster), so the brand holds still across a tab switch. With
 * no hub tab registered the host renders its empty state, and capability-gating
 * belongs to the admin page that mounts it (`Admin::render_hub_page()`).
 *
 * Importing this module registers the lazy tab placeholders. The hub bundle is
 * enqueued after event-dashboards, so the order-0 Overview is already in the
 * registry when the tab host resolves the landing tab and the placeholders sort
 * behind it.
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

/**
 * The hub Console tab's id. The overlay rides every tab, but on this one it
 * builds no REPL: the Console already owns a graph and a REPL, and a second
 * pair collides on the `_output` node name.
 */
const CONSOLE_TAB_ID = 'topology-console';

registerLazyTabs();

/**
 * Renders the hub page: the shared brand header, the `hub`-scope tab host, and
 * the debug overlay, inside a fixed container that starts below the admin bar
 * and to the right of the (possibly collapsed) admin menu.
 *
 * The overlay waits for the tab host to name an active tab, because both of its
 * inputs are per-tab — the canvas-layout key, so two tabs never share one
 * layout, and `buildRepl`, which the Console turns off. The host reports that
 * id from the tab click rather than from an effect alone, so the gate flips in
 * the same commit the new tab mounts.
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
						// Paint here: a boxless parent shows admin white.
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
