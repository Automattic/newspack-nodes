/**
 * serializeTsl — render an edit-mode draft graph as a TSL script.
 *
 * Emits `make_node`/`cmd` per node then `connect_node` per edge, ordered to
 * match the substrate's dump_config for a stable round-trip. Whitespace args
 * are single-quoted; with `schemas`, empty slots are filled from defaults and
 * trailing empties dropped (so positional indexing stays aligned).
 */

function serializeArg( value ) {
	const str = String( value );
	if ( /\s/.test( str ) ) {
		return `'${ str }'`;
	}
	return str;
}

function trimTrailingEmpties( args ) {
	const out = args.slice();
	while (
		out.length &&
		( out[ out.length - 1 ] === '' || out[ out.length - 1 ] === undefined )
	) {
		out.pop();
	}
	return out;
}

/**
 * Fill empty slots in `args` from `spec[i].default`; author values win.
 *
 * @param {Array} args Positional arg values from the draft graph.
 * @param {Array} spec Schema arg list (each entry may carry `default`).
 * @return {Array} New array with defaults expanded into empty slots.
 */
function applyDefaults( args, spec ) {
	const safeSpec = Array.isArray( spec ) ? spec : [];
	const length = Math.max( args.length, safeSpec.length );
	const out = [];
	for ( let i = 0; i < length; i++ ) {
		const raw = args[ i ];
		const isEmpty = raw === undefined || raw === '';
		if ( ! isEmpty ) {
			out.push( raw );
			continue;
		}
		const argSpec = safeSpec[ i ];
		if (
			argSpec &&
			argSpec.default !== undefined &&
			argSpec.default !== ''
		) {
			out.push( argSpec.default );
		} else {
			out.push( '' );
		}
	}
	return out;
}

function argumentsSpecFor( schemas, className ) {
	if ( ! schemas ) {
		return [];
	}
	const entry = schemas[ className ];
	return entry && Array.isArray( entry.arguments ) ? entry.arguments : [];
}

function commandArgSpecFor( schemas, className, commandName ) {
	if ( ! schemas ) {
		return [];
	}
	const entry = schemas[ className ];
	if ( ! entry || ! Array.isArray( entry.commands ) ) {
		return [];
	}
	const v = entry.commands.find( ( x ) => x.name === commandName );
	return v && Array.isArray( v.args ) ? v.args : [];
}

/**
 * Serialize positional ctor-arg values into the `make_node` args string
 * (defaults filled, trailing empties dropped, whitespace single-quoted). Shared
 * by the live-drop modal so its make_node matches edit-mode serialization.
 *
 * @param {Array} ctorArgs Positional arg values.
 * @param {Array} spec     Schema arg list (each entry may carry `default`).
 * @return {string} Space-joined args (empty string if none remain).
 */
export function serializeCtorArgs( ctorArgs, spec ) {
	const filled = applyDefaults( ctorArgs || [], spec );
	return trimTrailingEmpties( filled ).map( serializeArg ).join( ' ' );
}

function emitMakeNode( node, schemas ) {
	const spec = argumentsSpecFor( schemas, node.class );
	const filled = applyDefaults( node.ctorArgs || [], spec );
	const args = trimTrailingEmpties( filled ).map( serializeArg );
	const head = `make_node ${ node.class } ${ node.name }`;
	return args.length ? `${ head } ${ args.join( ' ' ) }` : head;
}

// True iff the class's catalog entry marks it a Command_Interpreter_Node.
function isInterpreterClass( schemas, className ) {
	if ( ! schemas ) {
		return false;
	}
	const entry = schemas[ className ];
	return !! ( entry && entry.is_interpreter );
}

function emitVerb( name, invocation, schemas, className ) {
	const spec = commandArgSpecFor( schemas, className, invocation.verb );
	const filled = applyDefaults( invocation.args || [], spec );
	const args = trimTrailingEmpties( filled ).map( serializeArg );
	// Interpreter nodes handle verbs directly (no `:config` sibling) → bare target.
	const target = isInterpreterClass( schemas, className )
		? name
		: `${ name }:config`;
	const head = `cmd ${ target } ${ invocation.verb }`;
	return args.length ? `${ head } ${ args.join( ' ' ) }` : head;
}

/**
 * @param {Object} graph   Draft graph (nodes + edges + per-node verbInvocations).
 * @param {Object} schemas Optional class-name → schema map; omitted = no default expansion.
 */
export function serializeTsl( graph, schemas = null ) {
	if ( ! graph ) {
		return '';
	}
	const hasFrontmatter =
		graph.frontmatter && Object.keys( graph.frontmatter ).length > 0;
	if ( ( ! graph.nodes || graph.nodes.length === 0 ) && ! hasFrontmatter ) {
		return '';
	}
	const lines = [];
	// Frontmatter first (raw `var name = value`, no quoting — values with spaces
	// round-trip verbatim through the PHP frontmatter parser). Insertion order
	// preserved for a byte-stable round-trip.
	for ( const [ name, value ] of Object.entries( graph.frontmatter || {} ) ) {
		lines.push( `var ${ name } = ${ value }` );
	}
	// Reserved anchors (e.g. `_repl`) are auto-mounted by the worker — the
	// editor never emits their make_node or any wiring FROM them. They remain
	// valid edge TARGETS.
	const reserved = new Set(
		graph.nodes.filter( ( n ) => n.reserved ).map( ( n ) => n.id )
	);
	for ( const n of graph.nodes ) {
		if ( n.reserved ) {
			continue;
		}
		lines.push( emitMakeNode( n, schemas ) );
		for ( const inv of n.verbInvocations || [] ) {
			lines.push( emitVerb( n.name, inv, schemas, n.class ) );
		}
	}
	for ( const e of graph.edges || [] ) {
		if ( reserved.has( e.from ) ) {
			continue;
		}
		lines.push( `connect_node ${ e.from } ${ e.to }` );
	}
	if ( lines.length === 0 ) {
		return '';
	}
	return lines.join( '\n' ) + '\n';
}
