/**
 * Parse a `dump_metadata` JSON response into the shape the canvas
 * and inspector expect.
 *
 * Input is a substrate `dump_metadata` payload: an object keyed by
 * node name with `{ class, counter, sink, target, debug_state,
 * arguments }`. `target` is a string for single-target nodes or an
 * array for Tee fan-outs.
 *
 * Output:
 *   {
 *     nodes: [
 *       { id, count, sink, klass, debugState, arguments },
 *       ...
 *     ],
 *     edges: [ { from, to }, ... ]
 *   }
 *
 * Scaffolding nodes (_command_interpreter, _router, _output, _repl)
 * are excluded — same filtering parseLsOutput applied — so the
 * canvas keeps showing only the application graph. Inspector
 * navigation links also fall back to dim styling for any target
 * that resolves to a filtered node id.
 */

const SCAFFOLDING = new Set( [
	'_command_interpreter',
	'_router',
	'_output',
	'_repl',
] );

export function parseMetadata( payload ) {
	let raw;
	if ( typeof payload === 'string' ) {
		try {
			raw = JSON.parse( payload );
		} catch ( e ) {
			return { nodes: [], edges: [] };
		}
	} else if ( payload && typeof payload === 'object' ) {
		raw = payload;
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
			klass: typeof meta.class === 'string' ? meta.class : 'Node',
			debugState:
				typeof meta.debug_state === 'number' ? meta.debug_state : 0,
			arguments: typeof meta.arguments === 'string' ? meta.arguments : '',
			lgstMsg: typeof meta.lgst_msg === 'number' ? meta.lgst_msg : 0,
			bytesRead:
				typeof meta.bytes_read === 'number' ? meta.bytes_read : 0,
			bytesWritten:
				typeof meta.bytes_written === 'number' ? meta.bytes_written : 0,
		} );

		const target = meta.target;
		if ( Array.isArray( target ) ) {
			for ( const t of target ) {
				if ( typeof t === 'string' && t !== '' ) {
					edges.push( { from: name, to: t } );
				}
			}
		} else if ( typeof target === 'string' && target !== '' ) {
			edges.push( { from: name, to: target } );
		}
	}
	return { nodes, edges };
}
