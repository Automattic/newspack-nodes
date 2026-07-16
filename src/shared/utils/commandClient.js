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
	instance = CommandClient.fromGlobal();
	return instance;
}

/**
 * Reset the singleton. For tests only.
 */
export function __resetCommandClientForTests() {
	instance = null;
}
