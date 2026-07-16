/**
 * CommandClient singleton for the topology console (lazy-constructed once).
 * baseUrl + nonce come from window.NewspackNodesData, with safe defaults.
 */

import { CommandClient } from '../../runtime/command-client';

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
