import {
	newMessage,
	TYPE,
	FROM,
	TO,
	VALUE,
	LOCAL,
	TM_COMMAND,
} from '../../runtime/message';

/**
 * Build an empty-TO TM_COMMAND. Empty TO makes a CommandInterpreter interpret
 * the verb locally (it only forwards to the router when TO is non-empty), so
 * this is the same-realm analogue of the console's `local`-scope dispatch —
 * no HTTP, no SSE, no worker pivot. An optional `from` sets the reply address
 * so verb replies (and `connect_node <id>` with no target defaulting to FROM)
 * route somewhere visible — typically the transcript Dumper.
 *
 * @param {string} verb      Command verb (make_node, connect_node, …).
 * @param {string} args      Positional argument string.
 * @param {Object} [payload] By-name argument map.
 * @param {string} [from]    Reply address stamped into FROM.
 * @return {Array} positional Message.
 */
export function buildLocalCommand( verb, args = '', payload = {}, from = '' ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ TO ] = '';
	m[ FROM ] = from;
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
 * @param {string} [from]    Reply address stamped into FROM.
 * @return {void}
 */
export function dispatchLocal( ci, verb, args = '', payload = {}, from = '' ) {
	ci.fill( buildLocalCommand( verb, args, payload, from ) );
}
