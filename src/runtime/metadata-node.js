/**
 * `_metadata` Node + the dump_metadata payload helpers. One file per
 * Tachikoma concept: producing a dump_metadata snapshot of Core.nodes,
 * parsing one back into a { nodes, edges } graph, and the Node subclass
 * that polls + publishes for the canvas via setState('metadata', ...).
 */

import { Core } from './core';
import { targetsOf } from './node';
import { PollerNode } from './poller-node';
import { VALUE, payloadOf } from './message';
import { RouterNode } from './router-node';
import reservedNames from './reserved-node-names.json';

/**
 * Snapshot every registered node into a dump_metadata-shaped object keyed by
 * node name. Patron-linked nodes are plumbing and are skipped.
 *
 * @param {string} [only]     Single node name to snapshot; '' = all nodes.
 * @param {Object} [registry] The name table to read; defaults to Core's.
 * @return {Object} Map of node name to { class, counter, sink, target, targets, debug_state, arguments, lgst_msg, bytes_read, bytes_written }.
 */
export function dumpMetadataPayload( only = '', registry = Core.registry ) {
	const out = {};
	for ( const [ name, node ] of registry.nodes ) {
		if ( only && name !== only ) {
			continue;
		}
		if ( node.patron !== null && node.patron !== undefined ) {
			continue;
		}
		// Per-node port flags from the node's schema; default true if none.
		const schema = node.constructor?.nodeSchema?.() ?? null;
		// Shell name, or the class a stub STANDS FOR — else the catalog misses.
		const ctorName = node.constructor?.name ?? 'Node';
		out[ name ] = {
			class:
				node.shellName || ctorName.replace( /Node$/, '' ) || ctorName,
			counter: node.counter ?? 0,
			sink: node.sink && node.sink.name ? node.sink.name : '',
			target: node.target ?? '',
			// Routing value vs display union; JS nodes declare no extras.
			targets: targetsOf( node ),
			debug_state: node.debugState ?? 0,
			arguments: node.arguments ?? [],
			lgst_msg: node.largestMsgSent ?? 0,
			bytes_read: node.bytesRead ?? 0,
			bytes_written: node.bytesWritten ?? 0,
			accepts_fill: schema?.accepts_fill ?? true,
			has_target: schema?.has_target ?? true,
			// Has a `:config` sidecar iff that sibling node is registered.
			has_config: registry.nodes.has( `${ name }:config` ),
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
 * One canvas node parsed out of a `dump_metadata` entry. Every field up to
 * `target` is always present (the parser defaults anything the payload omits);
 * the trailing fields appear only when the source node reported them.
 *
 * @typedef  {Object}          MetadataGraphNode
 * @property {string}          id                    Node name.
 * @property {number}          count                 Messages the node has handled.
 * @property {string}          sink                  Name of the physical sink node, '' when unwired.
 * @property {string}          class                 Shell class name; 'Node' when unreported.
 * @property {number}          debugState            Trace level; 0 is off.
 * @property {Array}           arguments             The node's `make_node` argument tokens.
 * @property {number}          lgstMsg               Largest message sent, in bytes.
 * @property {number}          bytesRead             Bytes read at this node's I/O boundary.
 * @property {number}          bytesWritten          Bytes written at this node's I/O boundary.
 * @property {boolean}         accepts_fill          Whether the canvas draws an input port.
 * @property {boolean}         has_target            Whether the canvas draws an output port.
 * @property {boolean}         has_config            Whether a `:config` sidecar node is registered.
 * @property {string[]}        targets               Display union — routing target plus declared extras, before head-collapse.
 * @property {string|string[]} target                Routing value: an array for a Tee fan-out, else a string.
 * @property {Array}           [frames]              Consumer read surface: offsetlog frames.
 * @property {Object}          [cursor]              Consumer read cursor.
 * @property {number}          [deadletter_segments] Dead-letter segment count (Triage badge).
 * @property {string}          [polling]             Consumer poll state: `INIT`, `ACTIVE`, or `PAUSED`.
 * @property {?number}         [at_frame]            Frame the cursor sits on; null when unset.
 * @property {boolean}         [on_frame]            Whether the cursor is parked on a frame.
 */

/**
 * A parsed `dump_metadata` payload, ready for the canvas.
 *
 * @typedef  {Object}              MetadataGraph
 * @property {MetadataGraphNode[]} nodes     Every shown node, backbone excluded.
 * @property {Array}               edges     `{ from, to }` links, plus `registration`/`event` for listener edges.
 * @property {string}              pwd       Canonical reply path from `_header.pwd`.
 * @property {boolean}             profiling Whether the router is profiling.
 */

/**
 * Parse a `dump_metadata` payload (object keyed by node name) into
 * { nodes, edges }. `target` is a string or array (Tee fan-out); the backbone
 * is hidden and everything else is shown.
 *
 * @param {Object|string} payload dump_metadata reply payload.
 * @return {MetadataGraph} Canvas-ready graph.
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

	/** @type {MetadataGraphNode[]} */
	const nodes = [];
	const edges = [];
	for ( const [ name, meta ] of Object.entries( raw ) ) {
		if ( SCAFFOLDING.has( name ) || '_header' === name ) {
			continue;
		}
		// Display union, pre head-collapse; older workers send `target` only.
		const targets = (
			Array.isArray( meta.targets )
				? meta.targets
				: [].concat( meta.target ?? [] )
		).filter( ( t ) => typeof t === 'string' && t !== '' );
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
		for ( const t of targets ) {
			edges.push( { from: name, to: headOf( t ) } );
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
 * Metadata — `_metadata`. A Poller on `dump_metadata`: it rides the `_router`
 * TIMER, mints the verb at the live cwd, and publishes the parsed graph for the
 * canvas ( useNodeState( '_metadata', 'metadata' ) ). It holds no throttle of
 * its own — the base times it on the shared grid, so this poll leaves in the
 * same POST as everything else due that tick — and a cwd change repaints at
 * once because the console `markDue()`s it where it repoints `_cwd`.
 */
export class MetadataNode extends PollerNode {
	/**
	 * Seed the `metadata` publish slot. The cadence starts at one tick and
	 * `publish()` rescales it to the graph it receives.
	 */
	constructor() {
		super();
		this.registrations.metadata = {};
		this.verb = 'dump_metadata';
		this.pollIntervalMs = 1000;
	}

	/**
	 * Reply leg. `dump_metadata` answers BARE as often as enveloped — the map
	 * itself, with no `payload` key — and the base unwrap returns null for
	 * that, deliberately, so a payload-less ack cannot blank a poller's grid.
	 * Here the bare object IS the answer.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
	fill( message ) {
		this.counter++;
		const value = message[ VALUE ];
		this.publish( payloadOf( value, value ) );
	}

	/**
	 * Take the `dump_metadata` reply — the base has already unwrapped the
	 * envelope — keep the raw name→meta map for later optimistic patches,
	 * rescale the cadence to the graph size, and publish the parsed graph.
	 * Anything that does not decode to an object is dropped.
	 *
	 * @param {*} meta The unwrapped payload: a name→meta object, or its JSON.
	 */
	publish( meta ) {
		if ( meta === null || meta === undefined || meta === '' ) {
			return;
		}
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
		// Scale the cadence to the graph, re-arming only when it changes.
		this.pollIntervalMs = computePollIntervalMs( parsed.nodes.length );
		// Re-arm only when the cadence actually moved (the substrate rule).
		if (
			'inactive' !== this.mode &&
			this.pollIntervalMs !== this.interval_ms
		) {
			this.setTimer( this.pollIntervalMs );
		}
		this.setState( 'metadata', parsed );
	}

	/**
	 * Optimistic local edit: merge `patch` into one entry of the raw map and
	 * re-publish, so the canvas reflects a verb before its reply lands. The
	 * next poll reconciles. Does nothing without a node name.
	 *
	 * @param {string}  name  Node name to patch.
	 * @param {?Object} patch Raw `dump_metadata` fields to merge; null removes the entry.
	 */
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

	/**
	 * Fan one patch across every non-header entry in a SINGLE publish — what a
	 * whole-graph verb such as `trace *` needs, so the canvas repaints once
	 * instead of once per node.
	 *
	 * @param {Object} patch Raw `dump_metadata` fields to merge into every node.
	 */
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

	/**
	 * Console palette entry — hidden, takes no arguments, and accepts no
	 * user-routed fill (its only input is its own poll reply).
	 */
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
