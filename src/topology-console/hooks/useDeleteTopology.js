/**
 * useDeleteTopology — `topologies delete` (user copy only; stock TSL is never
 * touched), as a one-shot on the batched tick.
 *
 * A delete must go exactly once, which is why it is a `useCommandOnce` and not
 * a poll: a replayed delete races its own "no such topology" refusal.
 *
 * `remove()` hands back no Promise. The server replies TO=FROM, so the answer
 * lands on this hook's own result node and reaches the caller through `onDone`
 * (ADR-7).
 */

import { useCallback } from '@wordpress/element';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { formatCommandArgs } from '../../runtime/command-args';

/** @typedef {import('@newspack-nodes/shared/hooks/useCommandOnce').OnDone} OnDone */

/**
 * Mounts the `topologies delete` verb on the console's batched tick.
 *
 * @param {OnDone} [onDone] Runs once per reply. `args[0]` is the topology the
 *                          reply answered for, and `result` carries the verb's
 *                          `{name, deleted, stock_fallback, pruned_active,
 *                          restarted_fleets}`; `stock_fallback` is what tells
 *                          the operator a stock copy took the name back over.
 * @return {{remove: ( o: {name: string} ) => void, pending: boolean}}
 *   `remove()` parks the delete for the next tick; `pending` holds while one is
 *   outstanding.
 */
export function useDeleteTopology( onDone ) {
	const { run, pending } = useCommandOnce( {
		ci: 'topologies',
		command: 'delete',
		onDone,
	} );

	const remove = useCallback(
		( { name } ) => run( formatCommandArgs( [ name ] ) ),
		[ run ]
	);

	return { remove, pending };
}
