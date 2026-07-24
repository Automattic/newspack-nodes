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

import { tokenize, tokenizeSpans } from '../../runtime/shell-node';

const VERB_ALIASES = {
	make: 'make_node',
	connect: 'connect_node',
	disconnect: 'disconnect_node',
};

// Mirrors PHP Topology_Registry::frontmatter(); value = raw trimmed after `=`.
const FRONTMATTER_RE = /^var\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/;

const CD_VERBS = new Set( [ 'cd', 'chdir' ] );
const STRUCTURAL = new Set( [
	'make_node',
	'connect_node',
	'disconnect_node',
	'include',
	'var',
] );

// Canonicalize leading-verb aliases (command_node before command: prefix).
function canonicalVerb( line ) {
	return line
		.replace( /^make\s+/, 'make_node ' )
		.replace( /^connect\s+/, 'connect_node ' )
		.replace( /^disconnect\s+/, 'disconnect_node ' )
		.replace( /^command_node\s+/, 'cmd ' )
		.replace( /^command\s+/, 'cmd ' );
}

// Resolve a relative/absolute cwd path (mirrors Shell_Node::cd).
function cdPath( cwd, p ) {
	if ( '/' !== p && '' !== p && '/' === p[ 0 ] ) {
		cwd = p;
	} else if ( '/' === p ) {
		cwd = '';
	} else if ( '' !== p && /^\.\.\/?/.test( p ) ) {
		cwd = cwd.replace( /\/?[^/]+$/, '' );
		cwd = cdPath( cwd, p.replace( /^\.\.\/?/, '' ) );
	} else if ( '' !== p ) {
		cwd += '/' + p;
	}
	return cwd.replace( /^\/+|\/+$/g, '' );
}

// Slash-join the cwd with a command's path arg (mirrors Shell_Node::prefix).
function prefixPath( cwd, p ) {
	const parts = [];
	if ( '' !== cwd ) {
		parts.push( cwd );
	}
	if ( '' !== p ) {
		parts.push( p );
	}
	return parts.join( '/' );
}

/**
 * Preprocess raw TSL into canonical single-line statements, mirroring the
 * runtime Shell and Topology_Registry::normalize_lines: join backslash
 * continuations, canonicalize make/connect/disconnect/command aliases, and
 * resolve cd/chdir cwd so a bare or explicit command line becomes
 * `cmd <cwd-resolved-path> <verb> <args>`.
 *
 * @param {string} text Raw TSL.
 * @return {string[]} Canonical lines (comments/blanks/cd dropped).
 */
function normalizeLines( text ) {
	const out = [];
	let cwd = '';
	let acc = '';
	for ( const raw of String( text || '' ).split( '\n' ) ) {
		// Backslash splice: ONE trailing \<newline> vanishes (Shell parity).
		const line0 = raw.replace( /\r$/, '' );
		if ( line0.endsWith( '\\' ) ) {
			acc += line0.slice( 0, -1 );
			continue;
		}
		const line = ( acc + raw ).trim();
		acc = '';
		if ( ! line || line.startsWith( '#' ) ) {
			continue;
		}
		const canonicalized = canonicalVerb( line );
		const tokens = tokenize( canonicalized );
		// Raw spans keep quote chars: quote TYPE carries interpolation intent.
		const spans = tokenizeSpans( canonicalized );
		const verb = tokens[ 0 ] || '';
		if ( CD_VERBS.has( verb ) ) {
			cwd = cdPath( cwd, tokens[ 1 ] || '' );
			continue;
		}
		if ( STRUCTURAL.has( verb ) ) {
			out.push( canonicalized );
		} else if ( 'cmd' === verb ) {
			const p = prefixPath( cwd, tokens[ 1 ] || '' );
			out.push( `cmd ${ p } ${ spans.slice( 2 ).join( ' ' ) }`.trim() );
		} else if ( '' !== cwd ) {
			// A bare verb inside a cwd is a command to that node.
			out.push(
				`cmd ${ cwd } ${ verb } ${ spans
					.slice( 1 )
					.join( ' ' ) }`.trim()
			);
		} else {
			// Bare verb at root: a local command the static parser drops.
			out.push( canonicalized );
		}
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

	const lines = normalizeLines( text );
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
		const spans = tokenizeSpans( line );
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
			// Raw spans: an authored quote type must survive the round-trip.
			const ctorArgs = spans.slice( 3 );
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
					args: spans.slice( 3 ),
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
