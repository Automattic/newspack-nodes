/**
 * useSaveTopology — `topologies save`, as a one-shot on the batched tick.
 *
 * It used to mint its own POST from the Save button's callback and hand back a
 * Promise. The write now rides the same request as everything else that tick,
 * and what followed the await moves into `onDone`.
 */

import { useCallback } from '@wordpress/element';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { formatCommandArgs } from '../../runtime/command-args';
import names from '../../runtime/reserved-node-names.json';

/**
 * @param {Function} onDone `( { result, error, args } ) => void`, fired once per
 *                          reply; `args[0]` is the topology that was saved.
 * @return {{save: ( o: {name: string, tsl: string} ) => void, pending: boolean}}
 *   `save()` parks the write for the next tick; `pending` is what the button
 *   disables itself on.
 */
export function useSaveTopology( onDone ) {
	const { run, pending } = useCommandOnce( {
		scope: 'topologies:save',
		target: `${ names.CONSOLE_TAP }/${ names.HTTP }/topologies`,
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
