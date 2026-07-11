/**
 * parseTsl — inverse of serializeTsl. Parses make_node / cmd / connect_node
 * statements into an edit-mode draft graph; substitution patterns pass
 * through unchanged and anything unrecognized is silently dropped.
 */

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
		const verb = tokens[ 0 ];
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
			const colonIdx = target.indexOf( ':config' );
			const ownerName =
				colonIdx > 0 ? target.slice( 0, colonIdx ) : target;
			const owner = nodesByName.get( ownerName );
			if ( ! owner ) {
				continue;
			}
			owner.verbInvocations.push( {
				verb: tokens[ 2 ],
				args: tokens.slice( 3 ),
			} );
		} else if ( verb === 'connect_node' && tokens.length >= 3 ) {
			edges.push( { from: tokens[ 1 ], to: tokens[ 2 ] } );
		}
	}

	return { nodes, edges, frontmatter };
}
