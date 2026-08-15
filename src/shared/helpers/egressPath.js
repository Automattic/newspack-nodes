import names from '../../runtime/reserved-node-names.json';

/**
 * The egress path a command targets: out through the observe-only `_shell` Tap,
 * then `_http`, then the server CI mount that owns the verb.
 *
 * One place, because it was five — a literal, a template over `names`, a
 * per-file `TARGET` const — across every hook that sends anything.
 *
 * @param {string} [ci] The server CI mount; omit for an interpreter builtin.
 * @return {string} The target path.
 */
export function egressPath( ci = '' ) {
	const egress = `${ names.CONSOLE_TAP }/${ names.HTTP }`;
	return ci ? `${ egress }/${ ci }` : egress;
}
