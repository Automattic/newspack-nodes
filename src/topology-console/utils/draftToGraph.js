/**
 * draftToGraph — the document's READ, and the only thing outside the runtime
 * that touches a draft interpreter's internals.
 *
 * The console's view layer wants `{ nodes, edges, includes, … }`; the draft is
 * a node table. This is the whole adapter between them, and it is a READ: it
 * derives, never decides. Anything that looks like a decision here belongs in
 * the interpreter, where a TSL verb can reach it.
 *
 * `seededInvocationsFor`, `declaredInvocationsFor` and `seededEdges` exist on
 * the interpreter FOR this function — they are its read API, not incidental
 * accessors. Nothing else should call them, and `DraftContext` is the only
 * caller of this module for a live document, so the boundary holds by having
 * exactly one crossing.
 *
 * `_repl` is NOT added here. The worker's auto-mounted anchor is a canvas
 * fact, not something a topology file says, and a document read that invents
 * a node is a document read that lies.
 *
 * `x`/`y` are always zero. Positions are layout, saved and loaded separately
 * from the document — a node's coordinates are not something a topology file
 * says, so they are not something the draft knows.
 */

import { DraftInterpreterNode } from '../../runtime/draft-interpreter-node';
import { targetsOf } from '../../runtime/node';
import { CONFIG_TARGET_VERB_RE, withConfigEdges } from './consoleGraph';

/**
 * @param {Object} inv A verb invocation.
 * @return {Object} Its display shape; `viaConfig` keeps the form the file used.
 */
function invocation( inv ) {
	// COPY: the graph becomes the dirty-check baseline.
	return {
		verb: inv.verb,
		args: ( inv.args ?? [] ).slice(),
		viaConfig: inv.viaConfig,
	};
}

/**
 * @param {Object} interpreter The draft interpreter.
 * @return {Object} `{ nodes, edges, includes, frontmatter, secureLevel,
 *                     configOverrides }` — the console's draft graph.
 */
export function draftToGraph( interpreter ) {
	const nodes = [];
	const edges = [];
	const configOverrides = [];

	for ( const [ name, node ] of interpreter.childRegistry.nodes ) {
		const declared = interpreter.declaredInvocationsFor( name );
		const borrowed = true === node.borrowed;
		const targets = targetsOf( node );
		nodes.push( {
			id: name,
			name,
			class: node.shellClassName(),
			x: 0,
			y: 0,
			target: targets[ 0 ] ?? '',
			also: targets.slice( 1 ),
			ctorArgs: ( node.arguments || [] ).slice(),
			verbInvocations: [
				...interpreter.seededInvocationsFor( name ).map( ( inv ) => ( {
					...invocation( inv ),
					seeded: true,
				} ) ),
				...declared.map( invocation ),
			],
			...( borrowed
				? {
						origin: node.origin || [],
						via: node.via || [],
						fansOut: node.fansOut,
				  }
				: {} ),
		} );
		for ( const to of targets ) {
			edges.push( { from: name, to, roles: [ 'connect' ] } );
		}
		// A file line retargeting a borrowed node has no verbInvocation home.
		if ( borrowed ) {
			for ( const inv of declared ) {
				if ( inv.viaConfig && CONFIG_TARGET_VERB_RE.test( inv.verb ) ) {
					configOverrides.push( {
						from: name,
						slot: inv.verb,
						to: inv.args[ 0 ] || '',
					} );
				}
			}
		}
	}

	return withConfigEdges( {
		nodes,
		edges: [ ...edges, ...interpreter.seededEdges() ],
		includes: interpreter.includes.slice(),
		frontmatter: { ...interpreter.frontmatter },
		secureLevel: interpreter.secureLevel,
		configOverrides,
		resolvedConfigEdges: interpreter.resolvedConfigEdges,
	} );
}

/**
 * Read a TSL source into a graph, composed with its include expansion.
 *
 * A throwaway interpreter: it is a READER, and it names itself
 * `_command_interpreter` inside its own registry, never in Core.
 *
 * @param {string} tsl                   Topology source.
 * @param {Object} [expansion]           `topologies expand` result for its includes.
 * @param {Array}  [catalog]             Class catalog; decides which classes fan out.
 * @param {Array}  [resolvedConfigEdges] Server-resolved `<ns:key>` targets.
 * @return {Object} The console's graph shape.
 */
export function graphFromTsl(
	tsl,
	expansion = null,
	catalog = [],
	resolvedConfigEdges = null
) {
	const interpreter = new DraftInterpreterNode();
	interpreter.catalog = catalog;
	interpreter.load( tsl || '', expansion, resolvedConfigEdges );
	return draftToGraph( interpreter );
}
