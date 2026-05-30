/**
 * `_metadata` Node + the dump_metadata payload helpers. One file per
 * Tachikoma concept: producing a dump_metadata snapshot of Core.nodes,
 * parsing one back into a { nodes, edges } graph, and the Node subclass
 * that polls + publishes for the canvas via setState('metadata', ...).
 */

import { Core } from './core';
import { Node } from './node';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	VALUE,
	LOCAL,
	TM_COMMAND,
} from './message';

/**
 * Snapshot every registered node into a dump_metadata-shaped object keyed by
 * node name. Patron-linked nodes are plumbing and are skipped.
 *
 * @return {Object} Map of node name to { class, counter, sink, target, debug_state, arguments, lgst_msg, bytes_read, bytes_written }.
 */
export function dumpMetadataPayload() {
	const out = {};
	for ( const [ name, node ] of Core.nodes ) {
		if ( node.patron !== null && node.patron !== undefined ) {
			continue;
		}
		out[ name ] = {
			class: node.constructor?.name ?? 'Node',
			counter: node.counter ?? 0,
			sink: node.sink && node.sink.name ? node.sink.name : '',
			target: node.target ?? '',
			debug_state: node.debugState ?? 0,
			arguments: node.arguments ?? '',
			lgst_msg: node.largestMsgSent ?? 0,
			bytes_read: node.bytesRead ?? 0,
			bytes_written: node.bytesWritten ?? 0,
		};
	}
	return out;
}

// The rule-#2 backbone every node sinks through — hidden from the canvas.
const SCAFFOLDING = new Set( [ '_command_interpreter', '_router' ] );

/**
 * Parse a `dump_metadata` payload (object keyed by node name) into
 * { nodes, edges }. `target` is a string or array (Tee fan-out); the backbone
 * is hidden and everything else is shown.
 *
 * @param {Object|string} payload dump_metadata reply payload.
 * @return {{ nodes: Array, edges: Array }} Canvas-ready graph.
 */
export function parseMetadata( payload ) {
	let raw;
	if ( payload && typeof payload === 'object' ) {
		raw = payload;
	} else if ( typeof payload === 'string' ) {
		try {
			raw = JSON.parse( payload );
		} catch ( e ) {
			return { nodes: [], edges: [] };
		}
	} else {
		return { nodes: [], edges: [] };
	}

	const nodes = [];
	const edges = [];
	for ( const [ name, meta ] of Object.entries( raw ) ) {
		if ( SCAFFOLDING.has( name ) ) {
			continue;
		}
		nodes.push( {
			id: name,
			count: typeof meta.counter === 'number' ? meta.counter : 0,
			sink: typeof meta.sink === 'string' ? meta.sink : '',
			class: typeof meta.class === 'string' ? meta.class : 'Node',
			debugState:
				typeof meta.debug_state === 'number' ? meta.debug_state : 0,
			arguments: typeof meta.arguments === 'string' ? meta.arguments : '',
			lgstMsg: typeof meta.lgst_msg === 'number' ? meta.lgst_msg : 0,
			bytesRead:
				typeof meta.bytes_read === 'number' ? meta.bytes_read : 0,
			bytesWritten:
				typeof meta.bytes_written === 'number' ? meta.bytes_written : 0,
		} );
		// An edge connects to the HEAD of the target path — `_router` peels the
		// first `/`-segment and delivers there (`_sse/workers` → `_sse`).
		const headOf = ( t ) => {
			const slash = t.indexOf( '/' );
			return -1 === slash ? t : t.slice( 0, slash );
		};
		const target = meta.target;
		if ( Array.isArray( target ) ) {
			for ( const t of target ) {
				if ( typeof t === 'string' && t !== '' ) {
					edges.push( { from: name, to: headOf( t ) } );
				}
			}
		} else if ( typeof target === 'string' && target !== '' ) {
			edges.push( { from: name, to: headOf( target ) } );
		}
	}
	return { nodes, edges };
}

/**
 * Metadata — `_metadata`. Router TIMER subscriber: fires dump_metadata at
 * `this.target` each tick; the reply lands on fill() and publishes the parsed
 * graph for the canvas ( useNodeState( '_metadata', 'metadata' ) ).
 */
export class MetadataNode extends Node {
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
	// re-stamps the live cwd). FROM = own name is the reply pivot; LOCAL taints
	// it so the browser interpreter authorizes a local poll.
	_pollMessage( verb ) {
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = this.name;
		m[ TO ] = this.target;
		m[ VALUE ] = { name: verb, arguments: '', payload: '' };
		m[ LOCAL ] = true;
		return m;
	}

	// Router TIMER subscriber: emit a dump_metadata poll each tick.
	onTimer() {
		if ( ! this.sink ) {
			return;
		}
		this.counter += 1;
		this.sink.fill( this._pollMessage( 'dump_metadata' ) );
	}

	fill( message ) {
		this.counter += 1;
		const value = message[ VALUE ];
		const meta =
			value && typeof value === 'object' ? value.payload ?? value : value;
		if ( meta === null || meta === undefined || meta === '' ) {
			return;
		}
		this.setState( 'metadata', parseMetadata( meta ) );
	}
}
