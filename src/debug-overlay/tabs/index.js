import { __ } from '@wordpress/i18n';
import { registerDevtoolsTab } from '@newspack-nodes/shared/devtools/tabRegistry';
import OverviewTab from './OverviewTab';
import InspectorTab from './InspectorTab';
import LogsTab from './LogsTab';
import RuntimeTab from './RuntimeTab';

// I/O board tab; id `io-overview` NOT `overview` (event-dashboards owns that).
registerDevtoolsTab( {
	id: 'io-overview',
	label: __( 'Overview', 'newspack-nodes' ),
	host: 'overlay',
	order: 0,
	fullBleed: true,
	component: OverviewTab,
} );

// The live-graph console + REPL — same view as the hub's Console tab.
registerDevtoolsTab( {
	id: 'console',
	label: __( 'Console', 'newspack-nodes' ),
	host: 'overlay',
	order: 1,
	fullBleed: true,
	component: InspectorTab,
} );

// Log tail: this browser's stderr ring + the PHP error / WP debug FILES.
registerDevtoolsTab( {
	id: 'logs',
	label: __( 'Logs', 'newspack-nodes' ),
	host: 'overlay',
	order: 3,
	fullBleed: true,
	component: LogsTab,
} );

// Runtime: current-scope timers + handles. order 45 = last in overlay + hub.
registerDevtoolsTab( {
	id: 'runtime',
	label: __( 'Runtime', 'newspack-nodes' ),
	host: 'both',
	order: 45,
	fullBleed: true,
	component: RuntimeTab,
} );
