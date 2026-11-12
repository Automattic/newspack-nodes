/**
 * The full-page station host — the React root behind the top-level "Nodes"
 * admin page. It renders the ONE shared brand header, the `station`-scope tabs
 * under it (through the shared TabHost) and the floating debug overlay,
 * inside a fixed, full-height admin-page container so a full-screen tab (the
 * Console's CanvasFrame) has a height to fill. The header carries the brand and
 * an empty slot the active tab portals its own controls into (the Console's
 * path/edit/LIVE cluster), so the brand holds still across a tab switch. With
 * no station tab registered the host renders its empty state, and capability-gating
 * belongs to the admin page that mounts it (`Admin::render_station_page()`).
 *
 * Importing this module registers the lazy tab placeholders. The station bundle is
 * enqueued after event-dashboards, so the order-0 Overview is already in the
 * registry when the tab host resolves the landing tab and the placeholders sort
 * behind it.
 *
 * The frame, the skin provider, the header and the overlay are the shared
 * `DashboardShell`'s, run full-bleed, because the tab host insets each tab
 * itself; the live skin is the single `theme-<slug>` class on `<html>` (see
 * shared/theme.js).
 */
import { useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import TabHost from '@newspack-nodes/shared/tabs/TabHost';
import DashboardShell from '@newspack-nodes/shared/components/DashboardShell';
import { registerLazyTabs } from './lazyTabs';
import './station.scss';

/**
 * The station Console tab's id. The overlay rides every tab, but on this one it
 * builds no REPL: the Console already owns a graph and a REPL, and a second
 * pair collides on the `_output` node name.
 */
const CONSOLE_TAB_ID = 'topology-console';

registerLazyTabs();

/**
 * Renders the station page: the shared brand header, the `station`-scope tab host, and
 * the debug overlay, inside a fixed container that starts below the admin bar
 * and to the right of the (possibly collapsed) admin menu.
 *
 * The overlay waits for the tab host to name an active tab, because both of its
 * inputs are per-tab — the canvas-layout key, so two tabs never share one
 * layout, and `buildRepl`, which the Console turns off. The host reports that
 * id from the tab click rather than from an effect alone, so the gate flips in
 * the same commit the new tab mounts.
 *
 * @return {import('react').ReactElement} The station page.
 */
export default function Station() {
	const [ activeTabId, setActiveTabId ] = useState( null );

	return (
		<DashboardShell
			className="nodes-station"
			subtitle={ __( 'Station', 'newspack-nodes' ) }
			overflowY="hidden"
			fullBleed
			storageKey={
				activeTabId
					? `newspack-nodes:debug:station:${ activeTabId }`
					: null
			}
			buildRepl={ CONSOLE_TAB_ID !== activeTabId }
		>
			{ ( controlsSlot ) => (
				<TabHost
					host="station"
					syncUrl
					onActiveTabChange={ setActiveTabId }
					tabProps={ {
						headerControlsSlot: controlsSlot,
					} }
					emptyState={
						<p className="newspack-nodes-empty-state nodes-station__empty">
							{ __(
								'No tools registered yet.',
								'newspack-nodes'
							) }
						</p>
					}
				/>
			) }
		</DashboardShell>
	);
}
