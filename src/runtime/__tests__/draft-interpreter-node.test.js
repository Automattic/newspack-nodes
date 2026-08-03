/**
 * DraftInterpreterNode — the console's edit buffer as an interpreter.
 *
 * Stage 2's claim is that edit mode and live mode send the same commands to
 * different interpreters and the difference is a cwd. This is the edit-mode
 * one: it owns its own name table, answers the graph verbs against stubs for
 * classes the browser cannot build, and answers the DOCUMENT verbs — `var`,
 * `include`, `remove_include`, `secure` — which touch no node table at all.
 *
 * `dumpDocument()` replaces `serializeTsl`. It is not `dump_config`: a topology
 * file has a required statement order (vars, includes, nodes, edges, `secure`
 * last, because `secure 1` disables `make_node`) and `dump_config` groups by
 * node instead.
 */

import { Core } from '../core';
import { StubNode } from '../stub-node';
import { DraftInterpreterNode } from '../draft-interpreter-node';

beforeEach( () => Core.reset() );

const draft = () => {
	const d = new DraftInterpreterNode();
	d.name = '_draft';
	return d;
};

describe( 'graph verbs', () => {
	it( 'stubs a class the browser cannot build, and keeps its name', () => {
		const d = draft();

		d.run( 'make_node Partition firehose firehose.log' );

		const node = d.childRegistry.node( 'firehose' );
		expect( node ).toBeInstanceOf( StubNode );
		expect( node.shellName ).toBe( 'Partition' );
		expect( Core.node( 'firehose' ) ).toBeNull();
	} );

	it( 'rewrites references on move_node — an editor may not strand edges', () => {
		// The documented divergence from the live interpreter, which does
		// `$node->name($new)` and nothing else. Silently breaking the topology
		// being edited is not a defensible editor.
		const d = draft();
		d.run( 'make_node Tee fan' );
		d.run( 'make_node Partition flames flames.log' );
		d.run( 'connect_node fan flames' );

		d.run( 'move_node flames flame-builder' );

		expect( d.childRegistry.node( 'fan' ).target ).toEqual( [
			'flame-builder',
		] );
	} );
} );

describe( 'document verbs touch no node table', () => {
	it( 'var, include, remove_include and secure', () => {
		const d = draft();

		d.run( 'var num_partitions = 4' );
		d.run( 'include topic-probe' );
		d.run( 'include job-intake' );
		d.run( 'remove_include topic-probe' );
		d.run( 'secure 2' );

		expect( d.frontmatter ).toEqual( { num_partitions: '4' } );
		expect( d.includes ).toEqual( [ 'job-intake' ] );
		expect( d.secureLevel ).toBe( '2' );
		expect( d.childRegistry.nodes.size ).toBe( 0 );
	} );

	it( 'secure is freely reversible here, unlike the live ratchet', () => {
		// Live it climbs 1..3 and never descends, and that irreversibility is
		// the security property. In a draft it edits a line of a file.
		const d = draft();

		d.run( 'secure 3' );
		d.run( 'secure 1' );

		expect( d.secureLevel ).toBe( '1' );
	} );
} );

describe( 'command_node — one statement, two readings', () => {
	it( 'records a verb the tokenizer canonicalised from `cmd`', () => {
		// `cmd` and `command` are not separate verbs: parseStatements rewrites
		// both to `command_node`, so there is one handler and one grammar.
		const d = draft();
		d.run( 'make_node Partition firehose firehose.log' );

		d.run( 'cmd firehose void_warranty' );

		expect( d.invocationsFor( 'firehose' ) ).toEqual( [
			{ verb: 'void_warranty', args: [], viaConfig: false },
		] );
	} );

	it( 'routes a :config target to the sidecar, and remembers which', () => {
		// A normal node takes verbs through `<name>:config`; a bare target is
		// how an INTERPRETER-class node takes them directly. dumpDocument has
		// to emit back whichever the topology wrote.
		const d = draft();
		d.run( 'make_node Tee fan' );

		d.run( 'command_node fan:config set_target flames' );

		expect( d.invocationsFor( 'fan' ) ).toEqual( [
			{ verb: 'set_target', args: [ 'flames' ], viaConfig: true },
		] );
	} );

	it( 'refuses a target that is not a node', () => {
		const d = draft();

		expect( d.dispatch( 'command_node', [ 'nope:config', 'x' ] ) ).toBe(
			'unknown node: nope'
		);
	} );

	it( 'emits each back after its make_node, sidecar suffix preserved', () => {
		const d = draft();
		d.run( 'make_node Partition firehose firehose.log' );
		d.run( 'cmd firehose void_warranty' );
		d.run( 'command_node firehose:config set_target fan' );

		expect( d.dumpDocument() ).toBe(
			[
				'make_node Partition firehose firehose.log',
				'command_node firehose void_warranty',
				'command_node firehose:config set_target fan',
				'',
			].join( '\n' )
		);
	} );

	it( "drops a node's declarations when the node goes", () => {
		const d = draft();
		d.run( 'make_node Partition firehose firehose.log' );
		d.run( 'cmd firehose void_warranty' );

		d.run( 'remove_node firehose' );

		expect( d.invocationsFor( 'firehose' ) ).toEqual( [] );
		expect( d.dumpDocument() ).toBe( '' );
	} );

	it( 'carries declarations across a rename, like the edges do', () => {
		const d = draft();
		d.run( 'make_node Partition flames flames.log' );
		d.run( 'cmd flames void_warranty' );

		d.run( 'move_node flames flame-builder' );

		expect( d.invocationsFor( 'flame-builder' ) ).toEqual( [
			{ verb: 'void_warranty', args: [], viaConfig: false },
		] );
	} );
} );

describe( 'dumpDocument', () => {
	it( 'emits the statement order a topology file requires', () => {
		const d = draft();
		d.run( 'var num_partitions = 4' );
		d.run( 'include topic-probe' );
		d.run( 'make_node Topic firehose firehose.log' );
		d.run( 'make_node Tee fan' );
		d.run( 'connect_node firehose fan' );
		d.run( 'secure 2' );

		expect( d.dumpDocument() ).toBe(
			[
				'var num_partitions = 4',
				'include topic-probe',
				'make_node Topic firehose firehose.log',
				'make_node Tee fan',
				'connect_node firehose fan',
				'secure 2',
				'',
			].join( '\n' )
		);
	} );

	it( 'round-trips: its own output re-evaluates to itself', () => {
		const d = draft();
		d.run( 'var num_partitions = 4' );
		d.run( 'include topic-probe' );
		d.run( 'make_node Topic firehose firehose.log' );
		d.run( 'make_node Consumer reader firehose' );
		d.run( 'connect_node reader firehose' );
		d.run( 'secure 2' );
		const first = d.dumpDocument();

		Core.reset();
		const reloaded = draft();
		reloaded.load( first );

		expect( reloaded.dumpDocument() ).toBe( first );
	} );

	it( 'is empty for an empty document, not a stray newline', () => {
		expect( draft().dumpDocument() ).toBe( '' );
	} );
} );
