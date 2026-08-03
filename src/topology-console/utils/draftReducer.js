/**
 * draftReducer — the console's draft document as a reducer.
 *
 * `draftGraph`'s functions are already `( graph, args ) => newGraph`, which is
 * a reducer's signature. This adds the naming and the routing, nothing else:
 * every case delegates to the matching pure function, and none of them changes.
 *
 * Action types are the TSL VERBS, not the JS helper names. That is the whole
 * point — the draft's mutation vocabulary and the grammar are the same
 * vocabulary, so promoting this to a `Draft_Node` whose `fill()` takes these as
 * commands is a substrate swap rather than a redesign.
 *
 * Two entries are not verbs, and both are deliberate:
 *
 *   - `remove_include` is editor-only. TSL `include` is additive at parse time;
 *     there is no "uninclude", and inventing one would put a word in the
 *     grammar that no topology can contain.
 *   - `set_arguments` IS a Tachikoma verb (CommandInterpreter.pm) but is not
 *     ported to this substrate yet. Named for the verb regardless, so the port
 *     needs no rename here.
 *
 * `DRAFT_ACTIONS` exists so a test can assert the above rather than trusting a
 * comment — a new action that is neither a verb nor a declared exception fails
 * the suite and forces the decision.
 */

import {
	addNode,
	removeNode,
	addInclude,
	removeInclude,
	renameNode,
	removeEdge,
	connectDraftEdge,
	updateNodeArgs,
	updateNodeVerbs,
} from './draftGraph';

/**
 * Every action type this reducer answers to.
 *
 * @testonly Exists for the verb-parity assertion, not for callers.
 * @type {string[]}
 */
export const DRAFT_ACTIONS = [
	'make_node',
	'remove_node',
	'connect_node',
	'disconnect_node',
	'move_node',
	'set_arguments',
	'cmd',
	'include',
	'remove_include',
	'var',
	'secure',
];

/**
 * @param {Object} state  The draft graph: { nodes, edges, frontmatter }.
 * @param {Object} action { type, ...args } — type is a TSL verb.
 * @return {Object} The next draft graph; the SAME object for an unknown type.
 */
export function draftReducer( state, action ) {
	switch ( action.type ) {
		case 'make_node':
			return addNode( state, {
				shellName: action.shellName,
				name: action.name,
				x: action.x,
				y: action.y,
			} );
		case 'remove_node':
			return removeNode( state, action.id );
		case 'connect_node':
			return connectDraftEdge(
				state,
				action.from,
				action.to,
				action.catalog ?? []
			);
		case 'disconnect_node':
			return removeEdge( state, action.from, action.to );
		case 'move_node':
			return renameNode( state, action.id, action.newName );
		case 'set_arguments':
			return updateNodeArgs( state, action.id, action.ctorArgs );
		case 'cmd':
			return updateNodeVerbs( state, action.id, action.verbInvocations );
		case 'include':
			return addInclude( state, action.name );
		case 'remove_include':
			return removeInclude( state, action.name );
		case 'var':
			return { ...state, frontmatter: action.frontmatter };
		case 'secure':
			return { ...state, secureLevel: action.level };
		default:
			// Identity, so a stray dispatch cannot trigger a re-render.
			return state;
	}
}
