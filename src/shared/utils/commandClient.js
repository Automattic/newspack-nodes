/**
 * Shared CommandClient singleton (lazy-constructed once per page).
 * baseUrl + nonce come from window.NewspackNodesData, with safe defaults.
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
 * Reset the singleton. For tests only.
 */
export function __resetCommandClientForTests() {
	instance = null;
}
