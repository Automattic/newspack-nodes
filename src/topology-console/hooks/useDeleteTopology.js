/**
 * useDeleteTopology — dispatch `topologies.delete` (user copy only; stock
 * TSL is never touched). Callers should refetch the list afterward.
 */

import { useCallback } from '@wordpress/element';
import { getCommandClient } from '../utils/commandClient';
import unwrapCommandResponse from '../utils/unwrapCommandResponse';

export function useDeleteTopology() {
	return useCallback( async ( { name } ) => {
		const message = await getCommandClient().send( {
			to: 'topologies',
			verb: 'delete',
			args: name,
		} );
		return unwrapCommandResponse( message );
	}, [] );
}
