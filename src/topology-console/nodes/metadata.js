/**
 * Metadata — the `_metadata` node. `_router` delivers the `dump_metadata` poll
 * reply here; it parses the node-graph and publishes it for the canvas
 * ( useNodeState( '_metadata', 'metadata' ) ).
 */

import { Node } from '../../runtime/node';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	VALUE,
	LOCAL,
	TM_COMMAND,
} from '../../runtime/message';
import { parseMetadata } from '../utils/parseMetadata';

export class Metadata extends Node {
	constructor() {
		super();
		this.registrations.metadata = {};
	}

	static nodeSchema() {
		return {
			category: 'Hidden',
			description:
				'Receives `dump_metadata` poll reply; publishes for the canvas.',
			arguments: [],
			commands: [],
		};
	}

	// Build a poll TM_COMMAND addressed to this.target (the `_cwd` node, which
	// re-stamps the live cwd). FROM = own name is the reply pivot (the reply comes
	// back here); LOCAL taints it so the browser CI authorizes a local poll.
	_pollMessage( verb ) {
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = this.name;
		m[ TO ] = this.target;
		m[ VALUE ] = { name: verb, arguments: '', payload: '' };
		m[ LOCAL ] = true;
		return m;
	}

	// Router TIMER subscriber: emit a dump_metadata poll each tick. The timer only
	// runs while the graph is mounted, and `_cwd` handles every scope, so there's
	// no per-scope gate — emit whenever a sink exists.
	onTimer() {
		if ( ! this.sink ) {
			return;
		}
		this.sink.fill( this._pollMessage( 'dump_metadata' ) );
	}

	fill( message ) {
		this.counter += 1;
		const value = message[ VALUE ];
		// Reply VALUE is `{ name, payload }`; the metadata is the payload.
		const meta =
			value && typeof value === 'object' ? value.payload ?? value : value;
		if ( meta === null || meta === undefined || meta === '' ) {
			return;
		}
		this.setState( 'metadata', parseMetadata( meta ) );
	}
}
