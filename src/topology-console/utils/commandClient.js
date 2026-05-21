/**
 * CommandClient singleton for the topology console (lazy-constructed once).
 * baseUrl + nonce come from window.NewspackNodesData, with safe defaults.
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
 * Reset the singleton. For tests only.
 */
export function __resetCommandClientForTests() {
	instance = null;
}
