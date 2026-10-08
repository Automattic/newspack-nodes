import names from '../../runtime/reserved-node-names.json';
import { shellGroup } from '../../runtime/exospine';

/**
 * Compose the TO path a dashboard's command travels: out through its group's
 * observe-only `<group>:shell` Tap, then the `_http` egress that POSTs it, then
 * the server CI mount that owns the verb.
 *
 * Every hook that sends anything composes the path here, so the reserved names
 * are spelled once. The group's Tap stands while a mounted node targets this
 * path: `mountExospine` claims the group from that target itself. Targeting
 * `_http/<ci>` directly delivers the command just as well, which is what makes
 * skipping the Tap silent: `connect <group>:shell` stops seeing traffic that no
 * longer passes through it.
 *
 * @param {string} group The surface the command belongs to, which names the
 *                       Tap it passes: `url` for `url:shell`.
 * @param {string} [ci]  The server CI mount owning the verb. Omit it for a
 *                       command-interpreter builtin such as `dump_metadata`:
 *                       the path then stops at `_http`, and the command
 *                       reaches the server with an empty TO for
 *                       `_command_interpreter` to run itself.
 * @return {string} `<group>:shell/_http`, or `<group>:shell/_http/<ci>`.
 * @throws {TypeError} When the group is missing or no string.
 */
export function egressPath( group, ci = '' ) {
	const egress = `${ shellGroup( group ) }/${ names.HTTP }`;
	return ci ? `${ egress }/${ ci }` : egress;
}
