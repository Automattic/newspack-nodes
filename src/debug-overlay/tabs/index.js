/**
 * Register the debug overlay's two DevTools tabs: the I/O Overview board and
 * the live-graph Console. `DebugOverlay.js` imports this module for its side
 * effect alone, so the tabs exist wherever the overlay bundle loads — the hub
 * page included, because the overlay rides every hub tab.
 *
 * Sharing that page with the hub's own bundle is why the ids matter. The
 * registry is one global Map keyed by id and the last register wins, so an
 * overlay tab reusing the hub's `overview` id would replace that descriptor
 * rather than sit beside it, leaving `getDevtoolsTabs( 'hub' )` with no
 * Overview at all. `host` filters the read; it does not partition the key
 * space.
 *
 * Both tabs declare `fullBleed`, which hands each the bare tab-content pane
 * instead of the host's default scroll wrapper, because each owns a
 * full-height canvas and manages its own scrolling.
 */

import { __ } from '@wordpress/i18n';
import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import OverviewTab from './OverviewTab';
import InspectorTab from './InspectorTab';

// The id is deliberately not `overview`; the hub bundle registers that one.
registerDevtoolsTab( {
	id: 'io-overview',
	label: __( 'Overview', 'newspack-nodes' ),
	host: 'overlay',
	order: 0,
	fullBleed: true,
	component: OverviewTab,
} );

// Runtime, Profiler and Timeline open from this tab's no-selection strip.
registerDevtoolsTab( {
	id: 'console',
	label: __( 'Console', 'newspack-nodes' ),
	host: 'overlay',
	order: 1,
	fullBleed: true,
	component: InspectorTab,
} );
