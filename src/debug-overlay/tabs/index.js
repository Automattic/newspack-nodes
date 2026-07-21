import { __ } from '@wordpress/i18n';
import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import OverviewTab from './OverviewTab';
import InspectorTab from './InspectorTab';

// I/O board tab; id `io-overview` NOT `overview` (event-dashboards owns that).
registerDevtoolsTab( {
	id: 'io-overview',
	label: __( 'Overview', 'newspack-nodes' ),
	host: 'overlay',
	order: 0,
	fullBleed: true,
	component: OverviewTab,
} );

// Live-graph console + REPL; its no-node strip carries the modal buttons.
registerDevtoolsTab( {
	id: 'console',
	label: __( 'Console', 'newspack-nodes' ),
	host: 'overlay',
	order: 1,
	fullBleed: true,
	component: InspectorTab,
} );
