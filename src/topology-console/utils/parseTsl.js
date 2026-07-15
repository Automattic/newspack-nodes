/**
 * parseTsl — inverse of serializeTsl. Parses make_node / cmd / connect_node /
 * disconnect_node / include statements into an edit-mode draft graph;
 * substitution patterns pass through unchanged and anything unrecognized is
 * silently dropped.
 *
 * `includes`, `edges`, and `disconnects` retain the public draft shape.
 * `edgeOperations` also records connect/disconnect source order so hand-written
 * TSL folds exactly like the interpreter after the include baseline is loaded.
 * `configOverrides` retains target setters for borrowed nodes, which are not in
 * the collapsed file's make_node set and therefore cannot own verbInvocations.
 */

const VERB_ALIASES = {
	make: 'make_node',
	connect: 'connect_node',
	disconnect: 'disconnect_node',
};

// Mirrors PHP Topology_Registry::frontmatter(); value = raw trimmed after `=`.
const FRONTMATTER_RE = /^var\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/;

function tokenize( line ) {
	// Single-quote-aware tokenization (serializer only emits single quotes).
	const out = [];
	let buf = '';
	let inQuote = false;
	for ( let i = 0; i < line.length; i++ ) {
		const ch = line[ i ];
		if ( "'" === ch ) {
			inQuote = ! inQuote;
			continue;
		}
		if ( ! inQuote && /\s/.test( ch ) ) {
			if ( buf.length ) {
				out.push( buf );
				buf = '';
			}
			continue;
		}
		buf += ch;
	}
	if ( buf.length ) {
		out.push( buf );
	}
	return out;
}

export function parseTsl( text ) {
	const nodesByName = new Map();
	const nodes = [];
	const edges = [];
	const frontmatter = {};
	const includes = [];
	const disconnects = [];
	const edgeOperations = [];
	const configOverrides = [];

	const lines = String( text || '' ).split( '\n' );
	for ( const raw of lines ) {
		const line = raw.trim();
		if ( ! line || line.startsWith( '#' ) ) {
			continue;
		}
		// Split on `;` to match PHP frontmatter() before the var regex.
		let capturedVar = false;
		for ( const seg of line.split( ';' ) ) {
			const fm = FRONTMATTER_RE.exec( seg.trim() );
			if ( fm ) {
				frontmatter[ fm[ 1 ] ] = fm[ 2 ].trim();
				capturedVar = true;
			}
		}
		if ( capturedVar ) {
			continue;
		}
		const tokens = tokenize( line );
		if ( tokens.length === 0 ) {
			continue;
		}
		// `make`/`connect`/`disconnect` are real interpreter aliases.
		const verb = VERB_ALIASES[ tokens[ 0 ] ] || tokens[ 0 ];
		if ( verb === 'include' && tokens.length >= 2 ) {
			if ( ! includes.includes( tokens[ 1 ] ) ) {
				includes.push( tokens[ 1 ] );
			}
			continue;
		}
		if ( verb === 'make_node' && tokens.length >= 3 ) {
			const className = tokens[ 1 ];
			const name = tokens[ 2 ];
			const ctorArgs = tokens.slice( 3 );
			const node = {
				id: name,
				name,
				class: className,
				x: 0,
				y: 0,
				target: '',
				also: [],
				ctorArgs,
				verbInvocations: [],
			};
			nodesByName.set( name, node );
			nodes.push( node );
		} else if ( verb === 'cmd' && tokens.length >= 3 ) {
			// Strip trailing `:config`; bare token is the owner node's name.
			const target = tokens[ 1 ];
			const configTarget = target.endsWith( ':config' );
			const ownerName = configTarget
				? target.slice( 0, -':config'.length )
				: target;
			const owner = nodesByName.get( ownerName );
			if ( owner ) {
				owner.verbInvocations.push( {
					verb: tokens[ 2 ],
					args: tokens.slice( 3 ),
				} );
			} else if (
				configTarget &&
				/^set_\w*target$/.test( tokens[ 2 ] )
			) {
				configOverrides.push( {
					from: ownerName,
					slot: tokens[ 2 ],
					to: tokens[ 3 ] || '',
				} );
			}
		} else if ( verb === 'connect_node' && tokens.length >= 3 ) {
			const edge = { from: tokens[ 1 ], to: tokens[ 2 ] };
			edges.push( edge );
			edgeOperations.push( { type: 'connect', ...edge } );
		} else if ( verb === 'disconnect_node' && tokens.length >= 2 ) {
			// Defer source semantics until the included node record is loaded.
			const disconnect = { from: tokens[ 1 ] };
			if ( tokens.length >= 3 ) {
				disconnect.to = tokens[ 2 ];
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
