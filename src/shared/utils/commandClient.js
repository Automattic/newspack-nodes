/**
 * Shared CommandClient singleton for M4 dashboards.
 *
 * Every dashboard mounts in its own React root but shares the same HTTP
 * session and the same WP nonce. One CommandClient per page is the right
 * grain: lazy-construct once on first use, hand the same instance back to
 * every consumer thereafter.
 *
 * baseUrl + nonce come from `window.NewspackNodesData` — already injected by
 * the plugin's admin_enqueue_scripts hook alongside every dashboard bundle.
 * Defaults keep us from crashing if a consumer imports this in a context
 * where the localized data is absent (e.g. unit tests without setup).
 */

import { CommandClient } from '@newspack-nodes/runtime';

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
