import { __ } from '@wordpress/i18n';
import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import InspectorTab from './InspectorTab';

// The substrate's one built-in overlay tab: the live-graph inspector + REPL.
registerDevtoolsTab( {
	id: 'inspector',
	label: __( 'Inspector', 'newspack-nodes' ),
	host: 'overlay',
	order: 0,
	component: InspectorTab,
} );
