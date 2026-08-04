import { graphFromTsl } from '../draftToGraph';
import { DraftInterpreterNode } from '../../../runtime/draft-interpreter-node';

describe( 'graphFromTsl', () => {
	it( 'returns an empty graph for empty input', () => {
		expect( graphFromTsl( '' ) ).toEqual( {
			nodes: [],
			edges: [],
			frontmatter: {},
			secureLevel: '',
			includes: [],
			configOverrides: [],
			resolvedConfigEdges: null,
		} );
	} );

	it( 'parses include lines into graph.includes, in declaration order', () => {
		const g = graphFromTsl(
			'include performance\ninclude job-router\nmake_node Echo wombat-echo\n'
		);
		expect( g.includes ).toEqual( [ 'performance', 'job-router' ] );
		expect( g.nodes.map( ( n ) => n.name ) ).toEqual( [ 'wombat-echo' ] );
	} );

	it( 'captures var frontmatter into an ordered map', () => {
		const g = graphFromTsl(
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

	it( 'splices a backslash continuation with nothing (bash semantics)', () => {
		const g = graphFromTsl(
			'var num_partitions = 1\\\n6\nmake_node Echo z\n'
		);
		expect( g.frontmatter ).toEqual( { num_partitions: '16' } );
	} );

	it( 'splices a mid-token backslash continuation in ctor args', () => {
		const g = graphFromTsl( 'make_node Echo e hi\\\nbye\n' );
		expect( g.nodes[ 0 ].ctorArgs ).toEqual( [ 'hibye' ] );
	} );

	it( 'joins a backslash-continued var (parity with PHP frontmatter)', () => {
		const g = graphFromTsl(
			'var num_partitions = \\\n    7\nmake_node Echo z\n'
		);
		expect( g.frontmatter ).toEqual( { num_partitions: '7' } );
	} );

	it( 'splits a line on ; to capture multiple vars (matches PHP frontmatter parser)', () => {
		const g = graphFromTsl(
			'var num_partitions = 4; var stale_timeout = 120\n'
		);
		expect( g.frontmatter ).toEqual( {
			num_partitions: '4',
			stale_timeout: '120',
		} );
	} );

	it( 'returns an empty frontmatter map when there are no var lines', () => {
		const g = graphFromTsl( 'make_node Echo echo\n' );
		expect( g.frontmatter ).toEqual( {} );
	} );

	it( 'parses a single bare make_node', () => {
		const g = graphFromTsl( 'make_node Echo echo\n' );
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
		const g = graphFromTsl( 'make_node Partition p /tmp/log 0 16777216\n' );
		expect( g.nodes[ 0 ].ctorArgs ).toEqual( [
			'/tmp/log',
			'0',
			'16777216',
		] );
	} );

	it( 'attaches cmd lines as verb invocations on the named node', () => {
		const g = graphFromTsl(
			'make_node Partition p\n' +
				'cmd p:config allow_large_writes\n' +
				'cmd p:config with_index request-index\n'
		);
		expect( g.nodes[ 0 ].verbInvocations ).toEqual( [
			{ verb: 'allow_large_writes', args: [], viaConfig: true },
			{
				verb: 'with_index',
				args: [ 'request-index' ],
				viaConfig: true,
			},
		] );
	} );

	it( 'retains config-target commands for borrowed nodes as ordered overrides', () => {
		// The overrides name a node the INCLUDE supplies, so the expansion has
		// to be there for them to land on anything.
		const graph = graphFromTsl(
			'include quokka-routing\n' +
				'cmd quokka-source:config set_errors_target vicuna-errors-357\n' +
				'cmd quokka-source:config set_completed_target\n',
			{
				nodes: [
					{
						name: 'quokka-source',
						class: 'Echo',
						origin: [ 'quokka-routing' ],
					},
				],
				edges: [],
			}
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
		const g = graphFromTsl(
			'make_node Echo a\nmake_node Echo b\nconnect_node a b\n'
		);
		expect( g.edges ).toEqual( [
			{ from: 'a', to: 'b', roles: [ 'connect' ] },
		] );
	} );

	it( 'preserves quoted ctor args verbatim (quote type carries semantics)', () => {
		const g = graphFromTsl(
			"make_node Hook h wp_loaded 'this has spaces'\n"
		);
		expect( g.nodes[ 0 ].ctorArgs ).toEqual( [
			'wp_loaded',
			"'this has spaces'",
		] );
	} );

	it( 'keeps the deferred-binder Topic pattern verbatim', () => {
		const g = graphFromTsl(
			"make_node Topic jobs <config:logs_dir>/jobs.p'<partition>' 4\n"
		);
		expect( g.nodes[ 0 ].ctorArgs ).toEqual( [
			"<config:logs_dir>/jobs.p'<partition>'",
			'4',
		] );
	} );

	it( 'unwraps double-quoted and backtick args like the runtime Shell', () => {
		const g = graphFromTsl(
			'make_node Echo scorer\n' +
				'cmd scorer:config add_profile "Engineers care about uptime"\n' +
				'cmd scorer:config add_profile `Prioritize breaking news`\n'
		);
		expect( g.nodes[ 0 ].verbInvocations ).toEqual( [
			{
				viaConfig: true,
				verb: 'add_profile',
				args: [ '"Engineers care about uptime"' ],
			},
			{
				verb: 'add_profile',
				args: [ '`Prioritize breaking news`' ],
				viaConfig: true,
			},
		] );
	} );

	it( 'honors backslash escapes inside quotes (Shell tokenize parity)', () => {
		const g = graphFromTsl(
			"make_node Echo n\ncmd n:config set_label 'it\\'s \\\\quoted'\n"
		);
		expect( g.nodes[ 0 ].verbInvocations ).toEqual( [
			{
				verb: 'set_label',
				args: [ "'it\\'s \\\\quoted'" ],
				viaConfig: true,
			},
		] );
	} );

	it( 'keeps a quoted multi-word arg intact through a cd-scoped bare verb', () => {
		const g = graphFromTsl(
			'make_node Echo scorer\n' +
				'cd scorer:config\n' +
				'add_profile "Do not reward flame wars"\n' +
				'cd /\n'
		);
		expect( g.nodes[ 0 ].verbInvocations ).toEqual( [
			{
				verb: 'add_profile',
				args: [ '"Do not reward flame wars"' ],
				viaConfig: true,
			},
		] );
	} );

	it( 'keeps a quoted multi-word arg intact through an explicit cmd path', () => {
		const g = graphFromTsl(
			'make_node Echo scorer\n' +
				'cmd scorer:config add_profile "Deprioritize sports scores"\n'
		);
		expect( g.nodes[ 0 ].verbInvocations ).toEqual( [
			{
				verb: 'add_profile',
				args: [ '"Deprioritize sports scores"' ],
				viaConfig: true,
			},
		] );
	} );

	it( 'ignores blank lines and # comments', () => {
		const g = graphFromTsl(
			'\n# a comment\nmake_node Echo a\n# another\n'
		);
		expect( g.nodes ).toHaveLength( 1 );
		expect( g.nodes[ 0 ].name ).toBe( 'a' );
	} );

	it( 'round-trips a non-trivial document through dumpDocument', () => {
		// The parity property a save/load cycle depends on: a dump re-read and
		// re-dumped is the same document. The INPUT text is not the oracle —
		// statements regroup per node — the fixed point is.
		const tsl = [
			'make_node Partition p /tmp/log 0',
			'command_node p:config allow_large_writes',
			'make_node RequestBuilder r',
			'connect_node r p',
		].join( '\n' );

		const once = new DraftInterpreterNode();
		once.load( tsl );
		const dumped = once.dumpDocument();

		const twice = new DraftInterpreterNode();
		twice.load( dumped );

		expect( twice.dumpDocument() ).toBe( dumped );
		expect( graphFromTsl( dumped ).edges ).toEqual( [
			{ from: 'r', to: 'p', roles: [ 'connect' ] },
		] );
	} );
} );

describe( 'graphFromTsl — disconnect_node', () => {
	// The include supplies the edge the file then removes; without it there is
	// nothing to disconnect FROM and the test proves nothing.
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

	it( 'applies a splice so the reopened graph does not resurrect the edge', () => {
		// The worked splice's saved form: the include re-expands `spokes:tee ->
		// remote:x` on load, and this line is what removes it again. Drop it and
		// reopening resurrects the very edge the splice deleted.
		const g = graphFromTsl(
			'include hub-control\n' +
				'make_node Grep wombat-grep zebra-pattern\n' +
				'disconnect_node spokes:tee remote:x\n' +
				'connect_node spokes:tee wombat-grep\n' +
				'connect_node wombat-grep remote:x\n',
			HUB
		);

		expect( g.edges ).toEqual( [
			{ from: 'spokes:tee', to: 'wombat-grep', roles: [ 'connect' ] },
			{ from: 'wombat-grep', to: 'remote:x', roles: [ 'connect' ] },
		] );
	} );

	it( 'clears the target when a regular node disconnects from it', () => {
		const g = graphFromTsl(
			[
				'make_node Echo zebra-source',
				'make_node Echo giraffe-target',
				'connect_node zebra-source giraffe-target',
				'disconnect_node zebra-source giraffe-target',
			].join( '\n' )
		);

		expect( g.edges ).toEqual( [] );
	} );

	it( 'removes only the named target from a fan-out node', () => {
		const g = graphFromTsl(
			'include hub-control\ndisconnect_node spokes:tee remote:x\n',
			HUB
		);

		expect( g.edges ).toEqual( [] );
	} );

	it( 'applies connect and disconnect in statement order', () => {
		// Reversed, this leaves the edge in place — the order IS the meaning.
		const g = graphFromTsl(
			[
				'make_node Tee zebra:tee',
				'make_node Echo ibex-target',
				'connect_node zebra:tee ibex-target',
				'disconnect_node zebra:tee ibex-target',
			].join( '\n' )
		);

		expect( g.edges ).toEqual( [] );
	} );
} );

describe( 'graphFromTsl — verb aliases', () => {
	it( 'reads `make` as `make_node` (the interpreter aliases it, and topologies use it)', () => {
		// ELN's performance.tsl says `make Tee firehose:tee`. A parser that only
		// knows the long form silently drops the node.
		const g = graphFromTsl(
			'make Tee wombat:tee\nconnect_node wombat:tee zebra\n'
		);
		expect( g.nodes.map( ( n ) => n.name ) ).toEqual( [ 'wombat:tee' ] );
		expect( g.nodes[ 0 ].class ).toBe( 'Tee' );
	} );

	it( 'reads `disconnect` as `disconnect_node`', () => {
		const g = graphFromTsl(
			[
				'make_node Tee wombat:tee',
				'make_node Echo zebra',
				'connect wombat:tee zebra',
				'disconnect wombat:tee zebra',
			].join( '\n' )
		);
		expect( g.edges ).toEqual( [] );
	} );
} );

/**
 * `secure` / `insecure` declares the process policy for the topology being
 * loaded. It is a statement rather than frontmatter so it stays the same verb
 * an operator would type — greppable, which is half its value — and the Shell
 * runs it in file order, so the serializer must emit it LAST: `secure 1`
 * disables make_node, and a declaration mid-file would refuse the rest of the
 * graph it is meant to protect.
 */
describe( 'graphFromTsl secure level', () => {
	it( 'reads a trailing secure level', () => {
		const g = graphFromTsl( 'make_node Echo e\nsecure 3\n' );

		expect( g.secureLevel ).toBe( '3' );
	} );

	it( 'reads insecure', () => {
		const g = graphFromTsl( 'make_node Echo e\ninsecure\n' );

		expect( g.secureLevel ).toBe( 'insecure' );
	} );

	it( 'leaves it unset when the topology declares nothing', () => {
		const g = graphFromTsl( 'make_node Echo e\n' );

		expect( g.secureLevel ).toBe( '' );
	} );
} );
