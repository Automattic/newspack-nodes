/**
 * tslArgs — the rule turning a positional argument array into TSL text.
 *
 * Two console surfaces write the same arguments: the palette drop's new-node
 * modal, which emits the `make_node` args string, and the Inspector, whose
 * `setArgumentsLine` emits `set_arguments`. Both fill schema defaults, drop
 * trailing empties and quote through `serializeDraftArg`, so a node dropped
 * from the palette reads exactly like one the editor rewrites.
 */

import { serializeDraftArg as emitDraftArg } from '../../runtime/shell-node';

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
	const filled = applyDefaults( ctorArgs || [], spec );
	return trimTrailingEmpties( filled ).map( emitDraftArg ).join( ' ' );
}
