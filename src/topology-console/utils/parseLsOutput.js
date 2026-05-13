/**
 * Parse the `ls -al` / `ls -als` text body emitted by Newspack_Nodes
 * CommandInterpreter.
 *
 * `ls -al` rows:
 *
 *   COUNT NAME                 TARGET
 *    1334 firehose:consumer    -> firehose:tee
 *    1334 firehose:tee         -> request-builder, job-router
 *    1335 job-router           -> jobs:partition
 *
 * `ls -als` rows include an additional SINK column between NAME and TARGET:
 *
 *   COUNT NAME                 SINK                   TARGET
 *    1334 firehose:consumer    > _command_interpreter -> firehose:tee
 *    2076 _router              -                      -
 *
 * Returns { nodes: [{ id, count, sink? }], edges: [{ from, to }] }. The
 * `sink` field is present only when the input is `-als` (carries SINK).
 * Edges are derived only from the TARGET column — sinks are framework-
 * default fall-throughs and almost always point to scaffolding
 * (_command_interpreter / _router) which we already filter out, so
 * drawing them on the canvas would add noise without insight. Surface
 * the sink in the Inspector instead.
 *
 * Comma-separated targets become multiple edges. The
 * `_command_interpreter`, `_router`, `_output`, and `_repl` scaffolding
 * nodes are excluded — they're substrate plumbing the user doesn't
 * need to see on the canvas.
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
