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
import { tokenize } from '../../runtime/shell-node';
import { boundArguments } from '../../runtime/schema-reflection';
import { CONFIG_TARGET_VERB_RE, withConfigEdges } from './consoleGraph';

/**
 * One `command_node` statement a node carries, declared or seeded.
 *
 * @typedef {import('../../runtime/draft-interpreter-node').Invocation} Invocation
 */

/**
 * One verb invocation in the shape the Inspector renders and edits.
 *
 * `viaConfig` rides along because it records the `:config` spelling the file
 * used, and `dumpDocument` writes that same spelling back.
 *
 * @param {Invocation} inv A declared or seeded invocation.
 * @return {Invocation} Its display shape.
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
 * Split a broker's `<source>:<target>` pair at its first colon outside
 * `<…>`, so a `<ns:key>` token in the source stays whole. A token with no
 * such colon is all source. The twin of PHP `Remote_Source_Node::split_pair()`,
 * held to it by `tests/fixtures/pair-split.json`; it validates nothing.
 *
 * @param {string} token One pair token.
 * @return {{source:string,target:string}} The two halves.
 * @testonly Exported so the parity test can pin it to the PHP twin.
 */
export function splitPair( token ) {
	let depth = 0;
	for ( let at = 0; at < token.length; at++ ) {
		const char = token[ at ];
		if ( '<' === char ) {
			depth++;
		} else if ( '>' === char && depth > 0 ) {
			depth--;
		} else if ( ':' === char && 0 === depth ) {
			return {
				source: token.slice( 0, at ),
				target: token.slice( at + 1 ),
			};
		}
	}
	return { source: token, target: '' };
}

/**
 * How many leading arguments a class binds, read off its schema: the specs
 * before the trailing `variadic`.
 *
 * @param {Array<Object>} catalog   Class catalog entries.
 * @param {string}        className Shell class.
 * @return {number} The bound argument count.
 * @throws {Error} When the catalog holds no such class.
 */
function boundCount( catalog, className ) {
	const entry = catalog.find( ( c ) => c.shell_name === className );
	if ( ! entry ) {
		throw new Error( `The class catalog holds no ${ className }.` );
	}
	return boundArguments( entry.arguments ).length;
}

/**
 * Whether a class is a broker: its catalog entry declares the variadic
 * `pairs` argument that `Remote_Broker_Node` gives every broker.
 *
 * @param {Array<Object>} catalog   Class catalog entries.
 * @param {string}        className A shell class name.
 * @return {boolean} True for a broker.
 */
function isBroker( catalog, className ) {
	const entry = catalog.find( ( c ) => c.shell_name === className );
	return Boolean(
		entry?.arguments?.some( ( a ) => 'pairs' === a.name && a.variadic )
	);
}

/**
 * The pair tokens a node's arguments carry: a broker's past its bound
 * arguments, and a `Vault_Group`'s past its own and the child's, since the
 * group passes each member `[ vault_id, ...child_args ]`. The group stands
 * for its members, which only the Vault names.
 *
 * @param {string}        className The node's shell class.
 * @param {Array<string>} spans     Its constructor arguments, as written.
 * @param {Array<Object>} catalog   Class catalog entries.
 * @return {Array<string>} The pair values, none for any other class.
 */
function pairTokens( className, spans, catalog ) {
	// The broker reads values, so a quoted span is read as the value it holds.
	const valuesOf = () =>
		spans.map( ( span ) => tokenize( String( span ) )[ 0 ] ?? '' );
	if ( isBroker( catalog, className ) ) {
		return valuesOf().slice( boundCount( catalog, className ) );
	}
	const childClass = tokenize( String( spans[ 0 ] ?? '' ) )[ 0 ] ?? '';
	if ( 'Vault_Group' === className && isBroker( catalog, childClass ) ) {
		return valuesOf().slice(
			boundCount( catalog, className ) +
				boundCount( catalog, childClass ) -
				1
		);
	}
	return [];
}

/**
 * Read a draft interpreter into the graph the console draws.
 *
 * Every node in the interpreter's own registry becomes one record. The first
 * target is `target` and the rest are `also`, while `edges` carries a
 * `connect` entry for each of them, so a fan-out node keeps every connection
 * it declared. A broker draws a `pair` edge to each pair's target, skipping a
 * pair with an empty half as the broker refuses it. A borrowed node — one an
 * include supplies — carries `origin`,
 * `via` and `fansOut` as well, and the invocations that include supplied are
 * marked `seeded`: the flag is what lets the Inspector lock those rows and
 * drop them before a save writes the document's own half back.
 *
 * A `set_*target` verb on a borrowed node ALSO becomes a `configOverrides`
 * entry, because the expansion may already carry a config-role edge for that
 * slot and an edge list cannot express vacating one: `withConfigEdges` does
 * that before drawing the new endpoint. An argument-less setter rides with an
 * empty `to`, which is the document saying the slot is now empty.
 *
 * @param {Object} interpreter The draft interpreter to read.
 * @return {Object} `{ nodes, edges, includes, frontmatter, secureLevel,
 *                     configOverrides, resolvedConfigEdges }` — the console's
 *                     draft graph, config edges already folded in.
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
		// A borrowed broker's pair edges arrive seeded with its include.
		const pairs = borrowed
			? []
			: pairTokens(
					node.shellClassName(),
					node.arguments || [],
					interpreter.catalog
			  );
		for ( const { source, target } of pairs.map( splitPair ) ) {
			if ( '' !== source && '' !== target ) {
				edges.push( { from: name, to: target, roles: [ 'pair' ] } );
			}
		}
		// A borrowed node's slot may already hold an edge the include drew.
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
 * Read a stored TSL source into a graph, composed with its include expansion.
 *
 * The interpreter it builds is a throwaway, so reading a file registers
 * nothing: it names itself `_command_interpreter` in a registry of its own,
 * never in Core, and never touches the document the console is editing.
 *
 * @param {string}  tsl                   Topology source.
 * @param {?Object} expansion             `topologies expand` result for its includes, or null.
 * @param {Array}   catalog               Class catalog: which classes fan out, and where a broker's pairs start.
 * @param {Array}   [resolvedConfigEdges] Server-resolved `<ns:key>` targets.
 * @return {Object} The console's graph shape.
 */
export function graphFromTsl(
	tsl,
	expansion,
	catalog,
	resolvedConfigEdges = null
) {
	if ( ! Array.isArray( catalog ) ) {
		throw new Error( 'graphFromTsl needs the class catalog.' );
	}
	const interpreter = new DraftInterpreterNode();
	interpreter.catalog = catalog;
	interpreter.load( tsl || '', expansion, resolvedConfigEdges );
	return draftToGraph( interpreter );
}
