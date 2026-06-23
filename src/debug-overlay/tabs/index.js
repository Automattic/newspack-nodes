import { __ } from '@wordpress/i18n';
import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import OverviewTab from './OverviewTab';
import InspectorTab from './InspectorTab';

// The overlay's I/O board: byte/message rate + total cards and the two
// Tachikoma-style rate panels (In vs Out). The default first tab. fullBleed: it
// owns its own fixed header + scrolling body, so it opts out of the host's
// default scroll wrapper.
registerDevtoolsTab( {
	id: 'overview',
	label: __( 'Overview', 'newspack-nodes' ),
	host: 'overlay',
	order: 0,
	fullBleed: true,
	component: OverviewTab,
} );

// The live-graph inspector + REPL. fullBleed: a self-managed full-height graph
// canvas, so it opts out of the host's default scroll wrapper (mirrors the
// Console hub tab).
registerDevtoolsTab( {
	id: 'inspector',
	label: __( 'Inspector', 'newspack-nodes' ),
	host: 'overlay',
	order: 1,
	fullBleed: true,
	component: InspectorTab,
} );
