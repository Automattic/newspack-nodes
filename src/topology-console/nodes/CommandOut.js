/**
 * CommandOut — command-out path node. Each `fill({ commands })` posts one
 * /command request: a leading `connect_worker_input` (mounts the worker's
 * input Partition) plus each worker command. FROM=`_http/<ssePid>` is the
 * reply pivot; the pid is read at fill time so reconnects are picked up.
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

// KEY on user-typed commands, distinct from the silent gui:auto/gui:uptime polls.
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
	 * Build the worker-bound message for one descriptor.
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
		// A ping carries its send TIMESTAMP as VALUE for round-trip timing.
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
	 * Send a batch of command descriptors behind one connect_worker_input.
	 *
	 * @param {Object}        payload          Fill payload.
	 * @param {Array<Object>} payload.commands Command descriptors (each may carry `key`).
	 * @return {Promise} Resolves with the dispatch response (202 ack).
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
