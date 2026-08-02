/**
 * useSaveTopology — dispatch `topologies.save` through the graph. On verb
 * error the returned Promise rejects with the validation message.
 */

import { useCallback } from '@wordpress/element';
import useRequestNode from '@newspack-nodes/shared/hooks/useRequestNode';
import { formatCommandArgs } from '../../runtime/command-args';

export function useSaveTopology() {
	const request = useRequestNode( 'topologies:save', 'topologies' );
	// `save <name> <tsl…>`: name then the rest-of-line .tsl body.
	return useCallback(
		( { name, tsl } ) =>
			request( 'save', formatCommandArgs( [ name, tsl ] ) ),
		[ request ]
	);
}
