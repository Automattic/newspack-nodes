/**
 * useSaveTopology — dispatch `topologies.save`. On verb error,
 * unwrapCommandResponse throws with the validation message in `.message`.
 */

import { useCallback } from '@wordpress/element';
import { getCommandClient } from '../utils/commandClient';
import unwrapCommandResponse from '../utils/unwrapCommandResponse';

export function useSaveTopology() {
	return useCallback( async ( { name, tsl } ) => {
		const message = await getCommandClient().send( {
			to: 'topologies',
			verb: 'save',
			payload: { name, tsl },
		} );
		return unwrapCommandResponse( message );
	}, [] );
}
