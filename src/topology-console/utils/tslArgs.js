/**
 * tslArgs — how a draft argument becomes the text of a TSL line.
 *
 * Split out of `serializeTsl`, whose graph-rendering half the draft
 * interpreter's `dumpDocument` replaced. This half survived because it is not
 * about graphs at all: it is the quoting rule, and the live-drop modal needs
 * the same one so its `make_node` matches what the editor would write.
 */

import { serializeDraftArg as emitDraftArg } from '../../runtime/shell-node';

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
 * Fill empty slots in `args` from `spec[i].default`; author values win.
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
 * Serialize positional ctor-arg values into the `make_node` args string
 * (defaults filled, trailing empties dropped, whitespace single-quoted).
 *
 * @param {Array} ctorArgs Positional arg values.
 * @param {Array} spec     Schema arg list (each entry may carry `default`).
 * @return {string} Space-joined args (empty string if none remain).
 */
export function serializeCtorArgs( ctorArgs, spec ) {
	const filled = applyDefaults( ctorArgs || [], spec );
	return trimTrailingEmpties( filled ).map( emitDraftArg ).join( ' ' );
}
