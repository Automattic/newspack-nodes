import names from '../../runtime/reserved-node-names.json';

/**
 * Compose the TO path a browser-minted command travels: out through the
 * observe-only `_shell` Tap, then the `_http` egress that POSTs it, then the
 * server CI mount that owns the verb.
 *
 * Every hook that sends anything composes the path here, so the reserved names
 * are spelled once. Targeting `_http/<ci>` directly delivers the command just
 * as well, which is what makes skipping the Tap silent: `connect _shell` stops
 * seeing traffic that no longer passes through it.
 *
 * @param {string} [ci] The server CI mount owning the verb. Omit it for a
 *                      command-interpreter builtin such as `taillog`: the path
 *                      then stops at `_http`, and the command reaches the
 *                      server with an empty TO for `_command_interpreter` to
 *                      run itself.
 * @return {string} `_shell/_http`, or `_shell/_http/<ci>` when `ci` is given.
 */
export function egressPath( ci = '' ) {
	const egress = `${ names.CONSOLE_TAP }/${ names.HTTP }`;
	return ci ? `${ egress }/${ ci }` : egress;
}
