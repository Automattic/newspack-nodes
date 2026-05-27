import { Node } from '../../runtime/node';
import { VALUE, TO, TYPE, TM_STRUCT, newMessage } from '../../runtime/message';
import { getCommandClient } from '../../shared/utils/commandClient';
import unwrapCommandResponse from '../../shared/utils/unwrapCommandResponse';

/**
 * `workerstatus:poll` — the ingest node that owns the worker-status command
 * traffic, behind an injectable command-client seam.
 *
 * `poll()` sends `dump_metadata` to `workers` (the rich per-worker envelope the
 * dashboard needs; `workers.list` is the minimal CLI/topology projection),
 * unwraps the reply, and emits it as a TM_STRUCT `{ action:'metadata', metadata }`
 * to its sink (→ `workerstatus:transform`). `restart(type)` sends a graceful
 * `restart` for that worker type across all partitions. Both surface failures as
 * a TM_STRUCT `{ action:'error', error }` control so the view can show them.
 *
 * The interval timer + page-visibility gating live in the HOOK, not here — this
 * node is just the transport boundary (mirroring how rawLogsStream owns the SSE
 * connection while its hook owns the list_logs fire). The network / shared
 * CommandClient is reached ONLY through the `client` seam, lazily defaulted to
 * `getCommandClient()`; tests inject a fake.
 */
class WorkerStatusPollNode extends Node {
	constructor( client ) {
		super();
		this._client = client;
		this._closed = false;
	}

	// Send dump_metadata, unwrap, and emit the snapshot to the sink. On failure
	// emit an error control instead (matches WorkerStatus.fetchWorkers' catch).
	async poll() {
		const client = this._client || getCommandClient();
		try {
			const message = await client.send( {
				to: 'workers',
				verb: 'dump_metadata',
			} );
			const metadata = unwrapCommandResponse( message ) || {};
			this._emit( { action: 'metadata', metadata } );
		} catch ( err ) {
			this._emit( {
				action: 'error',
				error: 'Server disconnected. Reconnecting...',
			} );
		}
	}

	// Request a graceful restart for `type` across all partitions. On failure
	// emit an error control (matches WorkerStatus.handleRestart's catch).
	async restart( type ) {
		const client = this._client || getCommandClient();
		try {
			const message = await client.send( {
				to: 'workers',
				verb: 'restart',
				payload: { types: [ type ], partition: -1 },
			} );
			unwrapCommandResponse( message );
		} catch ( err ) {
			this._emit( {
				action: 'error',
				error: `Failed to request restart: ${ err.message }`,
			} );
		}
	}

	// Tear down: a send() resolving/rejecting after this drops its emit so we
	// never fill a detached sink post-unmount. Mirrors rawLogsStream.close().
	close() {
		this._closed = true;
	}

	_emit( value ) {
		// Checked after the await in poll()/restart(): swallow late replies.
		if ( this._closed || ! this.sink ) {
			return;
		}
		const out = newMessage();
		out[ TYPE ] = TM_STRUCT;
		// Rule #2: stamp TO=target so the exospine router routes it (→ transform).
		out[ TO ] = this.target;
		out[ VALUE ] = value;
		this.sink.fill( out );
	}
}

/**
 * Create and register the Worker Status poll node.
 *
 * @param {string} name                 Node name.
 * @param {Object} [opts]               Options.
 * @param {Object} [opts.commandClient] Injectable command-client seam (send);
 *                                      defaults to the shared CommandClient.
 * @return {WorkerStatusPollNode} The poll node.
 */
export function createWorkerStatusPoll( name, opts = {} ) {
	const node = new WorkerStatusPollNode( opts.commandClient );
	node.setName( name );
	return node;
}
