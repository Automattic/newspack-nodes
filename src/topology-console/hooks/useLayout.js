/**
 * useLayout — fetch/save canvas-position layouts (`layouts.get` / `.save`),
 * decoupled from topology TSL. Returns { fetchLayout, saveLayout }.
 */

import { useCallback } from '@wordpress/element';
import { formatCommandArgs } from '../../runtime/command-args';
import { getCommandClient } from '../utils/commandClient';
import unwrapCommandResponse from '../utils/unwrapCommandResponse';

export function useLayout() {
	const fetchLayout = useCallback( async ( name ) => {
		const message = await getCommandClient().send( {
			to: 'layouts',
			verb: 'get',
			args: formatCommandArgs( [ name ] ),
		} );
		return unwrapCommandResponse( message );
	}, [] );

	const saveLayout = useCallback( async ( { name, positions } ) => {
		const message = await getCommandClient().send( {
			to: 'layouts',
			verb: 'save',
			// save <name> <positions-json>: name + JSON blob as one token.
			args: formatCommandArgs( [ name, JSON.stringify( positions ) ] ),
		} );
		return unwrapCommandResponse( message );
	}, [] );

	return { fetchLayout, saveLayout };
}
