/**
 * useSaveTopology — dispatch `topologies.save`. On verb error,
 * unwrapCommandResponse throws with the validation message in `.message`.
 */

import { useCallback } from '@wordpress/element';
import { formatCommandArgs } from '../../runtime/command-args';
import { getCommandClient } from '../utils/commandClient';
import unwrapCommandResponse from '../utils/unwrapCommandResponse';

export function useSaveTopology() {
	return useCallback( async ( { name, tsl } ) => {
		const message = await getCommandClient().send( {
			to: 'topologies',
			verb: 'save',
			// `save <name> <tsl…>`: name then the rest-of-line .tsl body.
			args: formatCommandArgs( [ name, tsl ] ),
		} );
		return unwrapCommandResponse( message );
	}, [] );
}
