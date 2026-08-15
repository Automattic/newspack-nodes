/**
 * useLayout — canvas-position layouts (`layouts get` / `layouts save`), on the
 * batched tick and decoupled from the topology TSL.
 *
 * Two hooks' worth of nodes, not one: a get and a save can be outstanding at
 * once, and a node carries a single command. Splitting them is what keeps each
 * reply unambiguous without an op-id.
 *
 * The get is a READ, so it retries until an answer lands — a layout that never
 * arrives leaves the canvas waiting rather than auto-fitting. The save is a
 * write and goes exactly once.
 */

import { useCallback } from '@wordpress/element';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { formatCommandArgs } from '../../runtime/command-args';

const LAYOUTS = 'layouts';

/**
 * @param {Object}   [o]           Reply handlers, each fired once per reply.
 * @param {Function} [o.onFetched] `( { result, error, args } ) => void`; a
 *                                 refusal means no saved layout, and `args[0]`
 *                                 names the topology it was asked for.
 * @param {Function} [o.onSaved]   Same shape, for the write.
 * @return {{fetchLayout: (name: string) => void, saveLayout: (o: {name: string, positions: Object}) => void}}
 *   `fetchLayout()` asks for a topology's saved positions; `saveLayout()`
 *   writes them. Neither returns a promise — the answer arrives at the handler.
 */
export function useLayout( { onFetched, onSaved } = {} ) {
	const { run: runGet } = useCommandOnce( {
		ci: LAYOUTS,
		command: 'get',
		retry: true,
		onDone: onFetched,
	} );
	const { run: runSave } = useCommandOnce( {
		ci: LAYOUTS,
		command: 'save',
		onDone: onSaved,
	} );

	const fetchLayout = useCallback(
		( name ) => runGet( formatCommandArgs( [ name ] ) ),
		[ runGet ]
	);

	// save <name> <positions-json>: name + JSON blob as one token.
	const saveLayout = useCallback(
		( { name, positions } ) =>
			runSave(
				formatCommandArgs( [ name, JSON.stringify( positions ) ] )
			),
		[ runSave ]
	);

	return { fetchLayout, saveLayout };
}
