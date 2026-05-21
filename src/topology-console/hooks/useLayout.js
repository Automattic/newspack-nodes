/**
 * useLayout — fetch/save canvas-position layouts (`layouts.get` / `.save`),
 * decoupled from topology TSL. Returns { fetchLayout, saveLayout }.
 */

import { useCallback } from '@wordpress/element';
import { getCommandClient } from '../utils/commandClient';
import unwrapCommandResponse from '../utils/unwrapCommandResponse';

export function useLayout() {
	const fetchLayout = useCallback( async ( name ) => {
		const message = await getCommandClient().send( {
			to: 'layouts',
			verb: 'get',
			payload: { name },
		} );
		return unwrapCommandResponse( message );
	}, [] );

	const saveLayout = useCallback( async ( { name, positions } ) => {
		const message = await getCommandClient().send( {
			to: 'layouts',
			verb: 'save',
			payload: { name, positions },
		} );
		return unwrapCommandResponse( message );
	}, [] );

	return { fetchLayout, saveLayout };
}
