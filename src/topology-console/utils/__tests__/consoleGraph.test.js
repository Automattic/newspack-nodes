/**
 * consoleGraph — the graph helpers that outlived the draft reducer.
 *
 * What is left after the draft interpreter took the mutation half: the
 * dirty-check, the canvas's `_repl` anchor, and unique-name generation. None
 * of them mutate a document; they are all reads over one.
 */

import {
	draftIsDirty,
	withReplAnchor,
	generateNodeName,
	withResolvedConfigEdges,
	withConfigEdges,
} from '../consoleGraph';
import { graphFromTsl } from '../draftToGraph';

describe( 'consoleGraph', () => {
	const empty = { nodes: [], edges: [] };
	// Grow a graph the way the console does: another `make_node` statement.
	const withNode = ( graph, shellName, name ) => ( {
		...graph,
		nodes: [
			...graph.nodes,
			...graphFromTsl( `make_node ${ shellName } ${ name }` ).nodes,
		],
	} );

	it( 'fails loud when a token target has no resolved-edge contract', () => {
		// A `<ns:key>` target the server did not resolve names nothing. A
		// default here would silently wire the edge to the literal token.
		const parsed = graphFromTsl(
			'make_node Echo cerulean-source-619\n' +
				'command_node cerulean-source-619:config set_stats_target <wombat:stats_sink>\n'
		);

		expect( () => withResolvedConfigEdges( parsed, undefined ) ).toThrow(
			'Missing resolved_config_edges in topologies get response.'
		);
	} );

	describe( 'draftIsDirty', () => {
		it( 'returns false when draft equals baseline', () => {
			const g = graphFromTsl( 'make_node Echo a' );
			expect( draftIsDirty( g, g ) ).toBe( false );
		} );

		it( 'returns true when a node is added', () => {
			const baseline = empty;
			const draft = graphFromTsl( 'make_node Echo a' );
			expect( draftIsDirty( draft, baseline ) ).toBe( true );
		} );
	} );
	describe( 'withReplAnchor', () => {
		it( 'adds a reserved _repl Partition node to a blank graph', () => {
			const next = withReplAnchor( empty );
			const repl = next.nodes.find( ( n ) => n.id === '_repl' );
			expect( repl ).toEqual( {
				id: '_repl',
				name: '_repl',
				class: 'Partition',
				reserved: true,
			} );
		} );

		it( 'is idempotent — does not duplicate _repl', () => {
			const once = withReplAnchor( empty );
			const twice = withReplAnchor( once );
			expect(
				twice.nodes.filter( ( n ) => n.id === '_repl' )
			).toHaveLength( 1 );
		} );

		it( 'preserves existing nodes and edges', () => {
			let g = graphFromTsl( 'make_node Tee my-tee' );
			g = {
				...g,
				edges: [ { from: 'my-tee', to: '_repl' } ],
			};
			const next = withReplAnchor( g );
			expect(
				next.nodes.find( ( n ) => n.id === 'my-tee' )
			).toBeDefined();
			expect( next.edges ).toEqual( [ { from: 'my-tee', to: '_repl' } ] );
		} );
	} );
	describe( 'generateNodeName', () => {
		it( 'returns lowercased class for first instance', () => {
			expect( generateNodeName( empty, 'Echo' ) ).toBe( 'echo' );
		} );

		it( 'increments suffix on collision', () => {
			const g = graphFromTsl( 'make_node Echo echo' );
			expect( generateNodeName( g, 'Echo' ) ).toBe( 'echo-2' );
		} );

		it( 'finds the next free suffix when middle slots are filled', () => {
			let g = graphFromTsl( 'make_node Echo echo' );
			g = withNode( g, 'Echo', 'echo-2' );
			g = withNode( g, 'Echo', 'echo-3' );
			expect( generateNodeName( g, 'Echo' ) ).toBe( 'echo-4' );
		} );
	} );
} );

describe( 'withConfigEdges', () => {
	const nodes = [
		{ id: 'zebra-source' },
		{ id: 'amber-old' },
		{ id: 'violet-new' },
	];

	it( 'adds a config edge where none existed', () => {
		const out = withConfigEdges( {
			nodes,
			edges: [],
			configOverrides: [
				{
					from: 'zebra-source',
					slot: 'set_stats_target',
					to: 'violet-new',
				},
			],
		} );

		expect( out.edges ).toEqual( [
			{
				from: 'zebra-source',
				to: 'violet-new',
				roles: [ 'config' ],
				config_slots: [ 'set_stats_target' ],
			},
		] );
	} );

	it( 'merges a config role onto an existing physical connection', () => {
		const out = withConfigEdges( {
			nodes,
			edges: [
				{
					from: 'zebra-source',
					to: 'violet-new',
					roles: [ 'connect' ],
				},
			],
			configOverrides: [
				{
					from: 'zebra-source',
					slot: 'set_stats_target',
					to: 'violet-new',
				},
			],
		} );

		expect( out.edges ).toEqual( [
			{
				from: 'zebra-source',
				to: 'violet-new',
				roles: [ 'connect', 'config' ],
				config_slots: [ 'set_stats_target' ],
			},
		] );
	} );

	it( 'moves one slot off its old endpoint, keeping the others there', () => {
		const out = withConfigEdges( {
			nodes,
			edges: [
				{
					from: 'zebra-source',
					to: 'amber-old',
					roles: [ 'config' ],
					config_slots: [ 'set_stats_target', 'set_errors_target' ],
				},
			],
			configOverrides: [
				{
					from: 'zebra-source',
					slot: 'set_stats_target',
					to: 'violet-new',
				},
			],
		} );

		expect( out.edges ).toEqual( [
			{
				from: 'zebra-source',
				to: 'amber-old',
				roles: [ 'config' ],
				config_slots: [ 'set_errors_target' ],
			},
			{
				from: 'zebra-source',
				to: 'violet-new',
				roles: [ 'config' ],
				config_slots: [ 'set_stats_target' ],
			},
		] );
	} );

	it( 'drops the edge entirely when its last config slot moves away', () => {
		const out = withConfigEdges( {
			nodes,
			edges: [
				{
					from: 'zebra-source',
					to: 'amber-old',
					roles: [ 'config' ],
					config_slots: [ 'set_stats_target' ],
				},
			],
			configOverrides: [
				{ from: 'zebra-source', slot: 'set_stats_target', to: '' },
			],
		} );

		expect( out.edges ).toEqual( [] );
	} );

	it( 'keeps the physical connection when only the config moves off it', () => {
		const out = withConfigEdges( {
			nodes,
			edges: [
				{
					from: 'zebra-source',
					to: 'amber-old',
					roles: [ 'connect', 'config' ],
					config_slots: [ 'set_stats_target' ],
				},
			],
			configOverrides: [
				{
					from: 'zebra-source',
					slot: 'set_stats_target',
					to: 'violet-new',
				},
			],
		} );

		expect( out.edges ).toContainEqual( {
			from: 'zebra-source',
			to: 'amber-old',
			roles: [ 'connect' ],
		} );
	} );

	it( 'resolves a token target against the server’s answer', () => {
		const out = withConfigEdges( {
			nodes,
			edges: [],
			configOverrides: [
				{
					from: 'zebra-source',
					slot: 'set_stats_target',
					to: '<wombat:stats_sink>',
				},
			],
			resolvedConfigEdges: [
				{
					from: 'zebra-source',
					to: 'violet-new',
					roles: [ 'config' ],
					config_slots: [ 'set_stats_target' ],
				},
			],
		} );

		expect( out.edges ).toEqual( [
			{
				from: 'zebra-source',
				to: 'violet-new',
				roles: [ 'config' ],
				config_slots: [ 'set_stats_target' ],
			},
		] );
	} );

	it( 'ignores an override whose endpoint no node provides', () => {
		const out = withConfigEdges( {
			nodes,
			edges: [],
			configOverrides: [
				{
					from: 'zebra-source',
					slot: 'set_stats_target',
					to: 'departed',
				},
			],
		} );

		expect( out.edges ).toEqual( [] );
	} );
} );
