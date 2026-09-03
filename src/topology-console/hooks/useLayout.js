/**
 * useLayout — canvas-position layouts (`layouts get` / `layouts save`) on the
 * console's batched tick.
 *
 * A layout is stored apart from the topology it arranges, one file per name.
 * Positions written into the .tsl would route every drag through `topologies
 * save`, which restarts the matching active fleet.
 *
 * Two hooks' worth of nodes, not one: a get and a save can be outstanding at
 * once, and a node carries a single command. Splitting them is what keeps each
 * reply unambiguous without an op-id (ADR-7).
 *
 * The get is a READ, so it re-asks a request that goes missing. The console
 * holds the canvas until the layout resolves, and a lost reply would leave it
 * waiting instead of auto-fitting. The save is a write and goes exactly once.
 */

import { useCallback } from '@wordpress/element';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { formatCommandArgs } from '../../runtime/command-args';

/** @typedef {import('@newspack-nodes/shared/hooks/useCommandOnce').OnDone} OnDone */

/** The service CI both verbs are mounted on. */
const LAYOUTS = 'layouts';

/**
 * Mounts the `layouts get` and `layouts save` verbs on the console's batched
 * tick and hands back the sender for each.
 *
 * @param {Object} [o]           Reply handlers, each run once per reply.
 * @param {OnDone} [o.onFetched] Runs on the get's reply. `result` is `{name,
 *                               positions}`, and a null `positions` means
 *                               nothing is saved under that name; `args[0]`
 *                               names the topology it was asked for.
 * @param {OnDone} [o.onSaved]   Runs on the save's reply. `result` is `{name,
 *                               path, positions}`, the positions being the
 *                               entries that survived the server's validation.
 * @return {{fetchLayout: (name: string) => void, saveLayout: (o: {name: string, positions: Object}) => void}}
 *   `fetchLayout()` asks for a topology's saved positions; `saveLayout()`
 *   writes them, `positions` keying each node id to its `[x, y]` pair. Neither
 *   returns a promise — the answer arrives at the handler.
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

	/** Ask for one topology's saved positions by name. */
	const fetchLayout = useCallback(
		( name ) => runGet( formatCommandArgs( [ name ] ) ),
		[ runGet ]
	);

	/**
	 * Send `save <name> <positions-json>`, the blob whole in one token. The
	 * name leads, so the reply is addressed by it rather than by a body that
	 * would overrun the substrate's FROM cap.
	 */
	const saveLayout = useCallback(
		( { name, positions } ) =>
			runSave(
				formatCommandArgs( [ name, JSON.stringify( positions ) ] )
			),
		[ runSave ]
	);

	return { fetchLayout, saveLayout };
}
