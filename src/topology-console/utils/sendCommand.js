/**
 * sendWorkerCommand — send a command to a worker through the generic
 * `/command` endpoint, pivoting the worker's reply back through the open
 * messages-stream session.
 *
 * `body` is a command descriptor `{ type, name, arguments, to }` — produced by
 * `shell` for user-typed lines, or built inline for the canvas's
 * silent `dump_metadata` / `uptime` poll. `type` is one of
 * command|ping|info|bytestream|eof|request.
 *
 * Routing model — every send is a batch posted in one request: a leading
 * `connect_worker_input`, then one or more commands.
 *
 *   1. `connect_worker_input` → the `topologies` CI, with the worker reader id
 *      as its argument. The /command process is request-scoped and starts with
 *      no worker nodes, so this mounts that one worker's input `Partition`
 *      (named by reader id `{topology}.p{N}`, pointed at its input dir) into
 *      THIS process's graph. Without it the commands route to a non-existent
 *      node and `_router` returns NOT_AVAILABLE — they never reach the worker.
 *   2. each real command/message, addressed at the worker:
 *      - Empty inner path → TO=`{reader}`; after `_router` peels the head the
 *        worker's CI sees an empty TO and handles the command locally.
 *      - Explicit node path (`cmd <path> <verb>`, etc.) → TO=`{reader}/{path}`;
 *        the worker's CI forwards through its own `_router` to that node.
 *
 * Batch ordering matters: the messages run serially in one process, so the
 * mount from (1) is visible to the commands' routing. `_router` resolves
 * TO=`{reader}` to the mounted Partition, whose `fill()` writes to the worker.
 *
 * FROM=`_http/<ssePid>` stamps the message with the messages-stream session's
 * pid. The worker's reply (TO=FROM=`_repl/_http/<ssePid>`) walks back: worker
 * `_router` peels `_repl` → shared output partition; the SSE session reads it,
 * peels `_http`, and HTTP_Filter matches `<ssePid>` to deliver only to that
 * session. connect_worker_input returns '' — only the real commands reply.
 */

import { getCommandClient } from './commandClient';
import {
	newMessage,
	TYPE,
	TIMESTAMP,
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
 * Resolve a command body's `to` into the substrate TO path.
 *
 * @param {string} reader Worker reader id, `{topology}.p{N}`.
 * @param {string} to     Optional node path inside the worker.
 * @return {string} The message TO field.
 */
function resolveTo( reader, to ) {
	return to ? `${ reader }/${ to }` : reader;
}

/**
 * Build the worker-bound message for one command descriptor. Command-type goes
 * through buildMessage (structured VALUE); the typed types (ping/info/
 * bytestream/eof/request) carry a raw scalar VALUE. Returns null for an
 * unsupported type so the caller can reject without posting.
 *
 * @param {Object} client The CommandClient (shared across a batch).
 * @param {Object} body   Command descriptor {type, name, arguments, to}.
 * @param {string} reader Worker reader id, `{topology}.p{N}`.
 * @param {number} ssePid Open messages-stream session pid (reply pivot).
 * @param {string} key    KEY stamped on the message.
 * @return {Array|null} The 7-field Message, or null if body.type is unknown.
 */
function buildWorkerMessage( client, body, reader, ssePid, key ) {
	if ( 'command' === body.type ) {
		return client.buildMessage( {
			to: resolveTo( reader, body.to ),
			verb: body.name,
			args: body.arguments || '',
			ssePid,
			key,
		} );
	}
	const type = TYPED_MESSAGE_TYPES[ body.type ];
	if ( ! type ) {
		return null;
	}
	// newMessage() seeds TIMESTAMP with the send clock. A ping carries that
	// timestamp as its VALUE so the bounced reply's round-trip computes (the
	// renderer does now - VALUE); other typed messages carry their arg bytes.
	const msg = newMessage();
	msg[ TYPE ] = type;
	msg[ FROM ] = `_http/${ ssePid }`;
	msg[ TO ] = resolveTo( reader, body.to );
	msg[ KEY ] = key;
	msg[ VALUE ] = TM_PING === type ? msg[ TIMESTAMP ] : body.arguments || '';
	return msg;
}

/**
 * Send one OR MORE command descriptors to the worker as a single batch: a
 * leading `connect_worker_input` (mounts the worker's input Partition once),
 * then each command. Sending several behind one connect costs one /command
 * request and one mount instead of one per command — the canvas polls
 * `dump_metadata` and `uptime` together this way.
 *
 * @param {Array<Object>} commands      Command descriptors, each optionally carrying
 *                                      its own `key` (so dump_metadata→gui:auto and
 *                                      uptime→gui:uptime route distinctly).
 * @param {Object}        ctx           Dispatch context.
 * @param {string}        ctx.topology  Topology name.
 * @param {number}        ctx.partition Partition number.
 * @param {number}        ctx.ssePid    Open messages-stream session pid.
 * @return {Promise} Resolves with the dispatch response (202 ack; pivoted
 *                   replies arrive over the SSE stream).
 */
export function sendWorkerCommands(
	commands,
	{ topology, partition, ssePid }
) {
	const reader = `${ topology }.p${ partition }`;
	const client = getCommandClient();

	const workerMsgs = [];
	for ( const command of commands ) {
		const { key = TYPED_KEY } = command;
		const msg = buildWorkerMessage( client, command, reader, ssePid, key );
		if ( ! msg ) {
			return Promise.reject(
				new Error( `unsupported command type: ${ command.type }` )
			);
		}
		workerMsgs.push( msg );
	}

	const connect = client.buildMessage( {
		to: 'topologies',
		verb: 'connect_worker_input',
		args: reader,
		ssePid,
		key: commands[ 0 ]?.key ?? TYPED_KEY,
	} );
	return client.postBatch( [ connect, ...workerMsgs ] );
}

/**
 * Send a single command to the worker — a thin wrapper over sendWorkerCommands
 * (a one-element batch: connect + the command).
 *
 * @param {Object} body          Command descriptor (from shell for typed input,
 *                               or built inline for the poll).
 * @param {Object} ctx           Dispatch context.
 * @param {string} ctx.topology  Topology name.
 * @param {number} ctx.partition Partition number.
 * @param {number} ctx.ssePid    Open messages-stream session pid.
 * @param {string} [ctx.key]     KEY stamped on the message. Defaults to
 *                               `gui:typed`; pass `gui:auto`/`gui:uptime` for
 *                               the silent canvas-refresh polls.
 * @return {Promise} Resolves with the dispatch response.
 */
export function sendWorkerCommand(
	body,
	{ topology, partition, ssePid, key = TYPED_KEY }
) {
	return sendWorkerCommands( [ { ...body, key } ], {
		topology,
		partition,
		ssePid,
	} );
}
