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
 * Empty trailing string slots in ctorArgs are dropped — they
 * represent optional ctor parameters the user left blank, and
 * emitting them as literal empty tokens would shift positional
 * indexing on the substrate side.
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

function emitMakeNode( node ) {
	const args = trimTrailingEmpties( node.ctorArgs || [] ).map( serializeArg );
	const head = `make_node ${ node.class } ${ node.name }`;
	return args.length ? `${ head } ${ args.join( ' ' ) }` : head;
}

function emitVerb( name, invocation ) {
	const args = ( invocation.args || [] ).map( serializeArg );
	const head = `cmd ${ name }:config ${ invocation.verb }`;
	return args.length ? `${ head } ${ args.join( ' ' ) }` : head;
}

export function serializeTsl( graph ) {
	if ( ! graph || ! graph.nodes || graph.nodes.length === 0 ) {
		return '';
	}
	const lines = [];
	for ( const n of graph.nodes ) {
		lines.push( emitMakeNode( n ) );
		for ( const inv of n.verbInvocations || [] ) {
			lines.push( emitVerb( n.name, inv ) );
		}
	}
	for ( const e of graph.edges || [] ) {
		lines.push( `connect_node ${ e.from } ${ e.to }` );
	}
	return lines.join( '\n' ) + '\n';
}
