/**
 * revertIncludes — the expand-error backstop, expressed as the verb that owns
 * includes rather than as a rewrite of the field it owns.
 *
 * Remove-only on purpose: the last-good tree lags a removal until the next
 * successful expand, so rewriting from it wholesale would resurrect an include
 * the operator had just dropped.
 *
 * @param {Object}   interpreter The draft interpreter.
 * @param {Object}   lastGood    `topologies expand`'s `tree` — keyed by the
 *                               direct includes that resolved.
 * @param {Function} run         The draft's `run( line )`.
 */
export function revertIncludes( interpreter, lastGood, run ) {
	const good = lastGood || {};
	for ( const name of interpreter.includes.slice() ) {
		if ( ! ( name in good ) ) {
			run( `remove_include ${ name }` );
		}
	}
}
