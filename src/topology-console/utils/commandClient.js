/**
 * Substrate-side CommandClient singleton for the topology console's M4
 * hooks. One CommandClient per page is the right grain: lazy-construct
 * once on first use, hand the same instance back to every consumer
 * thereafter.
 *
 * baseUrl + nonce come from `window.NewspackNodesData` — already injected
 * by Admin::enqueue() alongside the topology-console bundle. Defaults keep
 * us from crashing if a consumer imports this in a context where the
 * localized data is absent (e.g. unit tests without setup).
 *
 * Lives at `src/topology-console/utils/` rather than `src/runtime/`: the
 * runtime module is the substrate's pure node-graph primitives (Node,
 * Router, Tee, CommandClient itself, etc.); this is a thin REST adapter
 * scoped to the topology-console dashboard and shouldn't pollute the
 * runtime's surface. Mirrors the application-side helper at
 * `newspack-event-logger-nodes/src/shared/utils/commandClient.js`.
 */

import { CommandClient } from '../../runtime/command_client';

let instance = null;

export function getCommandClient() {
	if ( instance ) {
		return instance;
	}
	const data =
		( typeof window !== 'undefined' && window.NewspackNodesData ) || {};
	instance = new CommandClient( {
		baseUrl: data.restUrl || '/wp-json/',
		nonce: data.nonce || '',
	} );
	return instance;
}

/**
 * Reset the singleton. For tests only — production code should never need
 * to swap clients mid-page.
 */
export function __resetCommandClientForTests() {
	instance = null;
}
