import { parseTsl } from '../parseTsl';

describe( 'parseTsl', () => {
	it( 'returns an empty graph for empty input', () => {
		expect( parseTsl( '' ) ).toEqual( {
			nodes: [],
			edges: [],
			frontmatter: {},
		} );
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
