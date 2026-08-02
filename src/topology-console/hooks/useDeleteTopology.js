/**
 * useDeleteTopology — dispatch `topologies.delete` through the graph (user copy
 * only; stock TSL is never touched). Callers should refetch the list afterward.
 */

import { useCallback } from '@wordpress/element';
import useRequestNode from '@newspack-nodes/shared/hooks/useRequestNode';
import { formatCommandArgs } from '../../runtime/command-args';

export function useDeleteTopology() {
	const request = useRequestNode( 'topologies:delete', 'topologies' );
	return useCallback(
		( { name } ) => request( 'delete', formatCommandArgs( [ name ] ) ),
		[ request ]
	);
}
