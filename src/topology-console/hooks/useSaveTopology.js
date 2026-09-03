/**
 * useSaveTopology — `topologies save`, as a one-shot on the batched tick.
 *
 * A save writes the user TSL file and restarts every fleet running that
 * topology, so it must go exactly once: a replayed save restarts those fleets
 * a second time. That is why it is a `useCommandOnce` and not a poll.
 *
 * `save()` hands back no Promise. The server replies TO=FROM, so the answer
 * lands on this hook's own result node and reaches the caller through `onDone`
 * (ADR-7).
 *
 * `useCommandOnce` names each send by its first token, so the topology name —
 * never the TSL body — is what addresses the reply. A body in that position is
 * a document rather than an identity, and past 128 characters it is dropped.
 */

import { useCallback } from '@wordpress/element';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { formatCommandArgs } from '../../runtime/command-args';

/** @typedef {import('@newspack-nodes/shared/hooks/useCommandOnce').OnDone} OnDone */

/**
 * Mounts the `topologies save` verb on the console's batched tick.
 *
 * @param {OnDone} [onDone] Runs once per reply. `args[0]` is the topology the
 *                          reply answered for, and `result` carries the verb's
 *                          `{name, path, shadows_stock, restarted_fleets}`;
 *                          `restarted_fleets` is what tells the operator which
 *                          workers the write took down and brought back.
 * @return {{save: ( o: {name: string, tsl: string} ) => void, pending: boolean}}
 *   `save()` parks the write for the next tick; `pending` holds while one is
 *   outstanding.
 */
export function useSaveTopology( onDone ) {
	const { run, pending } = useCommandOnce( {
		ci: 'topologies',
		command: 'save',
		onDone,
	} );

	// `save <name> <tsl…>`: name then the rest-of-line .tsl body.
	const save = useCallback(
		( { name, tsl } ) => run( formatCommandArgs( [ name, tsl ] ) ),
		[ run ]
	);

	return { save, pending };
}
