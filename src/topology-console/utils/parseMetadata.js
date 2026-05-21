/**
 * Parse a `dump_metadata` response payload into the shape the canvas
 * and inspector expect.
 *
 * Input is the substrate `dump_metadata` payload — an OBJECT keyed by
 * node name with `{ class, counter, sink, target, debug_state,
 * arguments }`. Per the command protocol contract the response VALUE
 * (and its `payload`) ride through the whole-message JSON envelope as
 * nested objects, so callers hand this an object directly — never a
 * JSON string. A defensive string-parse fallback is retained only so a
 * stray serialized payload degrades gracefully instead of throwing.
 * `target` is a string for single-target nodes or an array for Tee
 * fan-outs.
 *
 * Output:
 *   {
 *     nodes: [
 *       { id, count, sink, class, debugState, arguments },
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
	if ( payload && typeof payload === 'object' ) {
		// Primary path: the contract hands us the metadata object directly.
		raw = payload;
	} else if ( typeof payload === 'string' ) {
		// Defensive fallback for a stray serialized payload.
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
