/**
 * consoleGraph — the graph helpers that outlived the draft reducer.
 *
 * What is left after the draft interpreter took the mutation half and the
 * dirty-check: the canvas's `_repl` anchor, and unique-name generation. None
 * of them mutate a document; they are all reads over one.
 */

import {
	withReplAnchor,
	withOwnedNodes,
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

	it( 'ignores a token in a verb that is not a target setter', () => {
		// Broader, the guard fires on ordinary `<config:…>` arguments — which
		// no runtime resolves into an edge, so nothing is being hidden.
		const parsed = graphFromTsl(
			'make_node Echo src\ncommand_node src:config set_window <config:w>'
		);

		expect( () =>
			withResolvedConfigEdges( parsed, undefined )
		).not.toThrow();
	} );

	it( 'is satisfied by a resolved list, even an empty one', () => {
		const parsed = graphFromTsl(
			'make_node Echo src\n' +
				'command_node src:config set_stats_target <wombat:sink>'
		);

		expect( () => withResolvedConfigEdges( parsed, [] ) ).not.toThrow();
	} );

	it( 'says nothing when no argument carries a token', () => {
		const parsed = graphFromTsl(
			'make_node Echo src\ncommand_node src:config set_x plain'
		);

		expect( () =>
			withResolvedConfigEdges( parsed, undefined )
		).not.toThrow();
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

		it( 'adds the reserved _repl:input Consumer, whose quarantine the dl_* verbs reach', () => {
			const next = withReplAnchor( empty );
			expect(
				next.nodes.find( ( n ) => n.id === '_repl:input' )
			).toEqual( {
				id: '_repl:input',
				name: '_repl:input',
				class: 'Consumer',
				reserved: true,
			} );
		} );

		it( 'is idempotent — does not duplicate _repl or _repl:input', () => {
			const once = withReplAnchor( empty );
			const twice = withReplAnchor( once );
			expect(
				twice.nodes.filter( ( n ) => n.id === '_repl' )
			).toHaveLength( 1 );
			expect(
				twice.nodes.filter( ( n ) => n.id === '_repl:input' )
			).toHaveLength( 1 );
		} );

		it( 'adds only _repl:input to a graph that already holds _repl', () => {
			const kea = { id: '_repl', name: '_repl', class: 'Kea_Shell' };
			const next = withReplAnchor( { nodes: [ kea ], edges: [] } );
			expect( next.nodes.map( ( n ) => n.id ) ).toEqual( [
				'_repl',
				'_repl:input',
			] );
			expect( next.nodes[ 0 ] ).toBe( kea );
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
	describe( 'withOwnedNodes', () => {
		const owner = graphFromTsl( 'make_node Wombat_Owner kea-owner-512' );
		const ledger = {
			name: 'kea-owner-512:ledger',
			class: 'Wombat_Ledger',
			owner: 'kea-owner-512',
		};

		it( 'adds an owned node, owned by and wired from its owner', () => {
			const next = withOwnedNodes( owner, [ ledger ] );
			expect(
				next.nodes.find( ( n ) => n.id === 'kea-owner-512:ledger' )
			).toEqual( {
				id: 'kea-owner-512:ledger',
				name: 'kea-owner-512:ledger',
				class: 'Wombat_Ledger',
				owner: 'kea-owner-512',
			} );
			expect( next.edges ).toEqual( [
				{ from: 'kea-owner-512', to: 'kea-owner-512:ledger' },
			] );
		} );

		it( 'adds nothing for an owner the graph does not hold', () => {
			expect( withOwnedNodes( empty, [ ledger ] ) ).toBe( empty );
		} );

		it( 'is idempotent — adds neither the node nor its edge twice', () => {
			const once = withOwnedNodes( owner, [ ledger ] );
			expect( withOwnedNodes( once, [ ledger ] ) ).toBe( once );
		} );

		it( 'fails loud when the reply carries no owned list', () => {
			expect( () => withOwnedNodes( owner, undefined ) ).toThrow(
				'Missing owned in topologies get response.'
			);
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
