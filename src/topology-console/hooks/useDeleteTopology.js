/**
 * useDeleteTopology — `topologies delete` (user copy only; stock TSL is never
 * touched), as a one-shot on the batched tick.
 *
 * A delete must go exactly once, which is why it is a `useCommandOnce` and not
 * a poll: a replayed delete races its own "no such topology" refusal.
 */

import { useCallback } from '@wordpress/element';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { formatCommandArgs } from '../../runtime/command-args';

/**
 * @param {Function} onDone `( { result, error, args } ) => void`, fired once per
 *                          reply; `args[0]` is the topology that was deleted.
 * @return {{remove: ( o: {name: string} ) => void, pending: boolean}}
 *   `remove()` parks the delete for the next tick.
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
