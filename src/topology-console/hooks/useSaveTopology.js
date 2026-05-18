/**
 * useSaveTopology — dispatch `topologies.save` via the M4 CommandClient.
 *
 * Returns the server's verb payload verbatim:
 *   { name, path, shadows_stock, restarted_fleets }
 * On verb error (validation failed, body too large, permission denied,
 * etc.) the underlying `unwrapCommandResponse` throws an Error whose
 * `.message` is the verb's RuntimeException text — e.g.
 * "validation failed at line 3: forbidden verb 'if'". Callers display
 * it via `e.message`.
 *
 * Per-action nonces are no longer required: the substrate's
 * `Command_Controller` gates on `manage_options` + the standard
 * `X-WP-Nonce` (`wp_rest` action) that CommandClient already injects
 * from `window.NewspackNodesData.nonce`. The legacy save_nonce
 * query-string dance was a workaround for apiFetch's nonce middleware
 * shadowing per-action nonces; CommandClient bypasses apiFetch.
 */

import { useCallback } from '@wordpress/element';
import { getCommandClient } from '../utils/commandClient';
import unwrapCommandResponse from '../utils/unwrapCommandResponse';

export function useSaveTopology() {
	return useCallback( async ( { name, tsl } ) => {
		const message = await getCommandClient().send( {
			to: 'topologies',
			verb: 'save',
			args: { name, tsl },
		} );
		return unwrapCommandResponse( message );
	}, [] );
}
