/**
 * Register the debug overlay's two tabs: the I/O Overview board and
 * the live-graph Console. `DebugOverlay.js` imports this module for its side
 * effect alone, so the tabs exist wherever the overlay bundle loads — the station
 * page included, because the overlay rides every station tab.
 *
 * Sharing that page with the station's own bundle is why the ids matter. The
 * registry is one global Map keyed by id and the last register wins, so an
 * overlay tab reusing the station's `overview` id would replace that descriptor
 * rather than sit beside it, leaving `getTabs( 'station' )` with no
 * Overview at all. `host` filters the read; it does not partition the key
 * space.
 *
 * Both tabs declare `fullBleed`, which hands each the bare tab-content pane
 * instead of the host's default scroll wrapper, because each owns a
 * full-height canvas and manages its own scrolling.
 */

import { __ } from '@wordpress/i18n';
import { registerTab } from '@newspack-nodes/shared/tabs/tabRegistry';
import OverviewTab from './OverviewTab';
import InspectorTab from './InspectorTab';

// The id is deliberately not `overview`; the station bundle registers that one.
registerTab( {
	id: 'io-overview',
	label: __( 'Overview', 'newspack-nodes' ),
	host: 'overlay',
	order: 0,
	fullBleed: true,
	component: OverviewTab,
} );

// Runtime, Profiler and Timeline open from this tab's no-selection strip.
registerTab( {
	id: 'console',
	label: __( 'Console', 'newspack-nodes' ),
	host: 'overlay',
	order: 1,
	fullBleed: true,
	component: InspectorTab,
} );
