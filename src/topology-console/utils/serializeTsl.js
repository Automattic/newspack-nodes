/**
 * serializeTsl — render an edit-mode draft graph as a TSL script.
 *
 * Output shape, one node per block:
 *   make_node <Class> <name> [<ctor args, space-separated>]
 *   cmd <name>:config <verb> [<verb args>]   (one per invocation)
 *
 * After all node blocks, a trailing line per edge:
 *   connect_node <from> <to>
 *
 * Ordering matches the substrate's `dump_config` so a draft -> save
 * -> reload round-trip produces a stable file (the editor's draft
 * order is preserved, edges follow nodes, and ctor args stay
 * positional).
 *
 * Quoting rule: any arg containing whitespace is wrapped in single
 * quotes. The shell tokenizer in `Shell::tokenize` handles single,
 * double, and backtick quotes; single quotes are the simplest
 * (no escape interpretation) so they're the safest default.
 *
 * Default expansion: when `schemas` is provided, empty positional
 * slots are filled from each arg's `default` before serialization.
 * The editor renders schema defaults (e.g. `<partition>`,
 * `<config:segment_size>`) as input placeholders without committing
 * them to `ctorArgs`, so without this expansion a save would emit a
 * make_node line missing every "default" arg — Topology_Loader would
 * then fall through to the node class's hard-coded literal defaults
 * (e.g. `Partition::DEFAULT_SEGMENT_SIZE`) instead of resolving the
 * operator's substrate-config values.
 *
 * Empty trailing string slots in ctorArgs are dropped AFTER default
 * expansion — they represent optional ctor parameters with no
 * authored value and no schema default, and emitting them as
 * literal empty tokens would shift positional indexing on the
 * substrate side.
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
 * Fill empty slots in `args` from `spec[i].default` when available.
 * Non-empty author-provided values always win; spec entries without a
 * default leave their slot empty (caller's trimTrailingEmpties drops
 * any that end up trailing).
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

function ctorSpecFor( schemas, className ) {
	if ( ! schemas ) {
		return [];
	}
	const entry = schemas[ className ];
	return entry && Array.isArray( entry.ctor ) ? entry.ctor : [];
}

function verbArgSpecFor( schemas, className, verbName ) {
	if ( ! schemas ) {
		return [];
	}
	const entry = schemas[ className ];
	if ( ! entry || ! Array.isArray( entry.verbs ) ) {
		return [];
	}
	const v = entry.verbs.find( ( x ) => x.name === verbName );
	return v && Array.isArray( v.args ) ? v.args : [];
}

function emitMakeNode( node, schemas ) {
	const spec = ctorSpecFor( schemas, node.class );
	const filled = applyDefaults( node.ctorArgs || [], spec );
	const args = trimTrailingEmpties( filled ).map( serializeArg );
	const head = `make_node ${ node.class } ${ node.name }`;
	return args.length ? `${ head } ${ args.join( ' ' ) }` : head;
}

function emitVerb( name, invocation, schemas, className ) {
	const spec = verbArgSpecFor( schemas, className, invocation.verb );
	const filled = applyDefaults( invocation.args || [], spec );
	const args = trimTrailingEmpties( filled ).map( serializeArg );
	const head = `cmd ${ name }:config ${ invocation.verb }`;
	return args.length ? `${ head } ${ args.join( ' ' ) }` : head;
}

/**
 * @param {Object} graph   Draft graph (nodes + edges + per-node verbInvocations).
 * @param {Object} schemas Optional class-name → schema map (`{ ctor, verbs, … }`).
 *                         Catalog's `classes` array maps directly:
 *                         Object.fromEntries(catalog.classes.map(c => [c.shell_name, c]))
 *                         When omitted, no default expansion happens — useful for
 *                         tests and any caller that has only the draft.
 */
export function serializeTsl( graph, schemas = null ) {
	if ( ! graph || ! graph.nodes || graph.nodes.length === 0 ) {
		return '';
	}
	const lines = [];
	for ( const n of graph.nodes ) {
		lines.push( emitMakeNode( n, schemas ) );
		for ( const inv of n.verbInvocations || [] ) {
			lines.push( emitVerb( n.name, inv, schemas, n.class ) );
		}
	}
	for ( const e of graph.edges || [] ) {
		lines.push( `connect_node ${ e.from } ${ e.to }` );
	}
	return lines.join( '\n' ) + '\n';
}
