/**
 * CommandOut — in-browser graph node for the topology console's
 * command-out path. Driven by both the silent canvas poll and the REPL:
 * each `fill({ commands })` posts ONE /command request carrying a JSONL
 * batch of a leading `connect_worker_input` plus each worker command.
 *
 * Routing model (formerly in the standalone sendCommand util):
 *
 *   1. `connect_worker_input` → the `topologies` CI, with the worker
 *      reader id as its argument. The /command process is request-scoped
 *      and starts with no worker nodes, so this mounts that one worker's
 *      input Partition (named `{topology}.p{N}`) into THIS process's
 *      graph. Without it the commands route to a non-existent node and
 *      `_router` returns NOT_AVAILABLE — they never reach the worker.
 *   2. each real command/message, addressed at the worker:
 *      - Empty inner path → TO=`{reader}`; the worker's CI sees an empty
 *        TO and handles the command locally.
 *      - Explicit node path → TO=`{reader}/{path}`; the worker's CI
 *        forwards through its own `_router` to that node.
 *
 * The messages run serially in one process, so the mount from (1) is
 * visible to the commands' routing. FROM=`_http/<ssePid>` stamps each
 * message with the open messages-stream session's pid — the worker's
 * reply walks back: worker `_router` peels `_repl` → shared output
 * partition; the SSE session reads it, peels `_http`, and HTTP_Filter
 * matches `<ssePid>` to deliver only to that session.
 *
 * The pid is read from the SseConnector at fill time, so a reconnect that
 * re-keys the session is picked up automatically on the next send.
 */

import { Node } from '../../runtime/node';
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

// KEY stamped on user-typed commands so the frontend can distinguish their
// responses from the silent `gui:auto` / `gui:uptime` snapshot polls.
const TYPED_KEY = 'gui:typed';

const TYPED_MESSAGE_TYPES = {
	ping: TM_PING,
	info: TM_INFO,
	bytestream: TM_BYTESTREAM,
	eof: TM_EOF,
	request: TM_REQUEST,
};

export class CommandOut extends Node {
	/**
	 * @param {Object} params
	 * @param {string} params.topology  Topology name.
	 * @param {number} params.partition Partition number.
	 * @param {Object} params.connector SseConnector — `pid()` is the reply pivot.
	 * @param {Object} params.client    CommandClient — `buildMessage` / `postBatch`.
	 */
	constructor( { topology, partition, connector, client } ) {
		super();
		this.topology = topology;
		this.partition = partition;
		this.connector = connector;
		this.client = client;
	}

	get reader() {
		return `${ this.topology }.p${ this.partition }`;
	}

	/**
	 * Resolve a command descriptor's `to` into the substrate TO path.
	 *
	 * @param {string} to Optional node path inside the worker.
	 * @return {string} The message TO field.
	 */
	resolveTo( to ) {
		return to ? `${ this.reader }/${ to }` : this.reader;
	}

	/**
	 * Build the worker-bound message for one descriptor. Command-type goes
	 * through buildMessage (structured VALUE); typed types (ping/info/
	 * bytestream/eof/request) carry a raw scalar VALUE. Returns null for an
	 * unsupported type so fill() can reject without posting.
	 *
	 * @param {Object} body   Command descriptor {type, name, arguments, to}.
	 * @param {number} ssePid Open messages-stream session pid (reply pivot).
	 * @param {string} key    KEY stamped on the message.
	 * @return {Array|null} The 7-field Message, or null if body.type is unknown.
	 */
	buildWorkerMessage( body, ssePid, key ) {
		if ( 'command' === body.type ) {
			return this.client.buildMessage( {
				to: this.resolveTo( body.to ),
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
		// newMessage() seeds TIMESTAMP with the send clock. A ping carries
		// that timestamp as its VALUE so the bounced reply's round-trip
		// computes (the renderer does now - VALUE); other typed messages
		// carry their arg bytes.
		const msg = newMessage();
		msg[ TYPE ] = type;
		msg[ FROM ] = `_http/${ ssePid }`;
		msg[ TO ] = this.resolveTo( body.to );
		msg[ KEY ] = key;
		msg[ VALUE ] =
			TM_PING === type ? msg[ TIMESTAMP ] : body.arguments || '';
		return msg;
	}

	/**
	 * Send a batch of command descriptors to the worker: a leading
	 * `connect_worker_input` (mounts the worker's input Partition once),
	 * then each command. Several behind one connect costs one /command
	 * request and one mount instead of one per command.
	 *
	 * @param {Object}        payload          Fill payload.
	 * @param {Array<Object>} payload.commands Command descriptors, each optionally
	 *                                         carrying its own `key`.
	 * @return {Promise} Resolves with the dispatch response (202 ack;
	 *                   pivoted replies arrive over the SSE stream).
	 */
	fill( payload ) {
		this.counter += 1;
		const commands = ( payload && payload.commands ) || [];
		const ssePid = this.connector.pid();

		const workerMsgs = [];
		for ( const command of commands ) {
			const { key = TYPED_KEY } = command;
			const msg = this.buildWorkerMessage( command, ssePid, key );
			if ( ! msg ) {
				return Promise.reject(
					new Error( `unsupported command type: ${ command.type }` )
				);
			}
			workerMsgs.push( msg );
		}

		const connect = this.client.buildMessage( {
			to: 'topologies',
			verb: 'connect_worker_input',
			args: this.reader,
			ssePid,
			key: commands[ 0 ]?.key ?? TYPED_KEY,
		} );
		return this.client.postBatch( [ connect, ...workerMsgs ] );
	}
}
