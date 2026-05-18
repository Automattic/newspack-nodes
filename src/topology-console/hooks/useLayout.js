/**
 * useLayout — fetch and save canvas-position layouts via the M4
 * CommandClient pipe (`layouts.get` / `.save`).
 *
 * Layouts are decoupled from topologies (a topology's TSL describes
 * graph structure; a layout file describes node positions). One
 * layout per topology name, stored server-side at
 * <base_directory>/layouts/<name>.layout.
 *
 * Returns:
 *   - fetchLayout(name) → Promise<{ name, positions: {id: [x,y]} | null }>
 *   - saveLayout({ name, positions }) → Promise<{ name, path, positions }>
 *
 * Per-action nonces are no longer required (see useSaveTopology for
 * the reasoning); auth is `manage_options` + the standard X-WP-Nonce
 * that CommandClient injects.
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
