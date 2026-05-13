/**
 * Topology Console entry point.
 *
 * Mounts on the admin page's #event-logger-topology-console root
 * (registered in newspack-nodes.php under the
 * `newspack-nodes-topology` admin slug).
 */

import { createRoot } from '@wordpress/element';

import TopologyConsole from './TopologyConsole';
import './styles/topology-console.scss';

const ROOT_ID = 'event-logger-topology-console';

function mount() {
	const root = document.getElementById( ROOT_ID );
	if ( ! root ) {
		return;
	}
	createRoot( root ).render( <TopologyConsole /> );
}

if (
	document.readyState === 'complete' ||
	document.readyState === 'interactive'
) {
	mount();
} else {
	document.addEventListener( 'DOMContentLoaded', mount );
}
