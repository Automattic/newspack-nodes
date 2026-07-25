/**
 * parseTsl — inverse of serializeTsl. Parses make_node / cmd / connect_node /
 * disconnect_node / include / var statements into an edit-mode draft graph;
 * substitution patterns pass through unchanged and anything unrecognized is
 * silently dropped.
 *
 * The line preprocessing (statement splitting, backslash continuation, alias
 * canonicalization, cd/prefix cwd) is the shared front-end
 * Shell_Node::parseStatements — parity-pinned against the PHP one. This file
 * only assembles the draft graph from the resulting statement list.
 *
 * `includes`, `edges`, and `disconnects` retain the public draft shape.
 * `edgeOperations` also records connect/disconnect source order so hand-written
 * TSL folds exactly like the interpreter after the include baseline is loaded.
 * `configOverrides` retains target setters for borrowed nodes, which are not in
 * the collapsed file's make_node set and therefore cannot own verbInvocations.
 */

import { parseStatements } from '../../runtime/shell-node';

export function parseTsl( text ) {
	const nodesByName = new Map();
	const nodes = [];
	const edges = [];
	const frontmatter = {};
	const includes = [];
	const disconnects = [];
	const edgeOperations = [];
	const configOverrides = [];

	for ( const { verb, values, spans } of parseStatements( text ) ) {
		if ( 'var' === verb ) {
			// Mirror PHP frontmatter(): first-`=` split over the joined tail.
			const assignment = values.slice( 1 ).join( ' ' );
			const eq = assignment.indexOf( '=' );
			const key = -1 === eq ? '' : assignment.slice( 0, eq ).trim();
			if ( '' !== key ) {
				frontmatter[ key ] = assignment.slice( eq + 1 ).trim();
			}
		} else if ( 'include' === verb && values.length >= 2 ) {
			if ( ! includes.includes( values[ 1 ] ) ) {
				includes.push( values[ 1 ] );
			}
		} else if ( 'make_node' === verb && values.length >= 3 ) {
			const name = values[ 2 ];
			const node = {
				id: name,
				name,
				class: values[ 1 ],
				x: 0,
				y: 0,
				target: '',
				also: [],
				// Raw spans: an authored quote type survives the round-trip.
				ctorArgs: spans.slice( 3 ),
				verbInvocations: [],
			};
			nodesByName.set( name, node );
			nodes.push( node );
		} else if ( 'command_node' === verb && values.length >= 3 ) {
			// Strip trailing `:config`; bare token is the owner node's name.
			const target = values[ 1 ];
			const configTarget = target.endsWith( ':config' );
			const ownerName = configTarget
				? target.slice( 0, -':config'.length )
				: target;
			const owner = nodesByName.get( ownerName );
			if ( owner ) {
				owner.verbInvocations.push( {
					verb: values[ 2 ],
					args: spans.slice( 3 ),
				} );
			} else if (
				configTarget &&
				/^set_\w*target$/.test( values[ 2 ] )
			) {
				configOverrides.push( {
					from: ownerName,
					slot: values[ 2 ],
					to: values[ 3 ] || '',
				} );
			}
		} else if ( 'connect_node' === verb && values.length >= 3 ) {
			const edge = { from: values[ 1 ], to: values[ 2 ] };
			edges.push( edge );
			edgeOperations.push( { type: 'connect', ...edge } );
		} else if ( 'disconnect_node' === verb && values.length >= 2 ) {
			// Defer source semantics until the included node record is loaded.
			const disconnect = { from: values[ 1 ] };
			if ( values.length >= 3 ) {
				disconnect.to = values[ 2 ];
			}
			disconnects.push( disconnect );
			edgeOperations.push( { type: 'disconnect', ...disconnect } );
		}
	}

	return {
		nodes,
		edges,
		frontmatter,
		includes,
		disconnects,
		edgeOperations,
		configOverrides,
	};
}
