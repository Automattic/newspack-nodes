import { parseTsl } from '../parseTsl';

describe( 'parseTsl', () => {
	it( 'returns an empty graph for empty input', () => {
		expect( parseTsl( '' ) ).toEqual( {
			nodes: [],
			edges: [],
			frontmatter: {},
			includes: [],
			disconnects: [],
			edgeOperations: [],
			configOverrides: [],
		} );
	} );

	it( 'parses include lines into graph.includes, in declaration order', () => {
		const g = parseTsl(
			'include performance\ninclude job-router\nmake_node Echo wombat-echo\n'
		);
		expect( g.includes ).toEqual( [ 'performance', 'job-router' ] );
		expect( g.nodes.map( ( n ) => n.name ) ).toEqual( [ 'wombat-echo' ] );
	} );

	it( 'captures var frontmatter into an ordered map', () => {
		const g = parseTsl(
			'var num_partitions = 4\n' +
				'var stale_timeout = 120\n' +
				'var custom_thing = a b c\n' +
				'make_node Echo echo\n'
		);
		expect( g.frontmatter ).toEqual( {
			num_partitions: '4',
			stale_timeout: '120',
			custom_thing: 'a b c',
		} );
		expect( g.nodes ).toHaveLength( 1 );
		expect( g.nodes[ 0 ].id ).toBe( 'echo' );
	} );

	it( 'splits a line on ; to capture multiple vars (matches PHP frontmatter parser)', () => {
		const g = parseTsl(
			'var num_partitions = 4; var stale_timeout = 120\n'
		);
		expect( g.frontmatter ).toEqual( {
			num_partitions: '4',
			stale_timeout: '120',
		} );
	} );

	it( 'returns an empty frontmatter map when there are no var lines', () => {
		const g = parseTsl( 'make_node Echo echo\n' );
		expect( g.frontmatter ).toEqual( {} );
	} );

	it( 'parses a single bare make_node', () => {
		const g = parseTsl( 'make_node Echo echo\n' );
		expect( g.nodes ).toHaveLength( 1 );
		expect( g.nodes[ 0 ] ).toMatchObject( {
			id: 'echo',
			name: 'echo',
			class: 'Echo',
			ctorArgs: [],
			verbInvocations: [],
		} );
		expect( g.edges ).toEqual( [] );
	} );

	it( 'parses ctor args positionally', () => {
		const g = parseTsl( 'make_node Partition p /tmp/log 0 16777216\n' );
		expect( g.nodes[ 0 ].ctorArgs ).toEqual( [
			'/tmp/log',
			'0',
			'16777216',
		] );
	} );

	it( 'attaches cmd lines as verb invocations on the named node', () => {
		const g = parseTsl(
			'make_node Partition p\n' +
				'cmd p:config allow_large_writes\n' +
				'cmd p:config with_index request-index\n'
		);
		expect( g.nodes[ 0 ].verbInvocations ).toEqual( [
			{ verb: 'allow_large_writes', args: [] },
			{ verb: 'with_index', args: [ 'request-index' ] },
		] );
	} );

	it( 'retains config-target commands for borrowed nodes as ordered overrides', () => {
		const graph = parseTsl(
			'include quokka-routing\n' +
				'cmd quokka-source:config set_errors_target vicuna-errors-357\n' +
				'cmd quokka-source:config set_completed_target\n'
		);

		expect( graph.configOverrides ).toEqual( [
			{
				from: 'quokka-source',
				slot: 'set_errors_target',
				to: 'vicuna-errors-357',
			},
			{
				from: 'quokka-source',
				slot: 'set_completed_target',
				to: '',
			},
		] );
	} );

	it( 'parses connect_node lines into edges', () => {
		const g = parseTsl(
			'make_node Echo a\nmake_node Echo b\nconnect_node a b\n'
		);
		expect( g.edges ).toEqual( [ { from: 'a', to: 'b' } ] );
	} );

	it( 'unwraps single-quoted args containing spaces', () => {
		const g = parseTsl( "make_node Hook h wp_loaded 'this has spaces'\n" );
		expect( g.nodes[ 0 ].ctorArgs ).toEqual( [
			'wp_loaded',
			'this has spaces',
		] );
	} );

	it( 'ignores blank lines and # comments', () => {
		const g = parseTsl( '\n# a comment\nmake_node Echo a\n# another\n' );
		expect( g.nodes ).toHaveLength( 1 );
		expect( g.nodes[ 0 ].name ).toBe( 'a' );
	} );

	it( 'round-trips with serializeTsl for a non-trivial graph', () => {
		const { serializeTsl } = require( '../serializeTsl' );
		const original = {
			nodes: [
				{
					id: 'p',
					name: 'p',
					class: 'Partition',
					ctorArgs: [ '/tmp/log', '0' ],
					verbInvocations: [
						{ verb: 'allow_large_writes', args: [] },
					],
				},
				{
					id: 'r',
					name: 'r',
					class: 'RequestBuilder',
					ctorArgs: [],
					verbInvocations: [],
				},
			],
			edges: [ { from: 'r', to: 'p' } ],
		};
		const tsl = serializeTsl( original );
		const reparsed = parseTsl( tsl );
		// draftGraph attaches x/y/target/also; the parser doesn't reconstruct them.
		const clean = ( n ) => ( {
			id: n.id,
			name: n.name,
			class: n.class,
			ctorArgs: n.ctorArgs,
			verbInvocations: n.verbInvocations,
		} );
		expect( reparsed.nodes.map( clean ) ).toEqual(
			original.nodes.map( clean )
		);
		expect( reparsed.edges ).toEqual( original.edges );
	} );
} );

describe( 'parseTsl — disconnect_node', () => {
	it( 'collects disconnect_node lines so a splice survives a reopen', () => {
		// The worked splice's saved form: the include re-expands `spokes:tee ->
		// remote:x` on load, and this line is what removes it again. Drop it and
		// reopening resurrects the very edge the splice deleted.
		const g = parseTsl(
			'include hub-control\n' +
				'make_node Grep wombat-grep zebra-pattern\n' +
				'disconnect_node spokes:tee remote:x\n' +
				'connect_node spokes:tee wombat-grep\n' +
				'connect_node wombat-grep remote:x\n'
		);
		expect( g.disconnects ).toEqual( [
			{ from: 'spokes:tee', to: 'remote:x' },
		] );
		expect( g.edges ).toEqual( [
			{ from: 'spokes:tee', to: 'wombat-grep' },
			{ from: 'wombat-grep', to: 'remote:x' },
		] );
	} );

	it( 'defaults disconnects to an empty list', () => {
		expect(
			parseTsl( 'make_node Echo wombat-echo\n' ).disconnects
		).toEqual( [] );
	} );

	it( 'retains a one-argument disconnect until the included source type is known', () => {
		expect(
			parseTsl( 'disconnect_node zebra:consumer\n' ).disconnects
		).toEqual( [ { from: 'zebra:consumer' } ] );
	} );

	it( 'retains connect and disconnect statement order for runtime folding', () => {
		const graph = parseTsl(
			[
				'connect_node zebra-source giraffe-target',
				'disconnect_node zebra-source',
				'connect_node zebra:tee ibex-target',
				'disconnect_node zebra:tee ibex-target',
			].join( '\n' )
		);

		expect( graph.edgeOperations ).toEqual( [
			{
				type: 'connect',
				from: 'zebra-source',
				to: 'giraffe-target',
			},
			{ type: 'disconnect', from: 'zebra-source' },
			{ type: 'connect', from: 'zebra:tee', to: 'ibex-target' },
			{
				type: 'disconnect',
				from: 'zebra:tee',
				to: 'ibex-target',
			},
		] );
	} );
} );

describe( 'parseTsl — verb aliases', () => {
	it( 'reads `make` as `make_node` (the interpreter aliases it, and topologies use it)', () => {
		// ELN's performance.tsl says `make Tee firehose:tee`. A parser that only
		// knows the long form silently drops the node.
		const g = parseTsl(
			'make Tee wombat:tee\nconnect_node wombat:tee zebra\n'
		);
		expect( g.nodes.map( ( n ) => n.name ) ).toEqual( [ 'wombat:tee' ] );
		expect( g.nodes[ 0 ].class ).toBe( 'Tee' );
	} );

	it( 'reads `disconnect` as `disconnect_node`', () => {
		const g = parseTsl( 'disconnect wombat:tee zebra\n' );
		expect( g.disconnects ).toEqual( [
			{ from: 'wombat:tee', to: 'zebra' },
		] );
	} );
} );
