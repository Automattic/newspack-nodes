/**
 * useDeleteTopology — dispatch `topologies.delete` via the M4 CommandClient.
 *
 * Removes the operator-saved copy of a topology from `{user_dir}/`.
 * Stock TSL files (shipped with plugins) are never touched — the
 * verb throws "no user-saved topology named: <name>" if there's no
 * user copy. After a successful delete, the topology either reverts
 * to its stock copy (if one exists) or disappears from the list
 * entirely; callers should refetch the list to pick up either case.
 *
 * Returns the server's verb payload verbatim:
 *   { name, deleted, stock_fallback }
 *
 * Per-action nonces are no longer required (see useSaveTopology for the
 * reasoning); auth is `manage_options` + the standard X-WP-Nonce that
 * CommandClient injects.
 */

import { useCallback } from '@wordpress/element';
import { getCommandClient } from '../utils/commandClient';
import unwrapCommandResponse from '../utils/unwrapCommandResponse';

export function useDeleteTopology() {
	return useCallback( async ( { name } ) => {
		const message = await getCommandClient().send( {
			to: 'topologies',
			verb: 'delete',
			args: { name },
		} );
		return unwrapCommandResponse( message );
	}, [] );
}
