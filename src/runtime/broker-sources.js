/**
 * broker-sources — the browser's one fold of a broker's sources, the twin of
 * PHP `Remote_Broker_Node::fold_source()` and `sources_of()`, held to them by
 * `tests/fixtures/broker-sources.json`, which both suites read.
 *
 * Two readers fold through it: the `add_source` and `remove_source` verbs a
 * `RemoteLink`'s `:config` answers, and the console's TSL reader drawing a
 * broker's `pair` edges. Each refuses what a PHP broker refuses, in its words.
 */

import { fitsADirName, isGlob, isSubscription } from './log-stamp';

/** The verb a source comes by. */
export const ADD_SOURCE = 'add_source';

/** The verb that takes a source back. */
export const REMOVE_SOURCE = 'remove_source';

/** `Core::PARTITION_TOKEN`: the worker partition a source may name. */
const PARTITION_TOKEN = '{partition}';

/** A `<ns:key>` config token, which PHP resolves before it judges a source. */
const CONFIG_TOKEN = /<[^<>:\s]+:[^<>\s]+>/g;

/** `Remote_Broker_Node::RESERVED_KINDS`: the slots no reader may take. */
const RESERVED_KINDS = [ 'sse-in', 'http-out', 'null', 'config' ];

/** The two args `add_source` and `remove_source` bind, as PHP declares them. */
export const SOURCE_ARGS = [
	{
		name: 'remote_log',
		type: 'string',
		required: true,
		description: 'A spoke stamp, glob or `sources:<name>`.',
	},
	{
		name: 'local_node',
		type: 'string',
		required: true,
		description: 'The node its lines go to.',
	},
];

/**
 * A source declared to a broker, both halves as written.
 *
 * @typedef {{source:string,target:string}} DeclaredSource
 */

/**
 * The one source rule: the declared sources once one `add_source` or
 * `remove_source` applies, as PHP `Remote_Broker_Node::fold_source()` folds
 * them. A source goes to one target, compared as written; an identical
 * repeat answers `declared` itself; a removal must name a declared source;
 * an added source must be one a spoke can stream and whose reader takes no
 * slot a broker keeps, judged with `{partition}` resolved at `partition`.
 * A `<ns:key>` config token, which PHP resolves and the browser cannot,
 * stands for one name character, as a glob's `*` does in `isSubscription()`.
 *
 * @param {Array<DeclaredSource>} declared  The sources so far, as written.
 * @param {string}                verb      `add_source` or `remove_source`.
 * @param {string}                remoteLog The source, as written.
 * @param {string}                localNode Its target, as written.
 * @param {?number}               partition Where `{partition}` resolves;
 *                                          null where none is bound.
 * @return {Array<DeclaredSource>} The sources it leaves.
 * @throws {Error} In PHP's words: a second target, a removal naming no
 *   declared source, a source no spoke can stream, a kept slot, or
 *   `{partition}` where none is bound.
 */
export function foldSource( declared, verb, remoteLog, localNode, partition ) {
	const same = ( s ) => s.source === remoteLog && s.target === localNode;
	if ( REMOVE_SOURCE === verb ) {
		if ( ! declared.some( same ) ) {
			throw new Error(
				`${ verb } '${ remoteLog }' '${ localNode }' names no source this node declares`
			);
		}
		return declared.filter( ( s ) => ! same( s ) );
	}
	const taken = declared.find( ( s ) => s.source === remoteLog )?.target;
	if ( localNode === taken ) {
		return declared;
	}
	const refuse = ( why ) => {
		throw new Error( `${ verb } '${ remoteLog }' ${ why }` );
	};
	if ( undefined !== taken ) {
		refuse( `already goes to '${ taken }', not '${ localNode }'` );
	}
	if (
		null === partition &&
		( remoteLog.includes( PARTITION_TOKEN ) ||
			localNode.includes( PARTITION_TOKEN ) )
	) {
		refuse(
			`'${ localNode }' names ${ PARTITION_TOKEN }, but no partition is bound`
		);
	}
	const source = remoteLog
		.replaceAll( PARTITION_TOKEN, String( partition ?? 0 ) )
		.replace( CONFIG_TOKEN, 'a' );
	const glob = isGlob( source );
	if ( ! ( glob ? isSubscription( source ) : fitsADirName( source ) ) ) {
		refuse( 'names a source no spoke can stream' );
	}
	if ( ! glob && RESERVED_KINDS.includes( source ) ) {
		refuse( 'names a slot the node keeps for its own' );
	}
	return [ ...declared, { source: remoteLog, target: localNode } ];
}
