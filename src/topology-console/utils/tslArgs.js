/**
 * tslArgs — the rule turning a positional argument array into TSL text.
 *
 * Two console surfaces write the same arguments: the palette drop's new-node
 * modal, which emits the `make_node` args string, and the Inspector, whose
 * `setArgumentsLine` emits `set_arguments`. Both fill schema defaults, drop
 * trailing empties and quote through `serializeDraftArg`, so a node dropped
 * from the palette reads exactly like one the editor rewrites.
 */

import { boundArguments } from '../../runtime/schema-reflection';
import {
	scanTokens,
	serializeDraftArg as emitDraftArg,
} from '../../runtime/shell-node';

/**
 * Drop trailing empty and unset slots, so a TSL line ends at the last argument
 * the author set. Interior holes survive: positional slots are indexed, and
 * dropping one would shift every argument after it.
 *
 * @param {Array} args Positional arg values from the draft graph.
 * @return {Array} New array truncated at its last non-empty slot.
 */
export function trimTrailingEmpties( args ) {
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
 * Fill empty slots in `args` from `spec[i].default`; an author value wins.
 *
 * An empty token is not an absent one: PHP's `parse_schema_args` tests
 * `isset()`, so `''` reads as supplied, skips the declared default and coerces
 * an int argument to 0. Writing the default explicitly keeps the emitted line
 * meaning what the schema declares.
 *
 * The result covers every declared slot — its length is the longer of the
 * two inputs — and an empty slot with no default stays `''`, so every
 * position has a token to write. A `default` of `''` counts as none, and a
 * `spec` that is not an array reads as no declared arguments.
 *
 * @param {Array} args Positional arg values from the draft graph.
 * @param {Array} spec Schema arg list (each entry may carry `default`).
 * @return {Array} New array with defaults expanded into empty slots.
 */
export function applyDefaults( args, spec ) {
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

/**
 * Where a schema's trailing `variadic` begins.
 *
 * @param {?Array} spec Schema arg list.
 * @return {number} The variadic's slot, or Infinity when there is none.
 * @throws {Error} When a `variadic` spec is not the last.
 */
export function variadicStart( spec ) {
	const declared = Array.isArray( spec ) ? spec : [];
	const bound = boundArguments( declared ).length;
	return bound < declared.length ? bound : Infinity;
}

/**
 * The tokens a positional array writes: defaults filled, trailing empties
 * dropped, and a trailing `variadic` slot expanded into the raw spans the TSL
 * scanner reads in it, so a quoted word stays one token with its quote type
 * and blanks vanish. The one place both writers start from.
 *
 * @param {Array}  args Positional arg values; the variadic slot holds a string.
 * @param {?Array} spec Schema arg list (each entry may carry `default`).
 * @return {Array} The tokens to write, one per argument.
 */
export function positionalTokens( args, spec ) {
	const filled = trimTrailingEmpties( applyDefaults( args || [], spec ) );
	const last = variadicStart( spec );
	if ( filled.length <= last ) {
		return filled;
	}
	return [
		...filled.slice( 0, last ),
		...scanTokens( String( filled[ last ] ) ).tokens.map( ( t ) => t.raw ),
	];
}

/**
 * Bind a token array to the positional slots the schema declares.
 *
 * The parser whitespace-splits a `make_node` or `cmd` line's tail with no
 * schema knowledge, so a free-text argument or a variadic tail arrives as
 * several tokens. The tail collapses into the LAST slot, each token emitted
 * as TSL, so the scanner reads the same tokens back from the joined string.
 *
 * Idempotent: a list already at or under `count` is returned unchanged.
 *
 * @param {string[]} args  Token array: draft args, or a live node's `arguments`.
 * @param {number}   count Positional arguments the schema declares.
 * @return {string[]} Args of length <= count, the last slot absorbing the tail.
 */
export function absorbTrailingArgs( args, count ) {
	const list = Array.isArray( args ) ? args : [];
	if ( count <= 0 || list.length <= count ) {
		return list;
	}
	return [
		...list.slice( 0, count - 1 ),
		list
			.slice( count - 1 )
			.map( emitDraftArg )
			.join( ' ' ),
	];
}

/**
 * Serialize positional ctor-arg values into the `make_node` args string.
 *
 * Defaults fill the empty slots, trailing slots still without a value drop
 * off, and every surviving value goes through `serializeDraftArg`, which
 * leaves a value that already tokenizes to itself alone and quotes anything
 * else — whitespace, an unbalanced quote, a `#` or `;` that would otherwise
 * change the line. A non-string default, the schema's `4096`, stringifies
 * there too.
 *
 * @param {Array} ctorArgs Positional arg values; null reads as none.
 * @param {Array} spec     Schema arg list (each entry may carry `default`).
 * @return {string} Space-joined args, empty when no slot survives.
 */
export function serializeCtorArgs( ctorArgs, spec ) {
	return positionalTokens( ctorArgs, spec ).map( emitDraftArg ).join( ' ' );
}
