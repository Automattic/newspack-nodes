import { serializeTsl, serializeCtorArgs } from '../serializeTsl';

describe( 'serializeCtorArgs', () => {
	const spec = [
		{ name: 'source_file', type: 'string', required: true },
		{ name: 'segment_size', type: 'int', default: 4096 },
	];

	it( 'joins positional values, single-quoting whitespace', () => {
		expect( serializeCtorArgs( [ 'a log', '8192' ], spec ) ).toBe(
			"'a log' 8192"
		);
	} );

	it( 'fills an empty slot from its schema default', () => {
		expect( serializeCtorArgs( [ 'in.log', '' ], spec ) ).toBe(
			'in.log 4096'
		);
	} );

	it( 'drops trailing empties (no default) to an empty string', () => {
		expect(
			serializeCtorArgs( [ '', '' ], [ { name: 'x', type: 'string' } ] )
		).toBe( '' );
	} );
} );

describe( 'serializeTsl', () => {
	it( 'does not serialize a config-only baseline edge as a removable connect edge', () => {
		const baseline = {
			nodes: [],
			edges: [
				{
					from: 'zebra-source',
					to: 'ibex-config',
					roles: [ 'config' ],
				},
			],
		};
		const graph = {
			includes: [ 'wombat-base' ],
			frontmatter: {},
			nodes: [],
			edges: [],
		};

		expect( serializeTsl( graph, null, baseline ) ).toBe(
			'include wombat-base\n'
		);
	} );

	it( 'emits frontmatter var lines first, in insertion order', () => {
		const g = {
			frontmatter: { num_partitions: '4', custom_thing: 'a b c' },
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
		expect( serializeTsl( g ) ).toBe(
			'var num_partitions = 4\n' +
				'var custom_thing = a b c\n' +
				'make_node Echo echo\n'
		);
	} );

	it( 'emits no var lines when frontmatter is empty or absent', () => {
		const g = {
			frontmatter: {},
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

	it( 'round-trips frontmatter losslessly through parse -> serialize -> parse', () => {
		const { parseTsl } = require( '../parseTsl' );
		const tsl =
			'var num_partitions = 4\n' +
			'var stale_timeout = 120\n' +
			'var custom_thing = a b c\n' +
			'make_node Echo echo\n';
		const round = parseTsl( serializeTsl( parseTsl( tsl ) ) );
		expect( round.frontmatter ).toEqual( {
			num_partitions: '4',
			stale_timeout: '120',
			custom_thing: 'a b c',
		} );
	} );

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
				'command_node p:config allow_large_writes\n' +
				'command_node p:config with_index request-index\n'
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

	it( 'emits an already-quoted raw span verbatim (quote type = semantics)', () => {
		// Double quotes interpolate <…>; single quotes defer. parseTsl hands
		// back raw spans, so re-quoting here would silently flip semantics.
		const g = {
			nodes: [
				{
					id: 's',
					name: 'scorer',
					class: 'Echo',
					ctorArgs: [],
					verbInvocations: [
						{
							verb: 'add_profile',
							args: [ '"Engineers care about <team>"' ],
						},
					],
				},
			],
			edges: [],
		};
		expect( serializeTsl( g ) ).toBe(
			'make_node Echo scorer\n' +
				'command_node scorer:config add_profile "Engineers care about <team>"\n'
		);
	} );

	it( 'keeps the deferred-binder Topic ctor span verbatim', () => {
		const g = {
			nodes: [
				{
					id: 'j',
					name: 'jobs',
					class: 'Topic',
					ctorArgs: [ "<config:logs_dir>/jobs.p'<partition>'", '4' ],
					verbInvocations: [],
				},
			],
			edges: [],
		};
		expect( serializeTsl( g ) ).toBe(
			"make_node Topic jobs <config:logs_dir>/jobs.p'<partition>' 4\n"
		);
	} );

	it( 'quotes a value with an UNBALANCED quote instead of leaking it', () => {
		// A user-typed `it's` scans as one span equal to itself but leaves the
		// quote open — emitted verbatim it would write an unterminated quote
		// into the .tsl, which the fatal loader rejects at worker boot.
		const g = {
			nodes: [
				{
					id: 'n',
					name: 'n',
					class: 'Echo',
					ctorArgs: [ "it's" ],
					verbInvocations: [],
				},
			],
			edges: [],
		};
		expect( serializeTsl( g ) ).toBe( "make_node Echo n 'it\\'s'\n" );
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
						name: 'max_segments',
						type: 'int',
						default: '<config:max_segments>',
					},
					{
						name: 'max_lifetime',
						type: 'int',
						default: '<config:max_lifetime>',
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
								default: '<eln:is_hub>',
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
			// Operator types only base_dir; TSL keeps the token defaults.
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
				'make_node Partition flames:partition /tmp/flames.log <partition> <config:segment_size> <config:max_segments> <config:max_lifetime>\n'
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
				'make_node Partition p /tmp/log <partition> <config:segment_size> <config:max_segments> 86400\n'
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
				'make_node Partition p /tmp/log 7 4096 <config:max_segments> <config:max_lifetime>\n'
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
					'command_node fb:config set_is_hub <eln:is_hub>\n' +
					'command_node fb:config configure_stats <partition>\n'
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

		it( 'serializes an interpreter node verb to a bare `command_node <name> <verb>`', () => {
			// Interpreter nodes take verbs on the bare node, no :config.
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
				'make_node Performance_CI perf\n' +
					'command_node perf set_is_hub\n'
			);
		} );

		it( 'serializes a non-interpreter node verb to `command_node <name>:config <verb>`', () => {
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
				'make_node Partition p\n' +
					'command_node p:config allow_large_writes\n'
			);
		} );

		it( 'round-trips an interpreter verb through parseTsl (bare form)', () => {
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

	describe( 'collapsed form with baseline (includes + edge deltas)', () => {
		const baseline = {
			nodes: [
				{
					name: 'spokes:tee',
					class: 'Tee',
					args: [],
					origin: [ 'hub-control' ],
				},
				{
					name: 'remote:x',
					class: 'Echo',
					args: [],
					origin: [ 'hub-control' ],
				},
			],
			edges: [
				{
					from: 'spokes:tee',
					to: 'remote:x',
					origin: [ 'hub-control' ],
				},
			],
		};

		it( 'emits the collapsed form: include lines, own nodes only, disconnect before connect', () => {
			// The worked splice: a Grep dropped between two borrowed endpoints.
			const graph = {
				includes: [ 'hub-control' ],
				frontmatter: {},
				nodes: [
					{
						id: 'spokes:tee',
						name: 'spokes:tee',
						class: 'Tee',
						ctorArgs: [],
						verbInvocations: [],
						origin: [ 'hub-control' ],
					},
					{
						id: 'remote:x',
						name: 'remote:x',
						class: 'Echo',
						ctorArgs: [],
						verbInvocations: [],
						origin: [ 'hub-control' ],
					},
					{
						id: 'wombat-grep',
						name: 'wombat-grep',
						class: 'Grep',
						ctorArgs: [ 'zebra-pattern' ],
						verbInvocations: [],
					},
				],
				edges: [
					{ from: 'spokes:tee', to: 'wombat-grep' },
					{ from: 'wombat-grep', to: 'remote:x' },
				],
			};

			expect( serializeTsl( graph, null, baseline ) ).toBe(
				'include hub-control\n' +
					'make_node Grep wombat-grep zebra-pattern\n' +
					'disconnect_node spokes:tee remote:x\n' +
					'connect_node spokes:tee wombat-grep\n' +
					'connect_node wombat-grep remote:x\n'
			);
		} );

		it( 'emits a disconnect even when a new edge shares the same source (a Tee appends)', () => {
			const graph = {
				includes: [ 'hub-control' ],
				frontmatter: {},
				nodes: [
					{
						id: 'spokes:tee',
						name: 'spokes:tee',
						class: 'Tee',
						ctorArgs: [],
						verbInvocations: [],
						origin: [ 'hub-control' ],
					},
					{
						id: 'remote:x',
						name: 'remote:x',
						class: 'Echo',
						ctorArgs: [],
						verbInvocations: [],
						origin: [ 'hub-control' ],
					},
					{
						id: 'zebra-echo',
						name: 'zebra-echo',
						class: 'Echo',
						ctorArgs: [],
						verbInvocations: [],
					},
				],
				edges: [ { from: 'spokes:tee', to: 'zebra-echo' } ],
			};

			const out = serializeTsl( graph, null, baseline );
			expect( out ).toContain( 'disconnect_node spokes:tee remote:x' );
			expect( out.indexOf( 'disconnect_node' ) ).toBeLessThan(
				out.indexOf( 'connect_node' )
			);
		} );

		it( 'emits an unchanged baseline edge as neither a connect nor a disconnect', () => {
			const graph = {
				includes: [ 'hub-control' ],
				frontmatter: {},
				nodes: baseline.nodes.map( ( n ) => ( {
					id: n.name,
					name: n.name,
					class: n.class,
					ctorArgs: [],
					verbInvocations: [],
					origin: n.origin,
				} ) ),
				edges: [ { from: 'spokes:tee', to: 'remote:x' } ],
			};

			expect( serializeTsl( graph, null, baseline ) ).toBe(
				'include hub-control\n'
			);
		} );
	} );

	describe( 'reserved anchor (_repl)', () => {
		const { parseTsl } = require( '../parseTsl' );
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

/**
 * The declaration goes LAST, after every make_node and every edge: `secure 1`
 * disables make_node, so a declaration emitted earlier would refuse the rest of
 * the graph it is meant to protect.
 */
describe( 'serializeTsl secure level', () => {
	const graph = ( secureLevel ) => ( {
		nodes: [ { id: 'e', name: 'e', class: 'Echo' } ],
		edges: [],
		frontmatter: {},
		includes: [],
		secureLevel,
	} );

	it( 'emits a numeric level as the final line', () => {
		const lines = serializeTsl( graph( '3' ) ).trim().split( '\n' );

		expect( lines[ lines.length - 1 ] ).toBe( 'secure 3' );
	} );

	it( 'emits insecure as the final line', () => {
		const lines = serializeTsl( graph( 'insecure' ) ).trim().split( '\n' );

		expect( lines[ lines.length - 1 ] ).toBe( 'insecure' );
	} );

	it( 'emits nothing when the topology declares nothing', () => {
		expect( serializeTsl( graph( '' ) ) ).not.toContain( 'secure' );
	} );
} );
