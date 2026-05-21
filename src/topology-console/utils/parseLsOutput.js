/**
 * Parse the `ls -al` / `ls -als` text body into { nodes, edges }.
 *
 * Edges derive from the TARGET column only (sinks surface in the Inspector);
 * comma-separated targets fan out; scaffolding nodes are excluded.
 */

const SCAFFOLDING = new Set( [
	'_command_interpreter',
	'_router',
	'_output',
	'_repl',
] );

// `ls -als` row: COUNT NAME (> SINK | -) (-> TARGETS | -)
const RE_ALS = /^\s*(\d+)\s+(\S+)\s+(?:>\s*(\S+)|-)\s+(?:->\s*(.*)|-\s*)$/;

// `ls -al` row: COUNT NAME [-> TARGETS | -]
const RE_AL = /^\s*(\d+)\s+(\S+)(?:\s+(?:->\s*(.*)|-\s*))?$/;

export function parseLsOutput( text ) {
	const nodes = [];
	const edges = [];
	const lines = ( text || '' ).split( '\n' );
	for ( const raw of lines ) {
		const line = raw.trimEnd();
		if ( ! line || /^COUNT\b/.test( line ) ) {
			continue;
		}

		let countStr, name, sink, targetsStr;
		const alsMatch = line.match( RE_ALS );
		if ( alsMatch ) {
			[ , countStr, name, sink, targetsStr ] = alsMatch;
		} else {
			const alMatch = line.match( RE_AL );
			if ( ! alMatch ) {
				continue;
			}
			[ , countStr, name, targetsStr ] = alMatch;
			sink = undefined;
		}

		if ( SCAFFOLDING.has( name ) ) {
			continue;
		}

		const node = { id: name, count: parseInt( countStr, 10 ) };
		if ( sink !== undefined ) {
			node.sink = sink;
		}
		nodes.push( node );

		if ( targetsStr ) {
			for ( const target of targetsStr
				.split( ',' )
				.map( ( t ) => t.trim() ) ) {
				if ( target && target !== '-' ) {
					edges.push( { from: name, to: target } );
				}
			}
		}
	}
	return { nodes, edges };
}
