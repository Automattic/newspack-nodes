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
} from '../draftGraph';

describe( 'draftGraph', () => {
	const empty = { nodes: [], edges: [] };

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
