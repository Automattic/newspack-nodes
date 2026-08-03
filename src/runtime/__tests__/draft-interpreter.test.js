/**
 * The draft is an interpreter, not a second implementation of one.
 *
 * Stage 2's central claim: edit mode and live mode send the SAME commands to
 * different command interpreters, and the difference is a cwd. This pins the
 * half that had never been demonstrated — that a real interpreter can hold a
 * server topology the browser cannot run, and hand it back byte-for-byte.
 *
 * The classes below (Topic, Partition, Consumer, Flame_Builder) have no JS
 * implementation. They resolve to stubs; every structural verb still applies.
 */

import { Core } from '../core';
import { CommandInterpreterNode } from '../command-interpreter-node';
import { StubNode } from '../stub-node';
import { parseStatements } from '../shell-node';
import { newMessage, TYPE, VALUE, TM_COMMAND } from '../message';
import { markLocal } from '../command-auth';

/**
 * A command as the Shell would mint it. `fill` is the only entry point.
 *
 * @param {string} name Verb.
 * @param {Array}  args Token array.
 * @return {Array} The 7-field positional message.
 */
function command( name, args = [] ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ VALUE ] = { name, arguments: args };
	// In-process, like the Shell's own: LOCAL taint is the authorisation.
	return markLocal( m );
}

beforeEach( () => Core.reset() );

/**
 * An interpreter whose `make_node` falls back to a stub, as a draft's would.
 *
 * The ONE place a draft interpreter differs from the live one: an unresolvable
 * class is a node it cannot run, not an error. Everything downstream — every
 * structural verb, dump_config — is inherited untouched.
 *
 * @return {CommandInterpreterNode} The draft interpreter, named and registered.
 */
class DraftInterpreter extends CommandInterpreterNode {
	_cmdMakeNode( args ) {
		if ( args.length < 2 ) {
			return super._cmdMakeNode( args );
		}
		const [ type, name ] = args;
		if ( CommandInterpreterNode.resolveClass( type ) ) {
			return super._cmdMakeNode( args );
		}
		const node = new StubNode();
		node.shellName = type;
		node.name = name;
		node.arguments = args.slice( 2 );
		node.sink = this;
		return 'ok';
	}
}

function draftInterpreter() {
	const interpreter = new DraftInterpreter();
	interpreter.name = '_draft';
	return interpreter;
}

/**
 * Run TSL through the shared front-end into an interpreter, as boot does.
 *
 * @param {CommandInterpreterNode} interpreter Target interpreter.
 * @param {string}                 tsl         Topology source.
 */
function evalTsl( interpreter, tsl ) {
	for ( const statement of parseStatements( tsl ) ) {
		const [ verb, ...values ] = statement.values;
		interpreter.fill( command( verb, values ) );
	}
}

// Deliberately PHP-only classes plus one the browser really has (Tee), so a
// pass cannot come from every class taking the same path.
const TSL = [
	'make_node Topic firehose firehose.log',
	'make_node Consumer firehose-in firehose',
	'make_node Tee firehose-fanout',
	'make_node Flame_Builder flames',
	'connect_node firehose-in firehose-fanout',
	'connect_node firehose-fanout flames',
].join( '\n' );

describe( 'a draft interpreter holding a server topology', () => {
	// dump_config groups each node's statements together, so the INPUT order is
	// not the oracle — a dump re-evaluating to itself is. That is the parity
	// property a save/load cycle actually depends on.
	const dumpAll = () =>
		[ 'firehose', 'firehose-in', 'firehose-fanout', 'flames' ]
			.map( ( name ) => Core.node( name )?.dumpConfig() ?? '' )
			.join( '' );

	it( 'round-trips TSL it cannot run', () => {
		evalTsl( draftInterpreter(), TSL );
		const first = dumpAll();

		Core.reset();
		evalTsl( draftInterpreter(), first );

		expect( dumpAll() ).toBe( first );
		// And it really did carry the server classes, not a Stub placeholder.
		expect( first ).toContain( 'make_node Topic firehose firehose.log' );
		expect( first ).toContain( 'make_node Flame_Builder flames' );
		expect( first ).not.toContain( 'Stub' );
	} );

	it( 'builds a real node when the browser has the class, a stub when not', () => {
		const interpreter = draftInterpreter();

		evalTsl( interpreter, TSL );

		expect( Core.node( 'firehose-fanout' ) ).not.toBeInstanceOf( StubNode );
		expect( Core.node( 'firehose' ) ).toBeInstanceOf( StubNode );
		expect( Core.node( 'flames' ) ).toBeInstanceOf( StubNode );
	} );

	it( 'applies move_node to a stub, and leaves references dangling as Tachikoma does', () => {
		// CommandInterpreter.pm:657 is `$node->name($new_name)` and nothing
		// else, so a live rename strands every target that named the old node;
		// the router answers NOT_AVAILABLE. Our port is faithful, and this
		// pins that rather than the behaviour an editor wants.
		//
		// A DRAFT must diverge here: `draftGraph.moveNode` already rewrites
		// edges, because silently breaking the topology you are editing is not
		// a defensible editor. Same verb, different interpreter, different
		// meaning — the `secure` split again.
		const interpreter = draftInterpreter();
		evalTsl( interpreter, TSL );

		interpreter.fill(
			command( 'move_node', [ 'flames', 'flame-builder' ] )
		);

		expect( Core.node( 'flames' ) ).toBeNull();
		expect( Core.node( 'flame-builder' ) ).toBeInstanceOf( StubNode );
		expect( Core.node( 'firehose-fanout' ).dumpConfig() ).toContain(
			'connect_node firehose-fanout flames'
		);
	} );

	it( 'applies remove_node to a stub', () => {
		const interpreter = draftInterpreter();
		evalTsl( interpreter, TSL );

		interpreter.fill( command( 'remove_node', [ 'flames' ] ) );

		expect( Core.node( 'flames' ) ).toBeNull();
	} );
} );
