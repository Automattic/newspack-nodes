/**
 * dumpDocument — writing the document back out.
 *
 * The replacement for `serializeTsl`, and a different KIND of thing: the
 * serializer rendered a graph literal, this writes what an interpreter holds.
 * So every case here builds the document the way the console does — by running
 * statements — and the oracle is the same one the substrate uses: a dump that
 * re-evaluates to itself.
 *
 * Argument quoting moved to `tslArgs.test.js`; schema defaults are applied
 * where the args are EDITED now, not at serialization, so a document says what
 * it was given.
 */

import { DraftInterpreterNode } from '../../../runtime/draft-interpreter-node';

const draft = ( tsl = '', baseline = null, catalog = [] ) => {
	const d = new DraftInterpreterNode();
	d.catalog = catalog;
	d.load( tsl, baseline );
	return d;
};

describe( 'dumpDocument — statement order', () => {
	it( 'emits nothing when the topology declares nothing', () => {
		expect( draft().dumpDocument() ).toBe( '' );
	} );

	it( 'emits frontmatter first, in insertion order, then nodes', () => {
		const d = draft(
			[
				'var num_partitions = 4',
				'var custom_thing = a b c',
				'make_node Echo echo',
			].join( '\n' )
		);

		expect( d.dumpDocument() ).toBe(
			'var num_partitions = 4\n' +
				'var custom_thing = a b c\n' +
				'make_node Echo echo\n'
		);
	} );

	// A draft carries SPANS, so a quoted name survives quoting-intact and the
	// document re-evaluates to itself. Statements group per node, so the
	// declaration order here is the emitted one, not the authored one.
	it( 'round-trips a spaced name through its sink and target lines', () => {
		const d = draft(
			"make_node Tee 'fan out'\n" +
				'make_node Echo catcher\n' +
				"set_sink 'fan out' catcher\n" +
				"connect_node 'fan out' catcher\n"
		);

		expect( d.dumpDocument() ).toBe(
			"make_node Tee 'fan out'\n" +
				"set_sink 'fan out' catcher\n" +
				'make_node Echo catcher\n' +
				"connect_node 'fan out' catcher\n"
		);
	} );

	it( 'emits includes before the nodes that connect to them', () => {
		const d = draft( 'include wombat-base\nmake_node Echo aardvark\n', {
			nodes: [],
			edges: [],
		} );

		expect( d.dumpDocument() ).toBe(
			'include wombat-base\nmake_node Echo aardvark\n'
		);
	} );

	it( 'emits secure LAST, because it disables make_node for what follows', () => {
		const d = draft( 'secure 2\nmake_node Echo pangolin\n' );

		expect( d.dumpDocument() ).toBe(
			'make_node Echo pangolin\nsecure 2\n'
		);
	} );

	it( 'emits insecure as the final line', () => {
		expect(
			draft( 'insecure\nmake_node Echo quokka' ).dumpDocument()
		).toBe( 'make_node Echo quokka\ninsecure\n' );
	} );
} );

describe( 'dumpDocument — nodes and verbs', () => {
	it( 'emits make_node with its positional args', () => {
		expect(
			draft( 'make_node Partition p /tmp/log 4096' ).dumpDocument()
		).toBe( 'make_node Partition p /tmp/log 4096\n' );
	} );

	it( 'single-quotes an arg containing spaces', () => {
		expect(
			draft(
				"make_node Hook h wp_loaded 'this has spaces'"
			).dumpDocument()
		).toBe( "make_node Hook h wp_loaded 'this has spaces'\n" );
	} );

	it( 'emits an already-quoted raw span verbatim (quote type = semantics)', () => {
		// Double quotes interpolate `<…>`; single quotes defer. Re-quoting
		// would change what the line MEANS.
		const tsl = 'make_node Topic firehose "<config:logs_dir>/f.log"\n';

		expect( draft( tsl ).dumpDocument() ).toBe( tsl );
	} );

	it( 'keeps the deferred-binder Topic ctor span verbatim', () => {
		const tsl =
			'make_node Consumer c <config:logs_dir>/firehose.p<partition>\n';

		expect( draft( tsl ).dumpDocument() ).toBe( tsl );
	} );

	it( 'writes a non-interpreter verb through the config sidecar', () => {
		const tsl =
			'make_node Partition p /tmp/log\n' +
			'command_node p:config allow_large_writes\n';

		expect( draft( tsl ).dumpDocument() ).toBe( tsl );
	} );

	it( 'writes an interpreter-class verb to a bare target', () => {
		const tsl =
			'make_node Command_Interpreter ci\n' + 'command_node ci help\n';

		expect( draft( tsl ).dumpDocument() ).toBe( tsl );
	} );

	it( 'is a fixed point: dumping a dump changes nothing', () => {
		const first = draft(
			[
				'var num_partitions = 2',
				'make_node Tee fan',
				'make_node Partition a a.log',
				'command_node a:config allow_large_writes',
				'connect_node fan a',
				'secure 1',
			].join( '\n' )
		).dumpDocument();

		expect( draft( first ).dumpDocument() ).toBe( first );
	} );
} );

describe( 'dumpDocument — edges against an include', () => {
	const HUB = {
		nodes: [
			{
				name: 'spokes:tee',
				class: 'Tee',
				fans_out: true,
				origin: [ 'hub-control' ],
			},
			{ name: 'remote:x', class: 'Echo', origin: [ 'hub-control' ] },
		],
		edges: [ { from: 'spokes:tee', to: 'remote:x' } ],
	};

	it( 'declares neither the borrowed nodes nor an unchanged baseline edge', () => {
		expect( draft( 'include hub-control', HUB ).dumpDocument( HUB ) ).toBe(
			'include hub-control\n'
		);
	} );

	it( 'emits a disconnect for a baseline edge the document dropped', () => {
		const d = draft( 'include hub-control', HUB );
		d.run( 'disconnect_node spokes:tee remote:x' );

		expect( d.dumpDocument( HUB ) ).toBe(
			'include hub-control\ndisconnect_node spokes:tee remote:x\n'
		);
	} );

	it( 'emits the disconnect even when a new edge shares the source', () => {
		// A Tee's `connect_node` APPENDS, so the new edge does not replace the
		// old one and the removal still has to be said.
		const d = draft(
			'include hub-control\nmake_node Grep wombat ^z\n',
			HUB
		);
		d.run( 'disconnect_node spokes:tee remote:x' );
		d.run( 'connect_node spokes:tee wombat' );

		expect( d.dumpDocument( HUB ) ).toBe(
			'include hub-control\n' +
				'make_node Grep wombat ^z\n' +
				'disconnect_node spokes:tee remote:x\n' +
				'connect_node spokes:tee wombat\n'
		);
	} );

	it( 'writes a config line the file aimed at a borrowed node', () => {
		const tsl =
			'include hub-control\n' +
			'command_node spokes:tee:config set_stats_target remote:x\n';

		expect( draft( tsl, HUB ).dumpDocument( HUB ) ).toBe( tsl );
	} );

	it( 'does not treat a config-only baseline edge as a droppable connect', () => {
		const baseline = {
			nodes: [
				{
					name: 'zebra-source',
					class: 'Echo',
					origin: [ 'wombat-base' ],
				},
				{
					name: 'ibex-config',
					class: 'Echo',
					origin: [ 'wombat-base' ],
				},
			],
			edges: [
				{
					from: 'zebra-source',
					to: 'ibex-config',
					roles: [ 'config' ],
				},
			],
		};

		expect(
			draft( 'include wombat-base', baseline ).dumpDocument( baseline )
		).toBe( 'include wombat-base\n' );
	} );
} );
