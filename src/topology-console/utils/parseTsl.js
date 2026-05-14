/**
 * parseTsl — inverse of serializeTsl. Parse TSL text into an
 * edit-mode draft graph:
 *   { nodes: [{ id, name, class, ctorArgs, verbInvocations, ... }],
 *     edges: [{ from, to }] }
 *
 * Recognized statements (one per line; blank lines and `# comments`
 * are ignored):
 *   make_node <Class> <name> [<ctor args>]
 *   cmd <name>:config <verb> [<verb args>]
 *   connect_node <from> <to>
 *
 * The substitution patterns the loader handles (`<partition>`,
 * `<config:foo>`, etc.) pass through unchanged — they're authoring
 * hints, not values, so the editor surfaces them as-is until the
 * loader expands them at worker spawn time.
 *
 * Anything else is silently dropped — this is a permissive parser
 * for "open existing topology" round-tripping, not the canonical
 * validator. Server-side dry-run validation in the save endpoint
 * is the source of truth for syntax correctness.
 */

function tokenize( line ) {
	// Same single-quote-aware tokenization the substrate Shell uses,
	// trimmed for the editor's needs (no double-quote/backtick variants
	// — the serializer only emits single quotes).
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

	const lines = String( text || '' ).split( '\n' );
	for ( const raw of lines ) {
		const line = raw.trim();
		if ( ! line || line.startsWith( '#' ) ) {
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
			// `cmd <name>:config <verb> [<args>]` — strip the :config
			// suffix and look up the patron node.
			const target = tokens[ 1 ];
			const colonIdx = target.indexOf( ':config' );
			if ( colonIdx <= 0 ) {
				continue;
			}
			const ownerName = target.slice( 0, colonIdx );
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

	return { nodes, edges };
}
