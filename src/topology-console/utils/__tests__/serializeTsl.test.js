import { serializeTsl } from '../serializeTsl';

describe( 'serializeTsl', () => {
	it( 'returns empty string for an empty graph', () => {
		expect( serializeTsl( { nodes: [], edges: [] } ) ).toBe( '' );
	} );

	it( 'emits make_node for a bare node with no args', () => {
		const g = {
			nodes: [
				{
					id: 'echo',
					name: 'echo',
					class: 'Echo',
					ctorArgs: [],
					verbInvocations: [],
				},
			],
			edges: [],
		};
		expect( serializeTsl( g ) ).toBe( 'make_node Echo echo\n' );
	} );

	it( 'serializes ctor args positionally', () => {
		const g = {
			nodes: [
				{
					id: 'p',
					name: 'p',
					class: 'Partition',
					ctorArgs: [ '/tmp/log', 0, 16777216 ],
					verbInvocations: [],
				},
			],
			edges: [],
		};
		expect( serializeTsl( g ) ).toBe(
			'make_node Partition p /tmp/log 0 16777216\n'
		);
	} );

	it( 'emits cmd lines for verb invocations', () => {
		const g = {
			nodes: [
				{
					id: 'p',
					name: 'p',
					class: 'Partition',
					ctorArgs: [],
					verbInvocations: [
						{ verb: 'allow_large_writes', args: [] },
						{ verb: 'with_index', args: [ 'request-index' ] },
					],
				},
			],
			edges: [],
		};
		expect( serializeTsl( g ) ).toBe(
			'make_node Partition p\n' +
				'cmd p:config allow_large_writes\n' +
				'cmd p:config with_index request-index\n'
		);
	} );

	it( 'emits connect_node lines for edges', () => {
		const g = {
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
		};
		expect( serializeTsl( g ) ).toBe(
			'make_node Echo a\nmake_node Echo b\nconnect_node a b\n'
		);
	} );

	it( 'single-quotes ctor args containing spaces', () => {
		const g = {
			nodes: [
				{
					id: 'h',
					name: 'h',
					class: 'Hook',
					ctorArgs: [ 'wp_loaded', 'this has spaces' ],
					verbInvocations: [],
				},
			],
			edges: [],
		};
		expect( serializeTsl( g ) ).toBe(
			"make_node Hook h wp_loaded 'this has spaces'\n"
		);
	} );

	it( 'omits empty-string ctor arg trailing slots', () => {
		// Empty trailing slots are dropped, not emitted as literal tokens.
		const g = {
			nodes: [
				{
					id: 'p',
					name: 'p',
					class: 'Partition',
					ctorArgs: [ '/tmp/log', 0, '', '', '' ],
					verbInvocations: [],
				},
			],
			edges: [],
		};
		expect( serializeTsl( g ) ).toBe(
			'make_node Partition p /tmp/log 0\n'
		);
	} );

	describe( 'schema-default expansion', () => {
		const schemas = {
			Partition: {
				arguments: [
					{ name: 'base_dir', type: 'string', required: true },
					{
						name: 'partition',
						type: 'int',
						required: true,
						default: '<partition>',
					},
					{
						name: 'segment_size',
						type: 'int',
						default: '<config:segment_size>',
					},
					{
						name: 'num_segments',
						type: 'int',
						default: '<config:num_segments>',
					},
					{
						name: 'max_lifespan',
						type: 'int',
						default: '<config:max_lifespan>',
					},
				],
				commands: [
					{
						name: 'with_index',
						args: [
							{
								name: 'formatter',
								type: 'formatter_name',
								required: true,
							},
						],
					},
				],
			},
			FlameBuilder: {
				arguments: [],
				commands: [
					{
						name: 'set_is_hub',
						args: [
							{
								name: 'is_hub',
								type: 'bool',
								required: true,
								default: '<config:is_hub>',
							},
						],
					},
					{
						name: 'configure_stats',
						args: [
							{
								name: 'partition',
								type: 'int',
								required: true,
								default: '<partition>',
							},
						],
					},
				],
			},
		};

		it( 'fills empty trailing ctor slots from schema defaults', () => {
			// Operator types only base_dir; saved TSL must keep the substitution-token defaults.
			const g = {
				nodes: [
					{
						id: 'flames:partition',
						name: 'flames:partition',
						class: 'Partition',
						ctorArgs: [ '/tmp/flames.log' ],
						verbInvocations: [],
					},
				],
				edges: [],
			};
			expect( serializeTsl( g, schemas ) ).toBe(
				'make_node Partition flames:partition /tmp/flames.log <partition> <config:segment_size> <config:num_segments> <config:max_lifespan>\n'
			);
		} );

		it( 'fills empty interior slot from default, preserves author value after', () => {
			const g = {
				nodes: [
					{
						id: 'p',
						name: 'p',
						class: 'Partition',
						ctorArgs: [ '/tmp/log', '', '', '', 86400 ],
						verbInvocations: [],
					},
				],
				edges: [],
			};
			expect( serializeTsl( g, schemas ) ).toBe(
				'make_node Partition p /tmp/log <partition> <config:segment_size> <config:num_segments> 86400\n'
			);
		} );

		it( 'author-provided value always wins over default', () => {
			const g = {
				nodes: [
					{
						id: 'p',
						name: 'p',
						class: 'Partition',
						ctorArgs: [ '/tmp/log', 7, 4096 ],
						verbInvocations: [],
					},
				],
				edges: [],
			};
			expect( serializeTsl( g, schemas ) ).toBe(
				'make_node Partition p /tmp/log 7 4096 <config:num_segments> <config:max_lifespan>\n'
			);
		} );

		it( 'fills verb-arg defaults too', () => {
			const g = {
				nodes: [
					{
						id: 'fb',
						name: 'fb',
						class: 'FlameBuilder',
						ctorArgs: [],
						verbInvocations: [
							{ verb: 'set_is_hub', args: [] },
							{ verb: 'configure_stats', args: [] },
						],
					},
				],
				edges: [],
			};
			expect( serializeTsl( g, schemas ) ).toBe(
				'make_node FlameBuilder fb\n' +
					'cmd fb:config set_is_hub <config:is_hub>\n' +
					'cmd fb:config configure_stats <partition>\n'
			);
		} );

		it( 'no schemas → no default expansion (backwards compatibility)', () => {
			const g = {
				nodes: [
					{
						id: 'p',
						name: 'p',
						class: 'Partition',
						ctorArgs: [ '/tmp/log' ],
						verbInvocations: [],
					},
				],
				edges: [],
			};
			expect( serializeTsl( g ) ).toBe(
				'make_node Partition p /tmp/log\n'
			);
		} );

		it( 'unknown class falls through with no defaults applied', () => {
			// No schema -> trailing empties trimmed, nothing fills the gap.
			const g = {
				nodes: [
					{
						id: 'x',
						name: 'x',
						class: 'NotInSchema',
						ctorArgs: [ 'a', '', '' ],
						verbInvocations: [],
					},
				],
				edges: [],
			};
			expect( serializeTsl( g, schemas ) ).toBe(
				'make_node NotInSchema x a\n'
			);
		} );

		it( 'empty default in spec is treated as no-default (slot stays empty)', () => {
			const local = {
				Foo: {
					arguments: [
						{ name: 'a', type: 'string', required: true },
						{ name: 'b', type: 'string', default: '' },
					],
				},
			};
			const g = {
				nodes: [
					{
						id: 'f',
						name: 'f',
						class: 'Foo',
						ctorArgs: [ 'hello' ],
						verbInvocations: [],
					},
				],
				edges: [],
			};
			expect( serializeTsl( g, local ) ).toBe(
				'make_node Foo f hello\n'
			);
		} );
	} );

	describe( 'interpreter verb-target distinction', () => {
		const schemas = {
			Performance_CI: {
				is_interpreter: true,
				arguments: [],
				commands: [ { name: 'set_is_hub', args: [] } ],
			},
			Partition: {
				is_interpreter: false,
				arguments: [],
				commands: [ { name: 'allow_large_writes', args: [] } ],
			},
		};

		it( 'serializes an interpreter node verb to a bare `cmd <name> <verb>`', () => {
			// A Command_Interpreter_Node subclass handles its verbs directly —
			// there is no `<name>:config` sibling, so the verb targets the bare node.
			const g = {
				nodes: [
					{
						id: 'perf',
						name: 'perf',
						class: 'Performance_CI',
						ctorArgs: [],
						verbInvocations: [ { verb: 'set_is_hub', args: [] } ],
					},
				],
				edges: [],
			};
			expect( serializeTsl( g, schemas ) ).toBe(
				'make_node Performance_CI perf\n' + 'cmd perf set_is_hub\n'
			);
		} );

		it( 'serializes a non-interpreter node verb to `cmd <name>:config <verb>`', () => {
			const g = {
				nodes: [
					{
						id: 'p',
						name: 'p',
						class: 'Partition',
						ctorArgs: [],
						verbInvocations: [
							{ verb: 'allow_large_writes', args: [] },
						],
					},
				],
				edges: [],
			};
			expect( serializeTsl( g, schemas ) ).toBe(
				'make_node Partition p\n' + 'cmd p:config allow_large_writes\n'
			);
		} );

		it( 'round-trips an interpreter verb through parseTsl (bare form)', () => {
			// eslint-disable-next-line global-require
			const { parseTsl } = require( '../parseTsl' );
			const original = {
				nodes: [
					{
						id: 'perf',
						name: 'perf',
						class: 'Performance_CI',
						ctorArgs: [],
						verbInvocations: [ { verb: 'set_is_hub', args: [] } ],
					},
				],
				edges: [],
			};
			const tsl = serializeTsl( original, schemas );
			const reparsed = parseTsl( tsl );
			expect( reparsed.nodes[ 0 ].verbInvocations ).toEqual( [
				{ verb: 'set_is_hub', args: [] },
			] );
		} );

		it( 'round-trips a non-interpreter verb through parseTsl (:config form)', () => {
			// eslint-disable-next-line global-require
			const { parseTsl } = require( '../parseTsl' );
			const original = {
				nodes: [
					{
						id: 'p',
						name: 'p',
						class: 'Partition',
						ctorArgs: [],
						verbInvocations: [
							{ verb: 'allow_large_writes', args: [] },
						],
					},
				],
				edges: [],
			};
			const tsl = serializeTsl( original, schemas );
			const reparsed = parseTsl( tsl );
			expect( reparsed.nodes[ 0 ].verbInvocations ).toEqual( [
				{ verb: 'allow_large_writes', args: [] },
			] );
		} );
	} );

	describe( 'reserved anchor (_repl)', () => {
		// eslint-disable-next-line global-require
		const { parseTsl } = require( '../parseTsl' );
		// eslint-disable-next-line global-require
		const { withReplAnchor } = require( '../draftGraph' );

		it( 'emits no make_node for a reserved node', () => {
			const g = {
				nodes: [
					{
						id: '_repl',
						name: '_repl',
						class: 'CommandInterpreter',
						reserved: true,
						ctorArgs: [],
						verbInvocations: [],
					},
				],
				edges: [],
			};
			expect( serializeTsl( g ) ).toBe( '' );
		} );

		it( 'emits no outgoing wiring from a reserved node', () => {
			const g = {
				nodes: [
					{
						id: '_repl',
						name: '_repl',
						class: 'CommandInterpreter',
						reserved: true,
						ctorArgs: [],
						verbInvocations: [],
					},
					{
						id: 'x',
						name: 'x',
						class: 'Echo',
						ctorArgs: [],
						verbInvocations: [],
					},
				],
				// Reserved node as edge SOURCE must be dropped.
				edges: [ { from: '_repl', to: 'x' } ],
			};
			expect( serializeTsl( g ) ).toBe( 'make_node Echo x\n' );
		} );

		it( 'emits connect_node for an edge TO a reserved node', () => {
			const g = {
				nodes: [
					{
						id: '_repl',
						name: '_repl',
						class: 'CommandInterpreter',
						reserved: true,
						ctorArgs: [],
						verbInvocations: [],
					},
					{
						id: 'x',
						name: 'x',
						class: 'Echo',
						ctorArgs: [],
						verbInvocations: [],
					},
				],
				edges: [ { from: 'x', to: '_repl' } ],
			};
			expect( serializeTsl( g ) ).toBe(
				'make_node Echo x\nconnect_node x _repl\n'
			);
		} );

		it( 'round-trips a normal node → _repl edge', () => {
			const original = withReplAnchor( {
				nodes: [
					{
						id: 'my-tee',
						name: 'my-tee',
						class: 'Tee',
						ctorArgs: [],
						verbInvocations: [],
					},
				],
				edges: [ { from: 'my-tee', to: '_repl' } ],
			} );
			const tsl = serializeTsl( original );
			expect( tsl ).toBe(
				'make_node Tee my-tee\nconnect_node my-tee _repl\n'
			);
			const reparsed = withReplAnchor( parseTsl( tsl ) );
			expect(
				reparsed.nodes.find( ( n ) => n.id === 'my-tee' )
			).toBeDefined();
			const repl = reparsed.nodes.find( ( n ) => n.id === '_repl' );
			expect( repl ).toBeDefined();
			expect( repl.reserved ).toBe( true );
			expect( reparsed.edges ).toContainEqual( {
				from: 'my-tee',
				to: '_repl',
			} );
		} );
	} );
} );
