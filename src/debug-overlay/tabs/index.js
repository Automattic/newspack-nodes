import { __ } from '@wordpress/i18n';
import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import InspectorTab from './InspectorTab';

// The substrate's one built-in overlay tab: the live-graph inspector + REPL.
// fullBleed: the Inspector is a self-managed full-height graph canvas, so it
// opts out of the host's default scroll wrapper (mirrors the Console hub tab).
registerDevtoolsTab( {
	id: 'inspector',
	label: __( 'Inspector', 'newspack-nodes' ),
	host: 'overlay',
	order: 0,
	fullBleed: true,
	component: InspectorTab,
} );
