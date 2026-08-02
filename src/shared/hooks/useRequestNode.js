/**
 * useRequestNode — a `Request` node on the page's backbone, for one concern.
 *
 * A dashboard's one-shot verbs (save a topology, delete one, fetch a layout)
 * used to go out through a standalone one-shot fetch: its own
 * POST, outside the graph, skipping the `_http` lock/flush bracket the rest of
 * the tick batches into. This mounts a node instead — so the command rides the
 * same egress as everything else, and its reply routes back `TO = FROM`.
 *
 * ONE node per concern, which is what makes correlation unnecessary: a node
 * with a single in-flight command cannot mistake whose reply arrived. Two
 * concerns get two nodes, never one node and a table of op-ids.
 *
 *   const save = useRequestNode( 'topologies:save', 'topologies' );
 *   await save( 'save', formatCommandArgs( [ name, tsl ] ) );
 *
 * It rides as a PASSENGER: a bare `mountExospine()` brings the backbone up
 * without bumping the graph generation or owning it, so mounting one never
 * makes the console rebuild the graph it just built, and never leaves a
 * backbone standing that the console means to replace.
 */

import { useCallback, useEffect } from '@wordpress/element';
import {
	Core,
	mountExospine,
	reservedNames as names,
} from '@newspack-nodes/runtime';

/**
 * The egress path for a CI. An empty `ci` addresses the substrate interpreter
 * itself — a builtin like `taillog`, which no service CI owns.
 *
 * @param {string} ci The server CI name, or '' for the interpreter's builtins.
 * @return {string} The `target` path.
 */
function targetFor( ci ) {
	return ci ? `${ names.HTTP }/${ ci }` : names.HTTP;
}

/**
 * Mount a `Request` node on the CURRENT backbone if it is not there already.
 *
 * For a concern whose membership is only known at call time — one probe node
 * per remote server, say. A hook cannot mount those, and one shared node would
 * have to tell their replies apart; a node each has nothing to tell apart.
 *
 * @param {string} node The node's name.
 * @param {string} ci   The server CI its commands are addressed at.
 * @return {Object|null} The node, or null with no backbone to clip onto.
 */
export function ensureRequestNode( node, ci ) {
	const existing = Core.node( node );
	if ( existing ) {
		return existing;
	}
	const interpreter = Core.node( names.COMMAND_INTERPRETER );
	if ( ! interpreter ) {
		return null;
	}
	const request = interpreter.makeNode( 'Request', node );
	request.target = targetFor( ci );
	request.sink = Core.node( names.CONSOLE_TAP ) ?? interpreter;
	return request;
}

/**
 * Send through a mounted Request node from outside a component.
 *
 * The node's lifetime belongs to whichever `useRequestNode` mounted it; a name
 * that is not mounted rejects rather than mounting one nobody unmounts.
 *
 * @param {string}   node The mounted node's name.
 * @param {string}   verb Verb name.
 * @param {string[]} args Token array.
 * @return {Promise<*>} The reply payload.
 */
export function requestVia( node, verb, args = [] ) {
	const request = Core.node( node );
	if ( ! request ) {
		return Promise.reject( new Error( `${ node } is not mounted` ) );
	}
	return request.request( verb, args );
}

/**
 * @param {string}  node      The node's name, e.g. `topologies:save`.
 * @param {string}  ci        The server CI the command is addressed at.
 * @param {boolean} [enabled] False leaves the node — and the backbone — unmounted.
 * @return {Function} `( verb, args ) => Promise<payload>`.
 */
export default function useRequestNode( node, ci, enabled = true ) {
	useEffect( () => {
		if ( ! enabled ) {
			return undefined;
		}
		const { teardown } = mountExospine( undefined, { passenger: true } );
		// Re-point at the NEW interpreter; a torn-down one drops commands.
		const attach = () => {
			const interpreter = Core.node( names.COMMAND_INTERPRETER );
			const existing = Core.node( node );
			if ( existing ) {
				existing.sink = Core.node( names.CONSOLE_TAP ) ?? interpreter;
				return;
			}
			const request = interpreter.makeNode( 'Request', node );
			request.target = targetFor( ci );
			// Through `_shell`, the Tap every command routes through.
			request.sink = Core.node( names.CONSOLE_TAP ) ?? interpreter;
		};
		attach();
		const offBackbone = Core.subscribeBackboneUp( attach );
		return () => {
			offBackbone();
			Core.node( node )?.removeNode();
			teardown();
		};
	}, [ node, ci, enabled ] );

	return useCallback(
		( verb, args = [] ) => requestVia( node, verb, args ),
		[ node ]
	);
}
