/**
 * useDeleteTopology — dispatch `topologies.delete` through the graph (user copy
 * only; stock TSL is never touched). Callers should refetch the list afterward.
 */

import { useCallback } from '@wordpress/element';
import useRequestNode from '@newspack-nodes/shared/hooks/useRequestNode';
import { formatCommandArgs } from '../../runtime/command-args';

/**
 * Mount the `topologies:delete` Request node and hand back its dispatcher.
 *
 * @return {Function} `( { name } ) => Promise<*>`, where `name` is the user
 *                    topology to delete; the Promise settles on the verb's
 *                    reply, rejecting with its error message.
 */
export function useDeleteTopology() {
	const request = useRequestNode( 'topologies:delete', 'topologies' );
	return useCallback(
		( { name } ) => request( 'delete', formatCommandArgs( [ name ] ) ),
		[ request ]
	);
}
