/**
 * `_metadata` Node + the dump_metadata payload helpers. One file per
 * Tachikoma concept: producing a dump_metadata snapshot of Core.nodes,
 * parsing one back into a { nodes, edges } graph, and the Node subclass
 * that polls + publishes for the canvas via setState('metadata', ...).
 */

import { Core } from './core';
import { TimerNode } from './timer-node';
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
		// Per-node port flags from the node's own schema; default true so the
		// canvas draws both ports when the class declares no static schema.
		const schema = node.constructor?.nodeSchema?.() ?? null;
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
			accepts_fill: schema?.accepts_fill ?? true,
			has_target: schema?.has_target ?? true,
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
			// Per-node port flags; default true so the canvas draws both ports
			// when the payload omits them (drafts, legacy workers).
			accepts_fill:
				typeof meta.accepts_fill === 'boolean'
					? meta.accepts_fill
					: true,
			has_target:
				typeof meta.has_target === 'boolean' ? meta.has_target : true,
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
 * Self-managed poll cadence for `_metadata`, scaled to graph size: a big graph
 * is expensive to dump + re-render, so back off. `nodeCount * 10`ms, rounded to
 * the nearest 5 seconds and floored at 5s.
 *
 * @param {number} nodeCount Node count of the last parsed graph.
 * @return {number} Poll interval in milliseconds (>= 5000).
 */
export function computePollIntervalMs( nodeCount ) {
	const seconds = ( nodeCount * 10 ) / 1000;
	const rounded =
		seconds > 5 ? Math.round( seconds / 5 ) * 5 : Math.round( seconds );
	return Math.max( 5, rounded ) * 1000;
}

/**
 * Metadata — `_metadata`. A TimerNode hitchhiking the _router: `fire()` runs
 * every tick (the _router calls fireCb -> fire directly) but self-throttles to
 * its own `interval_ms` — staying bound to the shared TIMER so the poll batches
 * with the other per-tick requests. The reply lands on fill() and publishes the
 * parsed graph for the canvas ( useNodeState( '_metadata', 'metadata' ) ).
 */
export class MetadataNode extends TimerNode {
	constructor() {
		super();
		this.registrations.metadata = {};
		// Self-throttle state: lastFired in Core.now() seconds; lastPath is the
		// pivot we last polled (a cd re-polls immediately). interval_ms is set
		// from the graph size on each response (computePollIntervalMs).
		this.lastFired = 0;
		this.lastPath = null;
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
		m[ VALUE ] = { name: verb, arguments: '' };
		m[ LOCAL ] = true;
		return m;
	}

	// Router TIMER subscriber (the _router calls fireCb -> fire each second).
	// Self-throttle: poll only once interval_ms has elapsed, or immediately when
	// the pivot path changed (the user cd'd) — staying on the shared TIMER so the
	// poll batches with the tick's other requests.
	fire() {
		if ( ! this.sink ) {
			return;
		}
		const now = Core.now();
		// The poll routes through `_cwd` (this.target); its `.target` is the live
		// pivot path, swapped by a cd without remounting us.
		const cwd = Core.node( this.target );
		const path = cwd && typeof cwd.target === 'string' ? cwd.target : '';
		const intervalMs = this.interval_ms || 1000;
		if (
			( now - this.lastFired ) * 1000 >= intervalMs ||
			path !== this.lastPath
		) {
			this.lastFired = now;
			this.lastPath = path;
			this.counter += 1;
			this.sink.fill( this._pollMessage( 'dump_metadata' ) );
		}
	}

	fill( message ) {
		this.counter += 1;
		const value = message[ VALUE ];
		const meta =
			value && typeof value === 'object' ? value.payload ?? value : value;
		if ( meta === null || meta === undefined || meta === '' ) {
			return;
		}
		const parsed = parseMetadata( meta );
		// Scale the self-managed poll cadence to the graph we just received.
		this.interval_ms = computePollIntervalMs( parsed.nodes.length );
		this.setState( 'metadata', parsed );
	}
}
