import {
	addNode,
	addEdge,
	removeNode,
	removeEdge,
	renameNode,
	updateNodeArgs,
	updateNodeVerbs,
	draftIsDirty,
	generateNodeName,
	withReplAnchor,
	addInclude,
	removeInclude,
	reconcileIncludes,
	applyLoadedBaseline,
	connectDraftEdge,
	withResolvedConfigEdges,
} from '../draftGraph';
import { parseTsl } from '../parseTsl';
import { serializeTsl } from '../serializeTsl';

describe( 'draftGraph', () => {
	const empty = { nodes: [], edges: [] };

	it( 'fails loud when a token target has no resolved-edge contract', () => {
		const parsed = parseTsl(
			'make_node Echo cerulean-source-619\n' +
				'cmd cerulean-source-619:config set_stats_target <wombat:stats_sink>\n'
		);

		expect( () => withResolvedConfigEdges( parsed, undefined ) ).toThrow(
			'Missing resolved_config_edges in topologies get response.'
		);
	} );

	it( 'preserves frontmatter across every mutator', () => {
		const fm = { num_partitions: '4' };
		const base = {
			nodes: [
				{
					id: 'a',
					name: 'a',
					class: 'Echo',
					ctorArgs: [],
					verbInvocations: [],
				},
				{
					id: 'b',
					name: 'b',
					class: 'Echo',
					ctorArgs: [],
					verbInvocations: [],
				},
			],
			edges: [ { from: 'a', to: 'b' } ],
			frontmatter: fm,
		};
		expect(
			addNode( base, { shellName: 'Echo', name: 'c', x: 0, y: 0 } )
				.frontmatter
		).toEqual( fm );
		expect( addEdge( base, { from: 'b', to: 'a' } ).frontmatter ).toEqual(
			fm
		);
		expect( removeNode( base, 'a' ).frontmatter ).toEqual( fm );
		expect( renameNode( base, 'a', 'z' ).frontmatter ).toEqual( fm );
		expect( removeEdge( base, 'a', 'b' ).frontmatter ).toEqual( fm );
		expect( updateNodeArgs( base, 'a', [ 'x' ] ).frontmatter ).toEqual(
			fm
		);
		expect( updateNodeVerbs( base, 'a', [] ).frontmatter ).toEqual( fm );
	} );

	describe( 'addNode', () => {
		it( 'appends a node and returns a new graph reference', () => {
			const next = addNode( empty, {
				shellName: 'Echo',
				name: 'echo',
				x: 100,
				y: 200,
			} );
			expect( next ).not.toBe( empty );
			expect( next.nodes ).toHaveLength( 1 );
			expect( next.nodes[ 0 ] ).toMatchObject( {
				id: 'echo',
				name: 'echo',
				class: 'Echo',
				x: 100,
				y: 200,
				ctorArgs: [],
				verbInvocations: [],
			} );
		} );
	} );

	describe( 'addEdge', () => {
		it( 'appends an edge and updates source node target', () => {
			const g = addNode( empty, {
				shellName: 'Echo',
				name: 'a',
				x: 0,
				y: 0,
			} );
			const next = addEdge( g, { from: 'a', to: 'b' } );
			expect( next.edges ).toEqual( [ { from: 'a', to: 'b' } ] );
			expect( next.nodes[ 0 ].target ).toBe( 'b' );
		} );

		it( 'is a no-op for self-edges', () => {
			const g = addNode( empty, {
				shellName: 'Echo',
				name: 'a',
				x: 0,
				y: 0,
			} );
			expect( addEdge( g, { from: 'a', to: 'a' } ) ).toBe( g );
		} );

		it( 'is a no-op for duplicate edges', () => {
			let g = addNode( empty, {
				shellName: 'Echo',
				name: 'a',
				x: 0,
				y: 0,
			} );
			g = addEdge( g, { from: 'a', to: 'b' } );
			expect( addEdge( g, { from: 'a', to: 'b' } ) ).toBe( g );
		} );
	} );

	describe( 'removeNode', () => {
		it( 'drops the node and any incident edges', () => {
			let g = addNode( empty, {
				shellName: 'Echo',
				name: 'a',
				x: 0,
				y: 0,
			} );
			g = addNode( g, {
				shellName: 'Echo',
				name: 'b',
				x: 0,
				y: 0,
			} );
			g = addEdge( g, { from: 'a', to: 'b' } );
			const next = removeNode( g, 'a' );
			expect( next.nodes.map( ( n ) => n.id ) ).toEqual( [ 'b' ] );
			expect( next.edges ).toEqual( [] );
		} );

		it( 'turns a removed config-override target into an explicit clear', () => {
			const graph = {
				nodes: [
					{
						id: 'kiwi-errors-233',
						name: 'kiwi-errors-233',
						class: 'Echo',
						ctorArgs: [],
						verbInvocations: [],
					},
				],
				edges: [],
				includes: [ 'koala-routing' ],
				configOverrides: [
					{
						from: 'koala-source',
						slot: 'set_errors_target',
						to: 'kiwi-errors-233',
					},
				],
			};

			const next = removeNode( graph, 'kiwi-errors-233' );
			expect( next.configOverrides ).toEqual( [
				{
					from: 'koala-source',
					slot: 'set_errors_target',
					to: '',
				},
			] );
			expect( serializeTsl( next ) ).toBe(
				'include koala-routing\n' +
					'cmd koala-source:config set_errors_target\n'
			);
		} );
	} );

	describe( 'removeEdge', () => {
		it( 'drops one edge, leaves others intact', () => {
			let g = addNode( empty, {
				shellName: 'Echo',
				name: 'a',
				x: 0,
				y: 0,
			} );
			g = addEdge( g, { from: 'a', to: 'b' } );
			g = addEdge( g, { from: 'a', to: 'c' } );
			const next = removeEdge( g, 'a', 'b' );
			expect( next.edges ).toEqual( [ { from: 'a', to: 'c' } ] );
		} );
	} );

	describe( 'renameNode', () => {
		const seed = () => {
			let g = addNode( empty, {
				shellName: 'Echo',
				name: 'a',
				x: 0,
				y: 0,
			} );
			g = addNode( g, {
				shellName: 'Echo',
				name: 'b',
				x: 0,
				y: 0,
			} );
			g = addEdge( g, { from: 'a', to: 'b' } );
			return g;
		};

		it( 'renames the node id + name and rewrites incident edges', () => {
			const g = seed();
			const next = renameNode( g, 'a', 'alpha' );
			expect( next ).not.toBe( g );
			expect( next.nodes.map( ( n ) => n.id ) ).toEqual( [
				'alpha',
				'b',
			] );
			expect( next.nodes[ 0 ].name ).toBe( 'alpha' );
			expect( next.edges ).toEqual( [ { from: 'alpha', to: 'b' } ] );
		} );

		it( 'rewrites the to side of an edge too', () => {
			const g = seed();
			const next = renameNode( g, 'b', 'beta' );
			expect( next.edges ).toEqual( [ { from: 'a', to: 'beta' } ] );
		} );

		it( 'is a no-op when newName is empty', () => {
			const g = seed();
			expect( renameNode( g, 'a', '' ) ).toBe( g );
			expect( renameNode( g, 'a', '   ' ) ).toBe( g );
		} );

		it( 'is a no-op when newName equals the existing name', () => {
			const g = seed();
			expect( renameNode( g, 'a', 'a' ) ).toBe( g );
		} );

		it( 'is a no-op when newName is already taken by another node', () => {
			const g = seed();
			expect( renameNode( g, 'a', 'b' ) ).toBe( g );
		} );

		it( 'trims surrounding whitespace before applying', () => {
			const g = seed();
			const next = renameNode( g, 'a', '  alpha  ' );
			expect( next.nodes[ 0 ].id ).toBe( 'alpha' );
		} );

		it( 'leaves edges unrelated to the rename alone', () => {
			let g = seed();
			g = addNode( g, {
				shellName: 'Echo',
				name: 'c',
				x: 0,
				y: 0,
			} );
			g = addEdge( g, { from: 'b', to: 'c' } );
			const next = renameNode( g, 'a', 'alpha' );
			// b → c is unrelated; same reference, not re-mapped.
			const bc = next.edges.find(
				( e ) => e.from === 'b' && e.to === 'c'
			);
			expect( bc ).toBeDefined();
		} );

		it( 'coerces non-string newName via String()', () => {
			const g = seed();
			expect( renameNode( g, 'a', 42 ).nodes[ 0 ].id ).toBe( '42' );
		} );

		it( 'rewrites config-override targets when their own node is renamed', () => {
			const graph = {
				...seed(),
				includes: [ 'lynx-routing' ],
				configOverrides: [
					{
						from: 'lynx-source',
						slot: 'set_errors_target',
						to: 'b',
					},
				],
			};

			const next = renameNode( graph, 'b', 'new-lynx-errors-677' );
			expect( next.configOverrides[ 0 ].to ).toBe(
				'new-lynx-errors-677'
			);
			expect( serializeTsl( next ) ).toContain(
				'cmd lynx-source:config set_errors_target new-lynx-errors-677\n'
			);
		} );
	} );

	describe( 'updateNodeArgs / updateNodeVerbs', () => {
		it( 'replaces ctor args on the named node', () => {
			const g = addNode( empty, {
				shellName: 'Partition',
				name: 'p',
				x: 0,
				y: 0,
			} );
			const next = updateNodeArgs( g, 'p', [ '/tmp/log', 0 ] );
			expect( next.nodes[ 0 ].ctorArgs ).toEqual( [ '/tmp/log', 0 ] );
		} );

		it( 'replaces verb invocations on the named node', () => {
			const g = addNode( empty, {
				shellName: 'Partition',
				name: 'p',
				x: 0,
				y: 0,
			} );
			const next = updateNodeVerbs( g, 'p', [
				{ verb: 'allow_large_writes', args: [] },
			] );
			expect( next.nodes[ 0 ].verbInvocations ).toEqual( [
				{ verb: 'allow_large_writes', args: [] },
			] );
		} );
	} );

	describe( 'draftIsDirty', () => {
		it( 'returns false when draft equals baseline', () => {
			const g = addNode( empty, {
				shellName: 'Echo',
				name: 'a',
				x: 0,
				y: 0,
			} );
			expect( draftIsDirty( g, g ) ).toBe( false );
		} );

		it( 'returns true when a node is added', () => {
			const baseline = empty;
			const draft = addNode( empty, {
				shellName: 'Echo',
				name: 'a',
				x: 0,
				y: 0,
			} );
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
			let g = addNode( empty, {
				shellName: 'Tee',
				name: 'my-tee',
				x: 10,
				y: 20,
			} );
			g = addEdge( g, { from: 'my-tee', to: '_repl' } );
			const next = withReplAnchor( g );
			expect(
				next.nodes.find( ( n ) => n.id === 'my-tee' )
			).toBeDefined();
			expect( next.edges ).toEqual( [ { from: 'my-tee', to: '_repl' } ] );
		} );
	} );

	describe( 'reserved-node refusal', () => {
		it( 'renameNode is a no-op for a reserved node', () => {
			const g = withReplAnchor( empty );
			expect( renameNode( g, '_repl', 'something' ) ).toBe( g );
		} );

		it( 'removeNode is a no-op for a reserved node', () => {
			const g = withReplAnchor( empty );
			expect( removeNode( g, '_repl' ) ).toBe( g );
		} );

		it( 'removeNode still drops a non-reserved node', () => {
			let g = withReplAnchor( empty );
			g = addNode( g, {
				shellName: 'Echo',
				name: 'echo',
				x: 0,
				y: 0,
			} );
			const next = removeNode( g, 'echo' );
			expect(
				next.nodes.find( ( n ) => n.id === 'echo' )
			).toBeUndefined();
			expect(
				next.nodes.find( ( n ) => n.id === '_repl' )
			).toBeDefined();
		} );
	} );

	describe( 'includes', () => {
		it( 'addInclude appends, and is a no-op for one already declared', () => {
			const g0 = { nodes: [], edges: [], frontmatter: {}, includes: [] };
			const g1 = addInclude( g0, 'performance' );
			expect( g1.includes ).toEqual( [ 'performance' ] );
			expect( addInclude( g1, 'performance' ) ).toBe( g1 );
		} );

		it( 'removeInclude drops the name', () => {
			const g0 = {
				nodes: [],
				edges: [],
				frontmatter: {},
				includes: [ 'performance', 'job-router' ],
			};
			expect( removeInclude( g0, 'performance' ).includes ).toEqual( [
				'job-router',
			] );
		} );

		it( 'preserves includes across every mutator', () => {
			let g = {
				nodes: [],
				edges: [],
				frontmatter: {},
				includes: [ 'performance' ],
			};
			g = addNode( g, {
				shellName: 'Echo',
				name: 'wombat-echo',
				x: 10,
				y: 20,
			} );
			g = addEdge( g, { from: 'wombat-echo', to: 'zebra-tee' } );
			g = updateNodeArgs( g, 'wombat-echo', [ 'giraffe' ] );
			expect( g.includes ).toEqual( [ 'performance' ] );
		} );
	} );

	describe( 'reconcileIncludes', () => {
		it( "carries a borrowed node's config verbs into verbInvocations", () => {
			const newBase = {
				nodes: [
					{
						name: 'errors:partition',
						class: 'Partition',
						args: [],
						verbs: [
							{ verb: 'void_warranty', args: [] },
							{ verb: 'with_index', args: [ 'quokka-idx' ] },
						],
						origin: [ 'request-builder' ],
						via: [ 'request-builder' ],
					},
				],
				edges: [],
			};
			const g0 = {
				nodes: [],
				edges: [],
				frontmatter: {},
				includes: [ 'request-builder' ],
			};

			const g1 = reconcileIncludes(
				g0,
				{ nodes: [], edges: [] },
				newBase
			);
			const borrowed = g1.nodes.find(
				( n ) => n.name === 'errors:partition'
			);

			expect( borrowed.verbInvocations ).toEqual( [
				{ verb: 'void_warranty', args: [] },
				{ verb: 'with_index', args: [ 'quokka-idx' ] },
			] );
		} );

		it( 'adds new borrowed nodes/edges and drops departed ones, keeping own edits', () => {
			const oldBase = { nodes: [], edges: [] };
			const newBase = {
				nodes: [
					{
						name: 'shared-tee',
						class: 'Tee',
						args: [],
						origin: [ 'performance' ],
						via: [ 'performance' ],
					},
				],
				edges: [
					{
						from: 'shared-tee',
						to: 'zebra-sink',
						origin: [ 'performance' ],
					},
				],
			};
			const g0 = {
				nodes: [
					{
						id: 'wombat-echo',
						name: 'wombat-echo',
						class: 'Echo',
						ctorArgs: [],
						verbInvocations: [],
					},
				],
				edges: [ { from: 'wombat-echo', to: 'wombat-echo' } ],
				frontmatter: {},
				includes: [ 'performance' ],
			};

			const g1 = reconcileIncludes( g0, oldBase, newBase );

			expect( g1.nodes.map( ( n ) => n.name ).sort() ).toEqual( [
				'shared-tee',
				'wombat-echo',
			] );
			expect(
				g1.nodes.find( ( n ) => n.name === 'shared-tee' ).origin
			).toEqual( [ 'performance' ] );
			expect( g1.edges ).toContainEqual( {
				from: 'shared-tee',
				to: 'zebra-sink',
			} );
			// The user's own edge survives untouched.
			expect( g1.edges ).toContainEqual( {
				from: 'wombat-echo',
				to: 'wombat-echo',
			} );

			// Now drop the include: the borrowed node and its edge go, own edits stay.
			const g2 = reconcileIncludes( g1, newBase, oldBase );
			expect( g2.nodes.map( ( n ) => n.name ) ).toEqual( [
				'wombat-echo',
			] );
			expect( g2.edges ).toEqual( [
				{ from: 'wombat-echo', to: 'wombat-echo' },
			] );
		} );

		it( 'does not resurrect a baseline edge the user deleted', () => {
			const base = {
				nodes: [
					{
						name: 'shared-tee',
						class: 'Tee',
						args: [],
						origin: [ 'performance' ],
						via: [ 'performance' ],
					},
				],
				edges: [
					{
						from: 'shared-tee',
						to: 'zebra-sink',
						origin: [ 'performance' ],
					},
				],
			};
			const withDeletion = {
				nodes: [
					{
						id: 'shared-tee',
						name: 'shared-tee',
						class: 'Tee',
						ctorArgs: [],
						verbInvocations: [],
						origin: [ 'performance' ],
					},
				],
				edges: [],
				frontmatter: {},
				includes: [ 'performance' ],
			};
			// Same baseline in and out — a no-op reconcile must not re-add the edge.
			expect(
				reconcileIncludes( withDeletion, base, base ).edges
			).toEqual( [] );
		} );

		it( 'reconciles connect and config roles when an existing baseline edge changes', () => {
			const nodes = [
				{
					name: 'zebra-source',
					class: 'Echo',
					args: [],
					origin: [ 'wombat-base' ],
					via: [ 'wombat-base' ],
				},
				{
					name: 'giraffe-target',
					class: 'Echo',
					args: [],
					origin: [ 'wombat-base' ],
					via: [ 'wombat-base' ],
				},
			];
			const oldBase = {
				nodes,
				edges: [
					{
						from: 'zebra-source',
						to: 'giraffe-target',
						roles: [ 'connect', 'config' ],
					},
				],
			};
			const newBase = {
				nodes,
				edges: [
					{
						from: 'zebra-source',
						to: 'giraffe-target',
						roles: [ 'config' ],
					},
				],
			};
			const graph = applyLoadedBaseline(
				parseTsl( 'include wombat-base\n' ),
				oldBase
			);

			expect(
				reconcileIncludes( graph, oldBase, newBase ).edges
			).toEqual( [
				{
					from: 'zebra-source',
					to: 'giraffe-target',
					roles: [ 'config' ],
				},
			] );
		} );

		it( 'adds a new config role without erasing an existing user connection', () => {
			const nodes = [
				{
					id: 'ibex-source',
					name: 'ibex-source',
					class: 'Echo',
					ctorArgs: [],
					verbInvocations: [],
				},
				{
					id: 'llama-target',
					name: 'llama-target',
					class: 'Echo',
					ctorArgs: [],
					verbInvocations: [],
				},
			];
			const graph = {
				nodes,
				edges: [ { from: 'ibex-source', to: 'llama-target' } ],
				frontmatter: {},
				includes: [],
			};
			const newBase = {
				nodes: [],
				edges: [
					{
						from: 'ibex-source',
						to: 'llama-target',
						roles: [ 'config' ],
					},
				],
			};

			expect(
				reconcileIncludes( graph, { nodes: [], edges: [] }, newBase )
					.edges
			).toEqual( [
				{
					from: 'ibex-source',
					to: 'llama-target',
					roles: [ 'connect', 'config' ],
				},
			] );
		} );

		it( 'keeps a user-added connection when its old config baseline departs', () => {
			const nodes = [
				{
					id: 'cassowary-source',
					name: 'cassowary-source',
					class: 'Echo',
					ctorArgs: [],
					verbInvocations: [],
				},
				{
					id: 'wombat-target-419',
					name: 'wombat-target-419',
					class: 'Echo',
					ctorArgs: [],
					verbInvocations: [],
				},
			];
			const oldBase = {
				nodes: [],
				edges: [
					{
						from: 'cassowary-source',
						to: 'wombat-target-419',
						roles: [ 'config' ],
						config_slots: [ 'set_errors_target' ],
					},
				],
			};
			const graph = {
				nodes,
				edges: [
					{
						from: 'cassowary-source',
						to: 'wombat-target-419',
						roles: [ 'connect', 'config' ],
						config_slots: [ 'set_errors_target' ],
					},
				],
			};

			expect(
				reconcileIncludes( graph, oldBase, { nodes: [], edges: [] } )
					.edges
			).toEqual( [
				{
					from: 'cassowary-source',
					to: 'wombat-target-419',
					roles: [ 'connect' ],
				},
			] );
		} );

		it( 'keeps new config when the user deleted the old physical connection', () => {
			const nodes = [
				{
					id: 'emu-source',
					name: 'emu-source',
					class: 'Echo',
					ctorArgs: [],
					verbInvocations: [],
				},
				{
					id: 'gazelle-target-521',
					name: 'gazelle-target-521',
					class: 'Echo',
					ctorArgs: [],
					verbInvocations: [],
				},
			];
			const oldBase = {
				nodes: [],
				edges: [
					{
						from: 'emu-source',
						to: 'gazelle-target-521',
						roles: [ 'connect' ],
					},
				],
			};
			const newBase = {
				nodes: [],
				edges: [
					{
						from: 'emu-source',
						to: 'gazelle-target-521',
						roles: [ 'config' ],
						config_slots: [ 'set_completed_target' ],
					},
				],
			};

			expect(
				reconcileIncludes( { nodes, edges: [] }, oldBase, newBase )
					.edges
			).toEqual( [
				{
					from: 'emu-source',
					to: 'gazelle-target-521',
					roles: [ 'config' ],
					config_slots: [ 'set_completed_target' ],
				},
			] );
		} );

		it( 'drops an override whose borrowed source departs with its include', () => {
			const oldBase = {
				nodes: [
					{
						name: 'numbat-borrowed-source-811',
						class: 'Echo',
						args: [],
						origin: [ 'numbat-routing' ],
						via: [ 'numbat-routing' ],
					},
				],
				edges: [],
			};
			const graph = applyLoadedBaseline(
				parseTsl(
					'include numbat-routing\n' +
						'cmd numbat-borrowed-source-811:config set_errors_target\n'
				),
				oldBase
			);

			expect(
				reconcileIncludes( graph, oldBase, { nodes: [], edges: [] } )
					.configOverrides
			).toEqual( [] );
		} );

		it( 'refreshes config-slot metadata when the same endpoint changes slots', () => {
			const nodes = [
				{
					id: 'otter-source',
					name: 'otter-source',
					class: 'Echo',
					ctorArgs: [],
					verbInvocations: [],
				},
				{
					id: 'pika-shared-919',
					name: 'pika-shared-919',
					class: 'Echo',
					ctorArgs: [],
					verbInvocations: [],
				},
			];
			const oldBase = {
				nodes: [],
				edges: [
					{
						from: 'otter-source',
						to: 'pika-shared-919',
						roles: [ 'config' ],
						config_slots: [ 'set_errors_target' ],
					},
				],
			};
			const newBase = {
				nodes: [],
				edges: [
					{
						from: 'otter-source',
						to: 'pika-shared-919',
						roles: [ 'config' ],
						config_slots: [ 'set_completed_target' ],
					},
				],
			};

			expect(
				reconcileIncludes(
					{
						nodes,
						edges: [
							{
								from: 'otter-source',
								to: 'pika-shared-919',
								roles: [ 'config' ],
								config_slots: [ 'set_errors_target' ],
							},
						],
					},
					oldBase,
					newBase
				).edges
			).toEqual( newBase.edges );
		} );

		it( 'drops an own edge left dangling by a departed borrowed node', () => {
			const base = {
				nodes: [
					{
						name: 'shared-tee',
						class: 'Tee',
						args: [],
						origin: [ 'performance' ],
						via: [ 'performance' ],
					},
				],
				edges: [],
			};
			const g0 = {
				nodes: [
					{
						id: 'shared-tee',
						name: 'shared-tee',
						class: 'Tee',
						ctorArgs: [],
						verbInvocations: [],
						origin: [ 'performance' ],
					},
					{
						id: 'wombat-echo',
						name: 'wombat-echo',
						class: 'Echo',
						ctorArgs: [],
						verbInvocations: [],
					},
				],
				edges: [ { from: 'wombat-echo', to: 'shared-tee' } ],
				frontmatter: {},
				includes: [ 'performance' ],
			};

			const g1 = reconcileIncludes( g0, base, { nodes: [], edges: [] } );
			expect( g1.edges ).toEqual( [] );
		} );
	} );

	describe( 'applyLoadedBaseline', () => {
		it.each( [ 'Tap', 'Wombat_Fanout' ] )(
			'uses catalog is_tee fan-out semantics for an own %s node',
			( shellName ) => {
				const parsed = parseTsl(
					[
						`make_node ${ shellName } zebra-fanout`,
						'make_node Echo giraffe-sink',
						'make_node Echo llama-sink',
						'connect_node zebra-fanout giraffe-sink',
						'connect_node zebra-fanout llama-sink',
					].join( '\n' )
				);
				const catalog = [ { shell_name: shellName, is_tee: true } ];

				expect(
					applyLoadedBaseline( parsed, null, catalog ).edges
				).toEqual( [
					{
						from: 'zebra-fanout',
						to: 'giraffe-sink',
						roles: [ 'connect' ],
					},
					{
						from: 'zebra-fanout',
						to: 'llama-sink',
						roles: [ 'connect' ],
					},
				] );
			}
		);

		it( 'keeps config routing through an edit connect, save, and reopen', () => {
			const baseline = {
				nodes: [
					{
						name: 'zebra-source',
						class: 'Echo',
						args: [],
						origin: [ 'wombat-base' ],
						via: [ 'wombat-base' ],
					},
					{
						name: 'giraffe-current',
						class: 'Echo',
						args: [],
						origin: [ 'wombat-base' ],
						via: [ 'wombat-base' ],
					},
					{
						name: 'ibex-errors',
						class: 'Echo',
						args: [],
						origin: [ 'wombat-base' ],
						via: [ 'wombat-base' ],
					},
				],
				edges: [
					{
						from: 'zebra-source',
						to: 'giraffe-current',
						roles: [ 'connect' ],
					},
					{
						from: 'zebra-source',
						to: 'ibex-errors',
						roles: [ 'config' ],
					},
				],
			};
			const opened = applyLoadedBaseline(
				parseTsl( 'include wombat-base\nmake_node Echo llama-next\n' ),
				baseline
			);

			const edited = connectDraftEdge(
				opened,
				'zebra-source',
				'llama-next',
				[ { shell_name: 'Echo', is_tee: false } ]
			);
			expect( edited.edges ).toEqual( [
				{
					from: 'zebra-source',
					to: 'ibex-errors',
					roles: [ 'config' ],
				},
				{ from: 'zebra-source', to: 'llama-next' },
			] );
			expect( removeEdge( edited, 'zebra-source', 'ibex-errors' ) ).toBe(
				edited
			);

			const saved = serializeTsl( edited, null, baseline );
			expect( saved ).toBe(
				'include wombat-base\n' +
					'make_node Echo llama-next\n' +
					'disconnect_node zebra-source giraffe-current\n' +
					'connect_node zebra-source llama-next\n'
			);
			expect(
				applyLoadedBaseline( parseTsl( saved ), baseline ).edges
			).toEqual( [
				{
					from: 'zebra-source',
					to: 'ibex-errors',
					roles: [ 'config' ],
				},
				{
					from: 'zebra-source',
					to: 'llama-next',
					roles: [ 'connect' ],
				},
			] );
		} );

		it( 'round-trips a borrowed config override without disturbing another slot', () => {
			const baseline = {
				nodes: [
					'quokka-source',
					'narwhal-old-errors',
					'pangolin-completed',
					'vicuna-new-errors-357',
				].map( ( name ) => ( {
					name,
					class: 'Echo',
					args: [],
					origin: [ 'quokka-routing' ],
					via: [ 'quokka-routing' ],
				} ) ),
				edges: [
					{
						from: 'quokka-source',
						to: 'narwhal-old-errors',
						roles: [ 'config' ],
						config_slots: [ 'set_errors_target' ],
					},
					{
						from: 'quokka-source',
						to: 'pangolin-completed',
						roles: [ 'config' ],
						config_slots: [ 'set_completed_target' ],
					},
				],
			};
			const source =
				'include quokka-routing\n' +
				'cmd quokka-source:config set_errors_target vicuna-new-errors-357\n';
			const opened = applyLoadedBaseline( parseTsl( source ), baseline );
			const expectedEdges = [
				{
					from: 'quokka-source',
					to: 'pangolin-completed',
					roles: [ 'config' ],
					config_slots: [ 'set_completed_target' ],
				},
				{
					from: 'quokka-source',
					to: 'vicuna-new-errors-357',
					roles: [ 'config' ],
					config_slots: [ 'set_errors_target' ],
				},
			];

			expect( opened.edges ).toEqual( expectedEdges );
			expect( serializeTsl( opened, null, baseline ) ).toBe( source );
			const reopened = applyLoadedBaseline(
				parseTsl( serializeTsl( opened, null, baseline ) ),
				baseline
			);
			expect( reopened.edges ).toEqual( expectedEdges );
			expect( reopened.configOverrides ).toEqual(
				opened.configOverrides
			);
		} );

		it( 'resolves a borrowed token override for editing while saving the raw token', () => {
			const baseline = {
				nodes: [
					'cobalt-borrowed-source-619',
					'amber-old-stats-731',
					'violet-resolved-stats-947',
				].map( ( name ) => ( {
					name,
					class: 'Echo',
					args: [],
					origin: [ 'wombat-token-base' ],
					via: [ 'wombat-token-base' ],
				} ) ),
				edges: [
					{
						from: 'cobalt-borrowed-source-619',
						to: 'amber-old-stats-731',
						roles: [ 'config' ],
						config_slots: [ 'set_stats_target' ],
					},
				],
			};
			const source =
				'include wombat-token-base\n' +
				'cmd cobalt-borrowed-source-619:config set_stats_target <wombat:stats_sink>\n';
			const parsed = withResolvedConfigEdges( parseTsl( source ), [
				{
					from: 'cobalt-borrowed-source-619',
					to: 'violet-resolved-stats-947',
					roles: [ 'config' ],
					config_slots: [ 'set_stats_target' ],
				},
			] );

			const opened = applyLoadedBaseline( parsed, baseline );

			expect( opened.edges ).toEqual( [
				{
					from: 'cobalt-borrowed-source-619',
					to: 'violet-resolved-stats-947',
					roles: [ 'config' ],
					config_slots: [ 'set_stats_target' ],
				},
			] );
			expect( opened.configOverrides ).toEqual( [
				{
					from: 'cobalt-borrowed-source-619',
					slot: 'set_stats_target',
					to: '<wombat:stats_sink>',
				},
			] );
			expect( serializeTsl( opened, null, baseline ) ).toBe( source );
		} );

		it( 'uses an empty resolved borrowed token to clear only that slot', () => {
			const baseline = {
				nodes: [
					'teal-borrowed-source-421',
					'orange-old-stats-557',
					'green-completed-863',
				].map( ( name ) => ( {
					name,
					class: 'Echo',
					args: [],
					origin: [ 'wombat-empty-token-base' ],
					via: [ 'wombat-empty-token-base' ],
				} ) ),
				edges: [
					{
						from: 'teal-borrowed-source-421',
						to: 'orange-old-stats-557',
						roles: [ 'config' ],
						config_slots: [ 'set_stats_target' ],
					},
					{
						from: 'teal-borrowed-source-421',
						to: 'green-completed-863',
						roles: [ 'config' ],
						config_slots: [ 'set_completed_target' ],
					},
				],
			};
			const parsed = withResolvedConfigEdges(
				parseTsl(
					'include wombat-empty-token-base\n' +
						'cmd teal-borrowed-source-421:config set_stats_target <wombat:disabled_stats_sink>\n'
				),
				[]
			);

			expect( applyLoadedBaseline( parsed, baseline ).edges ).toEqual( [
				{
					from: 'teal-borrowed-source-421',
					to: 'green-completed-863',
					roles: [ 'config' ],
					config_slots: [ 'set_completed_target' ],
				},
			] );
		} );

		it( 'an empty borrowed override clears one shared-endpoint slot only', () => {
			const baseline = {
				nodes: [ 'aardvark-source', 'tapir-shared-863' ].map(
					( name ) => ( {
						name,
						class: 'Echo',
						args: [],
						origin: [ 'aardvark-routing' ],
						via: [ 'aardvark-routing' ],
					} )
				),
				edges: [
					{
						from: 'aardvark-source',
						to: 'tapir-shared-863',
						roles: [ 'connect', 'config' ],
						config_slots: [
							'set_errors_target',
							'set_completed_target',
						],
					},
				],
			};
			const source =
				'include aardvark-routing\n' +
				'cmd aardvark-source:config set_errors_target\n';
			const opened = applyLoadedBaseline( parseTsl( source ), baseline );

			expect( opened.edges ).toEqual( [
				{
					from: 'aardvark-source',
					to: 'tapir-shared-863',
					roles: [ 'connect', 'config' ],
					config_slots: [ 'set_completed_target' ],
				},
			] );
			expect( serializeTsl( opened, null, baseline ) ).toBe( source );
			expect(
				applyLoadedBaseline( parseTsl( source ), baseline ).edges
			).toEqual( opened.edges );
		} );

		it( 'moves config off a physical connection while preserving that connection', () => {
			const baseline = {
				nodes: [
					'lemur-source',
					'okapi-connected-errors',
					'ibis-new-errors-731',
				].map( ( name ) => ( {
					name,
					class: 'Echo',
					args: [],
					origin: [ 'lemur-routing' ],
					via: [ 'lemur-routing' ],
				} ) ),
				edges: [
					{
						from: 'lemur-source',
						to: 'okapi-connected-errors',
						roles: [ 'connect', 'config' ],
						config_slots: [ 'set_errors_target' ],
					},
				],
			};

			expect(
				applyLoadedBaseline(
					parseTsl(
						'include lemur-routing\n' +
							'cmd lemur-source:config set_errors_target\n'
					),
					baseline
				).edges
			).toEqual( [
				{
					from: 'lemur-source',
					to: 'okapi-connected-errors',
					roles: [ 'connect' ],
				},
			] );
			expect(
				applyLoadedBaseline(
					parseTsl(
						'include lemur-routing\n' +
							'cmd lemur-source:config set_errors_target ibis-new-errors-731\n'
					),
					baseline
				).edges
			).toEqual( [
				{
					from: 'lemur-source',
					to: 'okapi-connected-errors',
					roles: [ 'connect' ],
				},
				{
					from: 'lemur-source',
					to: 'ibis-new-errors-731',
					roles: [ 'config' ],
					config_slots: [ 'set_errors_target' ],
				},
			] );
		} );

		it( 'reapplies a borrowed config override after its include baseline changes', () => {
			const nodes = [
				'marmot-source',
				'moose-old-errors',
				'heron-new-base-errors',
				'orca-user-errors-947',
				'badger-completed',
			].map( ( name ) => ( {
				name,
				class: 'Echo',
				args: [],
				origin: [ 'marmot-routing' ],
				via: [ 'marmot-routing' ],
			} ) );
			const completedEdge = {
				from: 'marmot-source',
				to: 'badger-completed',
				roles: [ 'config' ],
				config_slots: [ 'set_completed_target' ],
			};
			const oldBaseline = {
				nodes,
				edges: [
					{
						from: 'marmot-source',
						to: 'moose-old-errors',
						roles: [ 'config' ],
						config_slots: [ 'set_errors_target' ],
					},
					completedEdge,
				],
			};
			const newBaseline = {
				nodes,
				edges: [
					{
						from: 'marmot-source',
						to: 'heron-new-base-errors',
						roles: [ 'config' ],
						config_slots: [ 'set_errors_target' ],
					},
					completedEdge,
				],
			};
			const graph = applyLoadedBaseline(
				parseTsl(
					'include marmot-routing\n' +
						'cmd marmot-source:config set_errors_target orca-user-errors-947\n'
				),
				oldBaseline
			);

			expect(
				reconcileIncludes( graph, oldBaseline, newBaseline ).edges
			).toEqual( [
				completedEdge,
				{
					from: 'marmot-source',
					to: 'orca-user-errors-947',
					roles: [ 'config' ],
					config_slots: [ 'set_errors_target' ],
				},
			] );
		} );

		it( 're-expands includes and subtracts disconnects on reopen (splice)', () => {
			const collapsed = [
				'include spokes',
				'make_node Grep splice-grep .',
				'connect_node spokes:tee splice-grep',
				'connect_node splice-grep remote:x',
				'disconnect_node spokes:tee remote:x',
			].join( '\n' );
			const parsed = parseTsl( collapsed );
			const baseline = {
				nodes: [
					{
						name: 'spokes:tee',
						class: 'Tee',
						args: [],
						origin: [ 'spokes' ],
						via: [ 'spokes' ],
					},
					{
						name: 'remote:x',
						class: 'HTTP_Out',
						args: [],
						origin: [ 'spokes' ],
						via: [ 'spokes' ],
					},
				],
				edges: [
					{
						from: 'spokes:tee',
						to: 'remote:x',
						origin: [ 'spokes' ],
					},
				],
			};

			const draft = applyLoadedBaseline( parsed, baseline );

			expect( draft.nodes.map( ( n ) => n.name ).sort() ).toEqual( [
				'remote:x',
				'splice-grep',
				'spokes:tee',
			] );
			expect(
				draft.nodes.find( ( n ) => n.name === 'spokes:tee' )
			).toMatchObject( {
				id: 'spokes:tee',
				name: 'spokes:tee',
				class: 'Tee',
				origin: [ 'spokes' ],
				via: [ 'spokes' ],
			} );
			// The re-expanded baseline edge stays subtracted — the splice wins.
			expect( draft.edges ).not.toContainEqual( {
				from: 'spokes:tee',
				to: 'remote:x',
				roles: [ 'connect' ],
			} );
			expect( draft.edges ).toContainEqual( {
				from: 'spokes:tee',
				to: 'splice-grep',
				roles: [ 'connect' ],
			} );
			expect( draft.edges ).toContainEqual( {
				from: 'splice-grep',
				to: 'remote:x',
				roles: [ 'connect' ],
			} );
			expect( draft.disconnects ).toEqual( [] );
		} );

		it( 'applies a real one-argument regular-node rewire after loading its include baseline', () => {
			const parsed = parseTsl(
				[
					'include request-builder',
					'make_node Tee firehose:tee',
					'disconnect_node firehose:consumer',
					'connect_node firehose:consumer firehose:tee',
				].join( '\n' )
			);
			const baseline = {
				nodes: [
					{
						name: 'firehose:consumer',
						class: 'Consumer',
						args: [],
						origin: [ 'request-builder' ],
						via: [ 'request-builder' ],
					},
					{
						name: 'request-builder',
						class: 'Request_Builder',
						args: [],
						origin: [ 'request-builder' ],
						via: [ 'request-builder' ],
					},
				],
				edges: [
					{
						from: 'firehose:consumer',
						to: 'request-builder',
						origin: [ 'request-builder' ],
						roles: [ 'connect' ],
					},
				],
			};

			expect( applyLoadedBaseline( parsed, baseline ).edges ).toEqual( [
				{
					from: 'firehose:consumer',
					to: 'firehose:tee',
					roles: [ 'connect' ],
				},
			] );
		} );

		it( 'uses the loaded source class for disconnect semantics and keeps config edges', () => {
			const regular = parseTsl(
				'include base\ndisconnect_node zebra-source unrelated-target\n'
			);
			const regularBaseline = {
				nodes: [
					{
						name: 'zebra-source',
						class: 'Echo',
						args: [],
						origin: [ 'base' ],
						via: [ 'base' ],
					},
					{
						name: 'giraffe-connect',
						class: 'Echo',
						args: [],
						origin: [ 'base' ],
						via: [ 'base' ],
					},
					{
						name: 'ibex-config',
						class: 'Echo',
						args: [],
						origin: [ 'base' ],
						via: [ 'base' ],
					},
				],
				edges: [
					{
						from: 'zebra-source',
						to: 'giraffe-connect',
						origin: [ 'base' ],
						roles: [ 'connect' ],
					},
					{
						from: 'zebra-source',
						to: 'ibex-config',
						origin: [ 'base' ],
						roles: [ 'config' ],
					},
				],
			};

			expect(
				applyLoadedBaseline( regular, regularBaseline ).edges
			).toEqual( [
				{
					from: 'zebra-source',
					to: 'ibex-config',
					roles: [ 'config' ],
				},
			] );

			const regularReconnect = parseTsl(
				[
					'include base',
					'make_node Echo llama-current',
					'connect_node zebra-source llama-current',
				].join( '\n' )
			);
			expect(
				applyLoadedBaseline( regularReconnect, regularBaseline ).edges
			).toEqual( [
				{
					from: 'zebra-source',
					to: 'ibex-config',
					roles: [ 'config' ],
				},
				{
					from: 'zebra-source',
					to: 'llama-current',
					roles: [ 'connect' ],
				},
			] );

			const tee = parseTsl( 'include base\ndisconnect_node zebra:tee\n' );
			const teeBaseline = {
				nodes: [
					{
						name: 'zebra:tee',
						class: 'Tee',
						args: [],
						origin: [ 'base' ],
						via: [ 'base' ],
					},
					{
						name: 'llama-handler',
						class: 'Echo',
						args: [],
						origin: [ 'base' ],
						via: [ 'base' ],
					},
				],
				edges: [
					{
						from: 'zebra:tee',
						to: 'llama-handler',
						origin: [ 'base' ],
						roles: [ 'connect' ],
					},
				],
			};

			expect( applyLoadedBaseline( tee, teeBaseline ).edges ).toEqual( [
				{
					from: 'zebra:tee',
					to: 'llama-handler',
					roles: [ 'connect' ],
				},
			] );
		} );

		it( 'preserves a regular connect followed by disconnect in source order', () => {
			const parsed = parseTsl(
				[
					'include base',
					'make_node Echo llama-next',
					'connect_node zebra-source llama-next',
					'disconnect_node zebra-source',
				].join( '\n' )
			);
			const baseline = {
				nodes: [
					{
						name: 'zebra-source',
						class: 'Echo',
						args: [],
						origin: [ 'base' ],
						via: [ 'base' ],
					},
					{
						name: 'giraffe-current',
						class: 'Echo',
						args: [],
						origin: [ 'base' ],
						via: [ 'base' ],
					},
					{
						name: 'ibex-config',
						class: 'Echo',
						args: [],
						origin: [ 'base' ],
						via: [ 'base' ],
					},
				],
				edges: [
					{
						from: 'zebra-source',
						to: 'giraffe-current',
						roles: [ 'connect' ],
					},
					{
						from: 'zebra-source',
						to: 'ibex-config',
						roles: [ 'config' ],
					},
				],
			};

			expect( applyLoadedBaseline( parsed, baseline ).edges ).toEqual( [
				{
					from: 'zebra-source',
					to: 'ibex-config',
					roles: [ 'config' ],
				},
			] );
		} );

		it( 'preserves a Tee connect followed by targeted disconnect in source order', () => {
			const parsed = parseTsl(
				[
					'include base',
					'make_node Echo llama-next',
					'connect_node zebra:tee llama-next',
					'disconnect_node zebra:tee llama-next',
				].join( '\n' )
			);
			const baseline = {
				nodes: [
					{
						name: 'zebra:tee',
						class: 'Tee',
						is_tee: true,
						args: [],
						origin: [ 'base' ],
						via: [ 'base' ],
					},
					{
						name: 'giraffe-existing',
						class: 'Echo',
						args: [],
						origin: [ 'base' ],
						via: [ 'base' ],
					},
				],
				edges: [
					{
						from: 'zebra:tee',
						to: 'giraffe-existing',
						roles: [ 'connect' ],
					},
				],
			};

			expect( applyLoadedBaseline( parsed, baseline ).edges ).toEqual( [
				{
					from: 'zebra:tee',
					to: 'giraffe-existing',
					roles: [ 'connect' ],
				},
			] );
		} );
	} );

	describe( 'generateNodeName', () => {
		it( 'returns lowercased class for first instance', () => {
			expect( generateNodeName( empty, 'Echo' ) ).toBe( 'echo' );
		} );

		it( 'increments suffix on collision', () => {
			const g = addNode( empty, {
				shellName: 'Echo',
				name: 'echo',
				x: 0,
				y: 0,
			} );
			expect( generateNodeName( g, 'Echo' ) ).toBe( 'echo-2' );
		} );

		it( 'finds the next free suffix when middle slots are filled', () => {
			let g = addNode( empty, {
				shellName: 'Echo',
				name: 'echo',
				x: 0,
				y: 0,
			} );
			g = addNode( g, {
				shellName: 'Echo',
				name: 'echo-2',
				x: 0,
				y: 0,
			} );
			g = addNode( g, {
				shellName: 'Echo',
				name: 'echo-3',
				x: 0,
				y: 0,
			} );
			expect( generateNodeName( g, 'Echo' ) ).toBe( 'echo-4' );
		} );
	} );
} );

describe( 'applyLoadedBaseline — dangling edges', () => {
	it( 'drops a baseline edge whose endpoint no node provides', () => {
		// reconcileIncludes filters these out; if applyLoadedBaseline keeps them
		// the two disagree and a freshly-opened topology reads as DIRTY.
		const graph = {
			nodes: [],
			edges: [],
			frontmatter: {},
			includes: [ 'performance' ],
			disconnects: [],
		};
		const baseline = {
			nodes: [
				{
					name: 'zebra:consumer',
					class: 'Consumer',
					args: [],
					origin: [ 'performance' ],
					via: [ 'performance' ],
				},
			],
			edges: [
				{
					from: 'zebra:consumer',
					to: 'ghost:tee',
					origin: [ 'performance' ],
				},
			],
		};

		expect( applyLoadedBaseline( graph, baseline ).edges ).toEqual( [] );
	} );
} );
