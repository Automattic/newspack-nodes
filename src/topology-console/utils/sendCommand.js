/**
 * sendInterpretedCommand — dispatch a shellInterpret `post` body on the
 * generic `/command` endpoint, pivoting the worker's reply back through
 * the open messages-stream session.
 *
 * Routing model (replaces the old per-worker TopologyStreamController):
 *
 *   The substrate bootstrap registers one `Partition` Node per live
 *   worker, named after its reader id (`{topology}.p{N}`), pointed at
 *   the worker's input partition on disk. The web process's `_router`
 *   peels the head of the message's TO; addressing TO=`{topology}.p{N}`
 *   lands the message on that Partition's `fill()`, which writes it to
 *   the worker's input. The worker's input Consumer stamps `_repl` onto
 *   FROM and sinks straight into its `_command_interpreter`.
 *
 *   - Empty inner path → TO=`{reader}`. After the head-peel the worker
 *     sees an empty TO, so its CI handles the command locally (same as
 *     the cli's pivoted-mode default, which writes TO='' directly).
 *   - Explicit node path (`cmd <path> <verb>`, `tell <path> …`, etc.) →
 *     TO=`{reader}/{path}`. After the peel the worker's CI sees a
 *     non-empty TO and forwards through its own `_router` to that node.
 *
 *   FROM=`_http/<ssePid>` stamps the message with the messages-stream
 *   session's pid. The worker's reply (TO=FROM=`_repl/_http/<ssePid>`)
 *   walks back: worker `_router` peels `_repl` → writes to the shared
 *   output partition; the SSE session reads it, `_router` peels `_http`,
 *   and HTTP_Filter matches `<ssePid>` to deliver only to that session.
 *
 * TM_COMMAND verbs (default + `cmd`) go through the shared CommandClient,
 * which builds the `{name, arguments, payload}` VALUE envelope and the
 * `_http/<pid>` FROM. The other typed verbs (ping/info/bytestream/eof/
 * request) can't be expressed by CommandClient (it only builds
 * TM_COMMAND), so they post a raw positional Message array directly to
 * `/command` — Command_Controller::normalize_body_to_message accepts a
 * 7-field list and routes it through the same Router path.
 */

import { getCommandClient } from './commandClient';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	KEY,
	VALUE,
	TM_PING,
	TM_INFO,
	TM_BYTESTREAM,
	TM_EOF,
	TM_REQUEST,
} from '../../runtime/message';

// KEY stamped on user-typed commands so the frontend can distinguish
// their responses from the silent `gui:auto` / `gui:uptime` snapshot
// polls. Matches the KEY the console's poke loop omits.
const TYPED_KEY = 'gui:typed';

const TYPED_MESSAGE_TYPES = {
	ping: TM_PING,
	info: TM_INFO,
	bytestream: TM_BYTESTREAM,
	eof: TM_EOF,
	request: TM_REQUEST,
};

/**
 * Resolve a shellInterpret body's `to` into the substrate TO path.
 *
 * @param {string} reader Worker reader id, `{topology}.p{N}`.
 * @param {string} to     Optional node path inside the worker.
 * @return {string} The message TO field.
 */
function resolveTo( reader, to ) {
	return to ? `${ reader }/${ to }` : reader;
}

/**
 * Dispatch one interpreted `post` body.
 *
 * @param {Object} body             shellInterpret `post` body.
 * @param {string} body.type        One of command|ping|info|bytestream|eof|request.
 * @param {string} [body.name]      Verb name (type=command).
 * @param {string} [body.arguments] Argument tail / payload bytes.
 * @param {string} [body.to]        Optional node path inside the worker.
 * @param {Object} ctx              Dispatch context.
 * @param {string} ctx.topology     Topology name.
 * @param {number} ctx.partition    Partition number.
 * @param {number} ctx.ssePid       Open messages-stream session pid.
 * @param {string} [ctx.key]        KEY stamped on the message. Defaults to
 *                                  `gui:typed` (user commands → transcript);
 *                                  pass `gui:auto`/`gui:uptime` for the silent
 *                                  canvas-refresh polls.
 * @return {Promise} Resolves with the dispatch response.
 */
export function sendInterpretedCommand(
	body,
	{ topology, partition, ssePid, key = TYPED_KEY }
) {
	const reader = `${ topology }.p${ partition }`;

	if ( 'command' === body.type ) {
		return getCommandClient().send( {
			to: resolveTo( reader, body.to ),
			verb: body.name,
			args: body.arguments || '',
			ssePid,
			key,
		} );
	}

	const type = TYPED_MESSAGE_TYPES[ body.type ];
	if ( ! type ) {
		return Promise.reject(
			new Error( `unsupported command type: ${ body.type }` )
		);
	}

	const client = getCommandClient();
	// newMessage() already seeds TIMESTAMP with the current clock.
	const msg = newMessage();
	msg[ TYPE ] = type;
	msg[ FROM ] = `_http/${ ssePid }`;
	msg[ TO ] = resolveTo( reader, body.to );
	msg[ KEY ] = key;
	msg[ VALUE ] = body.arguments || '';

	return fetch( `${ client.baseUrl }newspack-nodes/v1/command`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-WP-Nonce': client.nonce,
		},
		body: JSON.stringify( msg ),
	} ).then( ( r ) => r.json() );
}
