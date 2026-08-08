/**
 * StubNode — a node that stands for a class this runtime cannot build.
 *
 * The topology console edits SERVER topologies, which name Partition, Topic,
 * Consumer, Job_Worker — classes with no JS implementation. That is why the
 * draft has been an inert data structure rather than a graph: `make_node
 * Partition firehose` cannot construct anything in a browser.
 *
 * A stub carries the declared class name and arguments without behaviour, so
 * every structural verb — connect_node, move_node, remove_node, set_sink — and
 * `dump_config` work on it unchanged. That is what lets the draft be an
 * interpreter at its own cwd rather than a second implementation of one.
 */

import { Core } from '../core';
import { StubNode } from '../stub-node';

beforeEach( () => Core.reset() );

describe( 'StubNode', () => {
	it( 'round-trips the class it stands for, not its own name', () => {
		// The whole point: dump_config must emit the DECLARED class, or a
		// saved topology would replace every server node with `make_node Stub`.
		const node = new StubNode();
		node.shellName = 'Partition';
		node.name = 'firehose';
		node.arguments = [ 'firehose.p0', '10485760' ];

		expect( node.dumpConfig() ).toBe(
			'make_node Partition firehose firehose.p0 10485760\n'
		);
	} );

	it( 'accepts a target like any node, so connect_node round-trips', () => {
		const producer = new StubNode();
		producer.shellName = 'Topic';
		producer.name = 'firehose';
		const consumer = new StubNode();
		consumer.shellName = 'Consumer';
		consumer.name = 'request-builder';
		producer.target = 'request-builder';

		expect( producer.dumpConfig() ).toBe(
			'make_node Topic firehose\nconnect_node firehose request-builder\n'
		);
		expect( Core.node( 'request-builder' ) ).toBe( consumer );
	} );

	it( 'renames like any node, so move_node needs no special case', () => {
		const node = new StubNode();
		node.shellName = 'Flame_Builder';
		node.name = 'flames';

		node.name = 'flame-builder';

		expect( Core.node( 'flames' ) ).toBeNull();
		expect( Core.node( 'flame-builder' ) ).toBe( node );
		expect( node.dumpConfig() ).toBe(
			'make_node Flame_Builder flame-builder\n'
		);
	} );

	it( 'drops what it is asked to carry rather than pretending to route', () => {
		// A stub describes a node; it must never look like a working one.
		const node = new StubNode();
		node.shellName = 'Partition';
		node.name = 'firehose';
		const before = node.counter;

		node.fill( [ 1, '', '', '', '', 0, 'payload' ] );

		expect( node.counter ).toBe( before + 1 );
	} );
} );
