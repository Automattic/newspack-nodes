/**
 * useSaveTopology — dispatch `topologies.save` through the graph. On verb
 * error the returned Promise rejects with the validation message.
 */

import { useCallback } from '@wordpress/element';
import useRequestNode from '@newspack-nodes/shared/hooks/useRequestNode';
import { formatCommandArgs } from '../../runtime/command-args';

/**
 * Mount the `topologies:save` Request node and hand back its dispatcher.
 *
 * @return {Function} `( { name, tsl } ) => Promise<*>`, where `name` is the
 *                    user topology to write and `tsl` its full `.tsl` body;
 *                    the Promise settles on the verb's reply, rejecting with
 *                    the validation message when the topology does not parse.
 */
export function useSaveTopology() {
	const request = useRequestNode( 'topologies:save', 'topologies' );
	// `save <name> <tsl…>`: name then the rest-of-line .tsl body.
	return useCallback(
		( { name, tsl } ) =>
			request( 'save', formatCommandArgs( [ name, tsl ] ) ),
		[ request ]
	);
}
