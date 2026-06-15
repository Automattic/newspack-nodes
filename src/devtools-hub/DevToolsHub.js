/**
 * The full-page DevTools hub host. Renders the `hub`-scope tabs through the
 * shared DevtoolsTabHost; an empty state until a plugin registers a hub tab
 * (the Topology Manager is the first, in its own spec). Capability-gating is
 * the admin page's concern (server-side); this component just renders.
 */
import { __ } from '@wordpress/i18n';
import DevtoolsTabHost from '@newspack-nodes/shared/devtools/DevtoolsTabHost';

export default function DevToolsHub() {
	return (
		<DevtoolsTabHost
			host="hub"
			emptyState={
				<p className="nodes-devtools__empty">
					{ __( 'No tools registered yet.', 'newspack-nodes' ) }
				</p>
			}
		/>
	);
}
