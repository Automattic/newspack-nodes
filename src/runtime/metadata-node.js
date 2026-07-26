/**
 * `_metadata` Node + the dump_metadata payload helpers. One file per
 * Tachikoma concept: producing a dump_metadata snapshot of Core.nodes,
 * parsing one back into a { nodes, edges } graph, and the Node subclass
 * that polls + publishes for the canvas via setState('metadata', ...).
 */

import { Core } from './core';
import { TimerNode } from './timer-node';
import { RouterNode } from './router-node';
import reservedNames from './reserved-node-names.json';
import { VALUE } from './message';

/**
 * Snapshot every registered node into a dump_metadata-shaped object keyed by
 * node name. Patron-linked nodes are plumbing and are skipped.
 *
 * @param {string} [only] Single node name to snapshot; '' (default) = all nodes.
 * @return {Object} Map of node name to { class, counter, sink, target, debug_state, arguments, lgst_msg, bytes_read, bytes_written }.
 */
export function dumpMetadataPayload( only = '' ) {
	const out = {};
	for ( const [ name, node ] of Core.nodes ) {
		if ( only && name !== only ) {
			continue;
		}
		if ( node.patron !== null && node.patron !== undefined ) {
			continue;
		}
		// Per-node port flags from the node's schema; default true if none.
		const schema = node.constructor?.nodeSchema?.() ?? null;
		// Shell name (strip `_Node`) so `class` matches the worker's.
		const ctorName = node.constructor?.name ?? 'Node';
		out[ name ] = {
			class: ctorName.replace( /Node$/, '' ) || ctorName,
			counter: node.counter ?? 0,
			sink: node.sink && node.sink.name ? node.sink.name : '',
			target: node.target ?? '',
			debug_state: node.debugState ?? 0,
			arguments: node.arguments ?? [],
			lgst_msg: node.largestMsgSent ?? 0,
			bytes_read: node.bytesRead ?? 0,
			bytes_written: node.bytesWritten ?? 0,
			accepts_fill: schema?.accepts_fill ?? true,
			has_target: schema?.has_target ?? true,
			// Has a `:config` sidecar iff that sibling node is registered.
			has_config: Core.nodes.has( `${ name }:config` ),
		};
		// Emit registrations only when non-empty (PHP-parity: `[]` vs `{}`).
		const registrations = node.registeredListeners();
		if ( Object.keys( registrations ).length ) {
			out[ name ].registrations = registrations;
		}
	}
	// FULL-snapshot header: reverse_cwd + router profiling-toggle truth.
	if ( '' === only ) {
		out._header = {
			pwd: reservedNames.OUTPUT,
			profiling: null !== RouterNode.profiles(),
		};
	}
	return out;
}

/**
 * Canonicalize a reply path to the SHELL's tail (`…/_output`). The
 * `_header.pwd` arrives ending in the POLLING node's reply segment
 * (`…/_sse:{pid}/_metadata`), but a Tee tail target (from a shell `connect_node`)
 * ends in `_output` — so the Connect/Disconnect toggle and its optimistic patch
 * must both compare on this canonical form. A bare (slash-less) or empty reply
 * path is returned unchanged.
 *
 * @param {string} rawPwd The raw reply path from `_header.pwd`.
 * @return {string} The reply path with its final reply-node segment forced to `_output`.
 */
export function canonicalReverseCwd( rawPwd ) {
	return ( rawPwd || '' ).replace( /\/[^/]+$/, `/${ reservedNames.OUTPUT }` );
}

// Backbone-only hiding: the probe is TSL-declared and shows like any node.
const SCAFFOLDING = new Set( [
	reservedNames.COMMAND_INTERPRETER,
	reservedNames.ROUTER,
] );

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
			return { nodes: [], edges: [], pwd: '', profiling: false };
		}
	} else {
		return { nodes: [], edges: [], pwd: '', profiling: false };
	}

	// `_header` reserved key: `pwd` = reply path, `profiling` = router state.
	const rawPwd =
		raw._header && typeof raw._header.pwd === 'string'
			? raw._header.pwd
			: '';
	const pwd = canonicalReverseCwd( rawPwd );
	const profiling = raw._header?.profiling === true;

	const nodes = [];
	const edges = [];
	for ( const [ name, meta ] of Object.entries( raw ) ) {
		if ( SCAFFOLDING.has( name ) || '_header' === name ) {
			continue;
		}
		// Full target paths, pre head-collapse; the toggle matches `pwd`.
		let targets = [];
		if ( Array.isArray( meta.target ) ) {
			targets = meta.target.filter(
				( t ) => typeof t === 'string' && t !== ''
			);
		} else if ( typeof meta.target === 'string' && meta.target !== '' ) {
			targets = [ meta.target ];
		}
		nodes.push( {
			id: name,
			count: typeof meta.counter === 'number' ? meta.counter : 0,
			sink: typeof meta.sink === 'string' ? meta.sink : '',
			class: typeof meta.class === 'string' ? meta.class : 'Node',
			debugState:
				typeof meta.debug_state === 'number' ? meta.debug_state : 0,
			arguments: Array.isArray( meta.arguments ) ? meta.arguments : [],
			lgstMsg: typeof meta.lgst_msg === 'number' ? meta.lgst_msg : 0,
			bytesRead:
				typeof meta.bytes_read === 'number' ? meta.bytes_read : 0,
			bytesWritten:
				typeof meta.bytes_written === 'number' ? meta.bytes_written : 0,
			// Per-node port flags; default true (canvas draws both ports).
			accepts_fill:
				typeof meta.accepts_fill === 'boolean'
					? meta.accepts_fill
					: true,
			has_target:
				typeof meta.has_target === 'boolean' ? meta.has_target : true,
			// Whether the node has a `:config` sidecar; default false.
			has_config: meta.has_config === true,
			targets,
			// Raw target: array for a Tee fan-out, else string.
			target: meta.target ?? '',
		} );
		const node = nodes[ nodes.length - 1 ];
		// Consumer read surface: offsetlog frames + cursor, when present.
		if ( Array.isArray( meta.frames ) ) {
			node.frames = meta.frames;
		}
		if ( meta.cursor && typeof meta.cursor === 'object' ) {
			node.cursor = meta.cursor;
		}
		// Dead-letter segment count (Triage badge); only when present.
		if ( typeof meta.deadletter_segments === 'number' ) {
			node.deadletter_segments = meta.deadletter_segments;
		}
		// Consumer poll state (`INIT`|`ACTIVE`|`PAUSED`); only when present.
		if ( typeof meta.polling === 'string' ) {
			node.polling = meta.polling;
		}
		// Cursor position; `null` is meaningful — test presence with `in`.
		if ( 'at_frame' in meta ) {
			node.at_frame =
				typeof meta.at_frame === 'number' ? meta.at_frame : null;
		}
		if ( 'on_frame' in meta ) {
			node.on_frame = !! meta.on_frame;
		}
		// Edge connects to the HEAD of the target path (`_router` peels).
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
		// Registration edges: emitter → each event listener (dashed).
		const regs = meta.registrations;
		if ( regs && typeof regs === 'object' ) {
			for ( const [ event, listeners ] of Object.entries( regs ) ) {
				if ( ! Array.isArray( listeners ) ) {
					continue;
				}
				for ( const listener of listeners ) {
					if ( typeof listener === 'string' && listener !== '' ) {
						edges.push( {
							from: name,
							to: headOf( listener ),
							registration: true,
							event,
						} );
					}
				}
			}
		}
	}
	return { nodes, edges, pwd, profiling };
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
		// Self-throttle state: lastFired (s), lastPath, pollIntervalMs.
		this.pollIntervalMs = 1000;
		this.lastFired = 0;
		this.lastPath = null;
	}

	fill( message ) {
		this.counter++;
		const value = message[ VALUE ];
		const isStruct = value && typeof value === 'object';
		const meta = isStruct ? value.payload ?? value : value;
		if ( meta === null || meta === undefined || meta === '' ) {
			return;
		}
		// Coerce to the raw name->meta object; keep it for future merges.
		let incoming = meta;
		if ( typeof meta === 'string' ) {
			try {
				incoming = JSON.parse( meta );
			} catch ( e ) {
				return;
			}
		}
		if ( ! incoming || typeof incoming !== 'object' ) {
			return;
		}
		this.rawMap = incoming;
		const parsed = parseMetadata( incoming );
		// Scale the self-managed poll cadence to the graph we just received.
		this.pollIntervalMs = computePollIntervalMs( parsed.nodes.length );
		this.setState( 'metadata', parsed );
	}

	// Router TIMER subscriber; self-throttle: poll on interval or a cwd change.
	fire() {
		if ( ! this.sink ) {
			return;
		}
		const now = Core.now();
		// Poll routes through `_cwd` (this.target); `.target` is the live cwd.
		const cwd = Core.node( this.target );
		const path = cwd && typeof cwd.target === 'string' ? cwd.target : '';
		const intervalMs = this.pollIntervalMs || 1000;
		if (
			( now - this.lastFired ) * 1000 >= intervalMs ||
			path !== this.lastPath
		) {
			this.lastFired = now;
			this.lastPath = path;
			this.counter++;
			this.sink.fill( this._pollMessage( 'dump_metadata' ) );
		}
	}

	// Poll TM_COMMAND to this.target (`_cwd`); FROM=name reply, LOCAL taints.
	_pollMessage( verb, args = [] ) {
		return this.mint( verb, args );
	}

	// Optimistic local edit: patch the raw map + re-publish, no round-trip.
	optimisticPatch( name, patch ) {
		if ( ! name ) {
			return;
		}
		const map = { ...( this.rawMap || {} ) };
		if ( null === patch ) {
			delete map[ name ];
		} else {
			map[ name ] = { ...( map[ name ] || {} ), ...patch };
		}
		this.rawMap = map;
		this.setState( 'metadata', parseMetadata( map ) );
	}

	// Fan one patch across every non-header entry in a SINGLE publish.
	optimisticPatchAll( patch ) {
		const map = { ...( this.rawMap || {} ) };
		for ( const name of Object.keys( map ) ) {
			if ( '_header' !== name ) {
				map[ name ] = { ...map[ name ], ...patch };
			}
		}
		this.rawMap = map;
		this.setState( 'metadata', parseMetadata( map ) );
	}

	static nodeSchema() {
		return {
			category: 'Hidden',
			description:
				'Receives `dump_metadata` poll reply; publishes for the canvas.',
			accepts_fill: false,
			arguments: [],
			commands: [],
		};
	}
}
