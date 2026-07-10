import { augmentWithVirtualEdges } from '../virtualEdges';

// Re-derives edges from 'node_name' verb args that parseTsl doesn't emit.
const CLASSES = [
	{
		shell_name: 'Request_Builder',
		commands: [
			{ name: 'set_errors_target', args: [ { type: 'node_name' } ] },
			{ name: 'set_inflight_interval', args: [ { type: 'int' } ] },
		],
	},
];

describe( 'augmentWithVirtualEdges', () => {
	it( 'derives a virtual edge from a node_name verb arg', () => {
		const graph = {
			nodes: [
				{
					id: 'request-builder',
					class: 'Request_Builder',
					verbInvocations: [
						{
							verb: 'set_errors_target',
							args: [ 'errors:partition' ],
						},
					],
				},
			],
			edges: [],
		};

		const out = augmentWithVirtualEdges( graph, CLASSES );

		expect( out.edges ).toContainEqual( {
			from: 'request-builder',
			to: 'errors:partition',
			virtual: true,
		} );
	} );

	it( 'preserves existing (physical) edges', () => {
		const graph = {
			nodes: [
				{
					id: 'request-builder',
					class: 'Request_Builder',
					verbInvocations: [
						{
							verb: 'set_errors_target',
							args: [ 'errors:partition' ],
						},
					],
				},
			],
			edges: [ { from: 'request-builder', to: 'requests:partition' } ],
		};

		const out = augmentWithVirtualEdges( graph, CLASSES );

		expect( out.edges ).toContainEqual( {
			from: 'request-builder',
			to: 'requests:partition',
		} );
		expect( out.edges ).toHaveLength( 2 );
	} );

	it( 'ignores verb args that are not node_name (no edge for an int arg)', () => {
		const graph = {
			nodes: [
				{
					id: 'request-builder',
					class: 'Request_Builder',
					verbInvocations: [
						{ verb: 'set_inflight_interval', args: [ '1000' ] },
					],
				},
			],
			edges: [],
		};

		const out = augmentWithVirtualEdges( graph, CLASSES );

		expect( out.edges ).toHaveLength( 0 );
	} );

	it( 'returns the same graph reference when there are no virtual edges to add', () => {
		const graph = {
			nodes: [ { id: 'plain', class: 'Echo', verbInvocations: [] } ],
			edges: [],
		};

		expect( augmentWithVirtualEdges( graph, CLASSES ) ).toBe( graph );
	} );

	it( 'preserves non-edge graph fields (pwd) when it appends a virtual edge', () => {
		const graph = {
			nodes: [
				{
					id: 'rb',
					class: 'Request_Builder',
					verbInvocations: [
						{ verb: 'set_errors_target', args: [ 'errors' ] },
					],
				},
				{ id: 'errors', class: 'Partition', verbInvocations: [] },
			],
			edges: [],
			pwd: '_repl/_output/_sse:9/_output',
		};
		const out = augmentWithVirtualEdges( graph, CLASSES );
		expect( out.edges.length ).toBe( 1 );
		expect( out.pwd ).toBe( '_repl/_output/_sse:9/_output' );
	} );
} );
