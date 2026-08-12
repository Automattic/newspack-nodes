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
	// Through `_shell` as a TARGET hop, like the Fetchers; absent off-console.
	const egress = Core.node( names.CONSOLE_TAP )
		? `${ names.CONSOLE_TAP }/${ names.HTTP }`
		: names.HTTP;
	return ci ? `${ egress }/${ ci }` : egress;
}

/**
 * Refuse a name already held by something that is not a Request node.
 *
 * Adoption below exists so two hooks can share ONE concern. Sharing a NAME
 * across classes is a different thing and always a bug: whoever mounts second
 * decides whether it throws a `makeNode` collision or silently sends its verbs
 * through a stranger. `vault:list` was both the overlay's Request node and the
 * Vault page's view.
 *
 * @param {Object} existing The node already registered under the name.
 * @param {string} node     The name.
 * @throws {Error} When the incumbent is not a Request node.
 */
function assertRequestNode( existing, node ) {
	if ( 'RequestNode' !== existing.constructor.name ) {
		throw new Error(
			`useRequestNode: ${ node } is already a ${ existing.constructor.name }`
		);
	}
}

/**
 * Mount a `Request` node on the CURRENT backbone, or re-point the one already
 * mounted under that name at it. THE mount sequence — the hook calls it too.
 *
 * Adoption re-points as well as returns: a graph rebuild replaces the
 * interpreter and the Tap under a surviving node, and one left sunk into the
 * torn-down interpreter drops every command it is handed.
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
		assertRequestNode( existing, node );
	}
	const interpreter = Core.node( names.COMMAND_INTERPRETER );
	if ( ! interpreter ) {
		return existing ?? null;
	}
	const request = existing ?? interpreter.makeNode( 'Request', node );
	// A new backbone means a new interpreter and Tap; re-derive both.
	request.sink = interpreter;
	request.target = targetFor( ci );
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
		const attach = () => ensureRequestNode( node, ci );
		attach();
		// The count lives ON the node, so Core.reset() discards both.
		const held = Core.node( node );
		held.holders = ( held.holders ?? 0 ) + 1;
		const offBackbone = Core.subscribeBackboneUp( attach );
		return () => {
			offBackbone();
			// @longform
			// Two hooks legitimately want the same concern — the console's
			// topology seed and the canonical-node read both ask
			// `topologies get`. The node is the concern, not this hook's
			// copy of it, so the LAST holder out removes it; otherwise the
			// first to unmount takes it with them and the other's next
			// request dies "is not mounted", or its in-flight one "was
			// removed".
			const live = Core.node( node );
			if ( live ) {
				live.holders = ( live.holders ?? 1 ) - 1;
				if ( 0 >= live.holders ) {
					live.removeNode();
				}
			}
			teardown();
		};
	}, [ node, ci, enabled ] );

	return useCallback(
		( verb, args = [] ) => requestVia( node, verb, args ),
		[ node ]
	);
}
