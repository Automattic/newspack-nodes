/**
 * useLayout — fetch/save canvas-position layouts (`layouts.get` / `.save`)
 * through the graph, decoupled from topology TSL.
 *
 * Two nodes, not one: a get and a save can be in flight at once, and a node
 * carries a single command. Splitting them is what keeps the reply
 * unambiguous without an op-id.
 */

import { useCallback, useMemo } from '@wordpress/element';
import useRequestNode from '@newspack-nodes/shared/hooks/useRequestNode';
import { formatCommandArgs } from '../../runtime/command-args';

/**
 * Mount the two layout Request nodes and expose their commands.
 *
 * `fetchLayout` takes the topology name whose saved canvas positions to read.
 * `saveLayout` takes that name plus a positions map — canvas node id to an
 * `[ x, y ]` pair — which it sends as one JSON token. Both resolve with the
 * server's reply payload, `{ name, positions }`, and reject on a command
 * error.
 *
 * @return {{ fetchLayout: Function, saveLayout: Function }} The two senders.
 */
export function useLayout() {
	const get = useRequestNode( 'layouts:get', 'layouts' );
	const save = useRequestNode( 'layouts:save', 'layouts' );

	const fetchLayout = useCallback(
		( name ) => get( 'get', formatCommandArgs( [ name ] ) ),
		[ get ]
	);
	// save <name> <positions-json>: name + JSON blob as one token.
	const saveLayout = useCallback(
		( { name, positions } ) =>
			save(
				'save',
				formatCommandArgs( [ name, JSON.stringify( positions ) ] )
			),
		[ save ]
	);

	return useMemo(
		() => ( { fetchLayout, saveLayout } ),
		[ fetchLayout, saveLayout ]
	);
}
