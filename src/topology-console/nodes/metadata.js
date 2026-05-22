/**
 * Metadata — the `_metadata` node. `_router` delivers the `dump_metadata` poll
 * reply here; it parses the node-graph and publishes it for the canvas
 * ( useNodeState( '_metadata', 'metadata' ) ).
 */

import { Node } from '../../runtime/node';
import { VALUE } from '../../runtime/message';
import { parseMetadata } from '../utils/parseMetadata';

export class Metadata extends Node {
	constructor() {
		super();
		this.registrations.metadata = {};
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
