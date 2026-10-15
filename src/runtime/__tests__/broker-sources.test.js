/**
 * The one browser fold of a broker's sources, held to PHP
 * `Remote_Broker_Node::sources_of()` by the case list both read.
 */

import {
	ADD_SOURCE,
	REMOVE_SOURCE,
	SOURCE_ARGS,
	foldSource,
} from '../broker-sources';
import { bindCommandArgs } from '../command-args';
import sourceCommands from '../../../tests/fixtures/broker-sources.json';

/**
 * The sources a run of `add_source` and `remove_source` commands leaves,
 * each bound as its verb binds it and folded at partition 0, as PHP
 * `Remote_Broker_Node::sources_of()` folds them.
 *
 * @param {Array<[string,Array<string>]>} commands Each verb and its tokens.
 * @return {Array<Object>} The sources, in order.
 */
function sourcesOf( commands ) {
	let sources = [];
	for ( const [ verb, tokens ] of commands ) {
		if ( ADD_SOURCE !== verb && REMOVE_SOURCE !== verb ) {
			continue;
		}
		const bound = bindCommandArgs( SOURCE_ARGS, tokens );
		sources = foldSource(
			sources,
			verb,
			bound.remote_log,
			bound.local_node,
			0
		);
	}
	return sources;
}

/**
 * What a run answers: the targets it leaves, or its refusal.
 *
 * @param {Function} run The fold to run.
 * @return {Array<string>|{refused:string}} The answer.
 */
function answer( run ) {
	try {
		return run().map( ( s ) => s.target );
	} catch ( e ) {
		return { refused: e.message };
	}
}

describe( 'sourcesOf', () => {
	it.each( sourceCommands )(
		'folds the commands as the PHP broker does: %s',
		( label, commands, expected ) => {
			expect( answer( () => sourcesOf( commands ) ) ).toEqual( expected );
		}
	);
} );

describe( 'foldSource', () => {
	it( 'answers the declared list itself for an identical repeat', () => {
		const declared = [ { source: 'egret.p6', target: 'heron-4471' } ];

		expect(
			foldSource( declared, 'add_source', 'egret.p6', 'heron-4471', 0 )
		).toBe( declared );
	} );

	it( 'refuses {partition} where no partition is bound', () => {
		expect( () =>
			foldSource(
				[],
				'add_source',
				'egret.p{partition}',
				'heron-4',
				null
			)
		).toThrow(
			"add_source 'egret.p{partition}' 'heron-4' names {partition}, but no partition is bound"
		);
	} );

	it( 'judges a config token, which it cannot resolve, as one name character', () => {
		expect(
			foldSource( [], 'add_source', '<zeta:lane>.p3', 'ibis-41', 0 )
		).toEqual( [ { source: '<zeta:lane>.p3', target: 'ibis-41' } ] );
		expect( () =>
			foldSource( [], 'add_source', 'Egret<zeta:lane>', 'ibis-41', 0 )
		).toThrow(
			"add_source 'Egret<zeta:lane>' names a source no spoke can stream"
		);
	} );

	it( 'judges a {partition} source at the partition it is given', () => {
		expect(
			foldSource( [], 'add_source', 'egret.p{partition}', 'heron-4', 11 )
		).toEqual( [ { source: 'egret.p{partition}', target: 'heron-4' } ] );
	} );
} );
