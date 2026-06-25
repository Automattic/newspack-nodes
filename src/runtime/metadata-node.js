/**
 * `_metadata` Node + the dump_metadata payload helpers. One file per
 * Tachikoma concept: producing a dump_metadata snapshot of Core.nodes,
 * parsing one back into a { nodes, edges } graph, and the Node subclass
 * that polls + publishes for the canvas via setState('metadata', ...).
 */

import { Core } from './core';
import { TimerNode } from './timer-node';
import reservedNames from './reserved-node-names.json';
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
		// Per-node port flags from the node's own schema; default true so the
		// canvas draws both ports when the class declares no static schema.
		const schema = node.constructor?.nodeSchema?.() ?? null;
		// Shell name (strip the `_Node` suffix) so the in-browser tier reports the
		// SAME `class` the worker does (`Tee`, not `TeeNode`) — the Inspector's
		// `type === 'Tee'` checks and the catalog keying both depend on it.
		const ctorName = node.constructor?.name ?? 'Node';
		out[ name ] = {
			class: ctorName.replace( /Node$/, '' ) || ctorName,
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
		// Emit registrations only when non-empty, keeping this producer byte-identical
		// with the PHP one (PHP `[]` vs JS `{}` would diverge if always emitted).
		const registrations = node.registeredListeners();
		if ( Object.keys( registrations ).length ) {
			out[ name ].registrations = registrations;
		}
	}
	// Reserved header carrying THIS session's reply pivot (reverse_cwd) — only on a
	// FULL snapshot, not a single-node refresh delta. For the in-browser interpreter
	// that pivot is the bare Dumper `_output` (the exact FROM a local
	// `connect_node <tee>` stores), which the Inspector matches to toggle
	// Connect/Disconnect. The worker tier stamps its own (`_repl/…/_sse:{pid}/…`).
	if ( '' === only ) {
		out._header = { pwd: reservedNames.OUTPUT };
	}
	return out;
}

/**
 * Canonicalize a reply-pivot path to the SHELL's tail (`…/_output`). The
 * `_header.pwd` arrives ending in the POLLING node's reply segment
 * (`…/_sse:{pid}/_metadata`), but a Tee tail target (from a shell `connect_node`)
 * ends in `_output` — so the Connect/Disconnect toggle and its optimistic patch
 * must both compare on this canonical form. A bare (slash-less) or empty pivot is
 * returned unchanged.
 *
 * @param {string} rawPwd The raw reply pivot from `_header.pwd`.
 * @return {string} The pivot with its final reply-node segment forced to `_output`.
 */
export function canonicalReplyPivot( rawPwd ) {
	return ( rawPwd || '' ).replace( /\/[^/]+$/, `/${ reservedNames.OUTPUT }` );
}

// Process plumbing hidden from the canvas: the rule-#2 backbone every node sinks
// through, plus the per-worker TopicProbe + its shared log (auto-mounted by
// Worker_Base, present in every worker's dump_metadata but not part of any
// topology the operator authored).
const SCAFFOLDING = new Set( [
	reservedNames.COMMAND_INTERPRETER,
	reservedNames.ROUTER,
	reservedNames.TOPICPROBE,
	reservedNames.TOPICPROBE_LOG,
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
			return { nodes: [], edges: [], pwd: '' };
		}
	} else {
		return { nodes: [], edges: [], pwd: '' };
	}

	// `_header` is the one reserved (non-node) key: the producer (worker or local
	// Core) stamps `pwd` = THIS session's reply pivot. It arrives ending in the
	// POLLING node's reply segment (`…/_sse:{pid}/_metadata`, since the canvas
	// polls FROM `_metadata`), but a Tee tail target — what the toggle matches —
	// ends in the SHELL's reply node `_output` (`connect_node` uses the shell's
	// reply path). Canonicalize the final segment to `_output` so the two agree.
	// Skipped in the node loop so it never renders as a phantom node.
	const rawPwd =
		raw._header && typeof raw._header.pwd === 'string'
			? raw._header.pwd
			: '';
	const pwd = canonicalReplyPivot( rawPwd );

	const nodes = [];
	const edges = [];
	for ( const [ name, meta ] of Object.entries( raw ) ) {
		if ( SCAFFOLDING.has( name ) || '_header' === name ) {
			continue;
		}
		// Full target paths, before the edge head-collapse below. The Inspector's
		// Connect/Disconnect toggle matches THIS session's reply pivot (`pwd`)
		// against these, since the head-collapsed edges flatten every session's
		// pivot to a single shared `_repl` and can no longer distinguish them.
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
			targets,
			// Raw target as reported: an array for a Tee-family fan-out node, a
			// string otherwise. The Inspector keys its multi-target editor and
			// tail/tap button off Array.isArray( target ) — subclass-proof.
			target: meta.target ?? '',
		} );
		const node = nodes[ nodes.length - 1 ];
		// A Consumer's read surface (dump_metadata_extra): the offsetlog keyframe
		// frames + the live cursor. Threaded through only when present so a
		// non-consumer node carries no extra keys — that's the Inspector's
		// consumer signal (node.frames + node.cursor), no class-name list.
		if ( Array.isArray( meta.frames ) ) {
			node.frames = meta.frames;
		}
		if ( meta.cursor && typeof meta.cursor === 'object' ) {
			node.cursor = meta.cursor;
		}
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
		// Registration edges: emitter -> each listener of each event. Dashed
		// (registration:true) + event-tooltip'd downstream in SchematicCanvas.
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
	return { nodes, edges, pwd };
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

	fill( message ) {
		this.counter += 1;
		const value = message[ VALUE ];
		const isStruct = value && typeof value === 'object';
		const meta = isStruct ? value.payload ?? value : value;
		if ( meta === null || meta === undefined || meta === '' ) {
			return;
		}
		// Coerce to the raw name->meta object so we can keep it for future merges.
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
		this.interval_ms = computePollIntervalMs( parsed.nodes.length );
		this.setState( 'metadata', parsed );
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

	// Build a poll TM_COMMAND addressed to this.target (the `_cwd` node, which
	// re-stamps the live cwd). FROM = own name is the reply pivot; LOCAL taints
	// it so the browser interpreter authorizes a local poll.
	_pollMessage( verb, args = '' ) {
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = this.name;
		m[ TO ] = this.target;
		m[ VALUE ] = { name: verb, arguments: args };
		m[ LOCAL ] = true;
		return m;
	}

	// Optimistic local edit after a gesture (drop / remove / connect / disconnect):
	// mutate the kept raw map and re-publish so the canvas updates AT ONCE, with no
	// dump_metadata round-trip (which races the gesture command to a worker and can
	// read stale state). `patch === null` removes the node; otherwise it
	// shallow-merges into the existing entry (seeding a new one for a drop). The
	// next full poll overwrites rawMap with authoritative state, reconciling any
	// approximation here (e.g. a Tee's full fan-out).
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
