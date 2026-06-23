import { __ } from '@wordpress/i18n';
import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import OverviewTab from './OverviewTab';
import InspectorTab from './InspectorTab';

// The overlay's I/O board: byte/message rate + total cards and the two
// Tachikoma-style rate panels (In vs Out). The default first tab. fullBleed: it
// owns its own fixed header + scrolling body, so it opts out of the host's
// default scroll wrapper. The id is `io-overview` (NOT `overview`): the registry
// is keyed by id and shadows across hosts, and the event-dashboards bundle
// already owns `overview` for the HUB's Overview tab — both load on the hub page.
registerDevtoolsTab( {
	id: 'io-overview',
	label: __( 'Overview', 'newspack-nodes' ),
	host: 'overlay',
	order: 0,
	fullBleed: true,
	component: OverviewTab,
} );

// The live-graph console + REPL — the same view as the hub's Console tab (the
// node-detail "inspector" is the rail INSIDE it, not this tab). fullBleed: a
// self-managed full-height graph canvas, so it opts out of the host's default
// scroll wrapper. (Component file is still InspectorTab.js for now.)
registerDevtoolsTab( {
	id: 'console',
	label: __( 'Console', 'newspack-nodes' ),
	host: 'overlay',
	order: 1,
	fullBleed: true,
	component: InspectorTab,
} );
