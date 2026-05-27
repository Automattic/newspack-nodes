import {
	newMessage,
	TYPE,
	TO,
	VALUE,
	LOCAL,
	TM_COMMAND,
} from '../../runtime/message';

/**
 * Build an empty-TO TM_COMMAND. Empty TO makes a CommandInterpreter interpret
 * the verb locally (it only forwards to the router when TO is non-empty), so
 * this is the same-realm analogue of the console's `local`-scope dispatch —
 * no HTTP, no SSE, no worker pivot.
 *
 * @param {string} verb      Command verb (make_node, connect_node, …).
 * @param {string} args      Positional argument string.
 * @param {Object} [payload] By-name argument map.
 * @return {Array} positional Message.
 */
export function buildLocalCommand( verb, args = '', payload = {} ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ TO ] = '';
	m[ LOCAL ] = true;
	m[ VALUE ] = { name: verb, arguments: args, payload };
	return m;
}

/**
 * Dispatch a local command into a CommandInterpreter node by filling it.
 *
 * @param {Object} ci        The CommandInterpreter node (the page's own).
 * @param {string} verb      Command verb.
 * @param {string} args      Positional argument string.
 * @param {Object} [payload] By-name argument map.
 * @return {void}
 */
export function dispatchLocal( ci, verb, args = '', payload = {} ) {
	ci.fill( buildLocalCommand( verb, args, payload ) );
}
