/**
 * Parse a `dump_metadata` payload (object keyed by node name) into
 * { nodes, edges }. `target` is a string or array (Tee fan-out); the backbone
 * (`_command_interpreter` + `_router`) is hidden — it's the rule-#2 plumbing
 * every node sinks through — and everything else is shown.
 */

const SCAFFOLDING = new Set( [ '_command_interpreter', '_router' ] );

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

		// An edge connects to the HEAD of the target path — `_router` peels the
		// first `/`-segment and delivers there (`_sse/workers` → the `_sse` node).
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
