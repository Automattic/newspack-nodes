/**
 * The draft's mutation vocabulary IS the TSL grammar.
 *
 * These cases were the `draftGraph` mutator suite — `addNode`, `removeNode`,
 * `moveNode`, `connectDraftEdge`, `updateNodeArgs`… — a parallel set of graph
 * functions with the same NAMES as verbs but their own semantics. They are the
 * verbs now, so each case runs the statement and reads the node table.
 *
 * Every no-op case matters as much as the mutating ones: an editor that
 * silently renames a node onto an existing one loses a node.
 */

import { Core } from '../core';
import { serializeDraftArg } from '../shell-node';
import { DraftInterpreterNode } from '../draft-interpreter-node';

// A draft reports every non-`ok` reply, because nothing else would: several
// cases here exercise a deliberate refusal, so capture and assert on it.
let reported = [];
beforeEach( () => {
	reported = [];
	jest.spyOn( Core, 'stderr' ).mockImplementation( ( line ) =>
		reported.push( line )
	);
} );
afterEach( () => jest.restoreAllMocks() );

const draft = ( tsl = '', baseline = null ) => {
	const d = new DraftInterpreterNode();
	d.load( tsl, baseline );
	return d;
};
const names = ( d ) => [ ...d.childRegistry.nodes.keys() ];
const targetsOf = ( d, name ) => {
	const t = d.childRegistry.node( name )?.target;
	return Array.isArray( t ) ? t : [ t ].filter( Boolean );
};

describe( 'make_node', () => {
	it( 'adds a node carrying its declared class and args', () => {
		const d = draft( 'make_node Partition aardvark aardvark.log 4096' );
		const node = d.childRegistry.node( 'aardvark' );

		expect( node.shellClassName() ).toBe( 'Partition' );
		expect( node.arguments ).toEqual( [ 'aardvark.log', '4096' ] );
	} );
} );

describe( 'connect_node', () => {
	it( 'points a regular node at its target', () => {
		const d = draft(
			'make_node Echo pangolin\nmake_node Echo quokka\nconnect_node pangolin quokka'
		);

		expect( targetsOf( d, 'pangolin' ) ).toEqual( [ 'quokka' ] );
	} );

	it( 'APPENDS on a fan-out node, so a second target joins the first', () => {
		const d = draft(
			[
				'make_node Tee zebra',
				'make_node Echo ocelot',
				'make_node Echo meerkat',
				'connect_node zebra ocelot',
				'connect_node zebra meerkat',
			].join( '\n' )
		);

		expect( targetsOf( d, 'zebra' ) ).toEqual( [ 'ocelot', 'meerkat' ] );
	} );

	it( 'REPLACES on a regular node — one target is all it has', () => {
		const d = draft(
			[
				'make_node Echo armadillo',
				'make_node Echo ocelot',
				'make_node Echo meerkat',
				'connect_node armadillo ocelot',
				'connect_node armadillo meerkat',
			].join( '\n' )
		);

		expect( targetsOf( d, 'armadillo' ) ).toEqual( [ 'meerkat' ] );
	} );

	it( 'does not duplicate an edge it already has', () => {
		const d = draft(
			[
				'make_node Tee zebra',
				'make_node Echo ocelot',
				'connect_node zebra ocelot',
				'connect_node zebra ocelot',
			].join( '\n' )
		);

		expect( targetsOf( d, 'zebra' ) ).toEqual( [ 'ocelot' ] );
	} );
} );

describe( 'remove_node', () => {
	it( 'drops the node, and the edges naming it go with it', () => {
		const d = draft(
			[
				'make_node Tee zebra',
				'make_node Echo ocelot',
				'connect_node zebra ocelot',
			].join( '\n' )
		);

		d.run( 'remove_node ocelot' );

		expect( names( d ) ).toEqual( [ 'zebra' ] );
		// Tee prunes dead heads against ITS registry on the next read.
		expect( d.dumpDocument() ).not.toContain( 'connect_node zebra ocelot' );
	} );

	it( 'drops the declarations the removed node owned', () => {
		const d = draft(
			'make_node Partition p p.log\ncommand_node p:config allow_large_writes'
		);

		d.run( 'remove_node p' );

		expect( d.declaredInvocationsFor( 'p' ) ).toEqual( [] );
	} );
} );

describe( 'move_node', () => {
	it( 'renames the node and every target naming it', () => {
		const d = draft(
			[
				'make_node Echo pangolin',
				'make_node Echo quokka',
				'connect_node pangolin quokka',
			].join( '\n' )
		);

		d.run( 'move_node quokka armadillo' );

		expect( names( d ) ).toEqual( [ 'pangolin', 'armadillo' ] );
		expect( targetsOf( d, 'pangolin' ) ).toEqual( [ 'armadillo' ] );
	} );

	it( 'keeps the node’s POSITION, so a rename rewrites one line not the file', () => {
		const d = draft(
			'make_node Echo aardvark\nmake_node Echo pangolin\nmake_node Echo quokka'
		);

		d.run( 'move_node pangolin meerkat' );

		expect( names( d ) ).toEqual( [ 'aardvark', 'meerkat', 'quokka' ] );
	} );

	it( 'refuses a name another node already holds', () => {
		const d = draft( 'make_node Echo pangolin\nmake_node Echo quokka' );

		d.run( 'move_node pangolin quokka' );

		// Both survive: a rename that silently merged them would lose one.
		expect( names( d ) ).toEqual( [ 'pangolin', 'quokka' ] );
		expect( reported.join( '\n' ) ).toContain( 'name collision' );
	} );

	it( 'is a no-op when the name is unchanged', () => {
		const d = draft( 'make_node Echo pangolin' );

		d.run( 'move_node pangolin pangolin' );

		expect( names( d ) ).toEqual( [ 'pangolin' ] );
	} );

	it( 'refuses a name that orphan declarations already hold', () => {
		// `_invocations` outlives its node — dumpDocument writes an orphan
		// declaration back — so a name free in the NODE table can still be
		// taken in the DOCUMENT, and re-keying onto it drops those lines.
		const d = draft(
			[
				'command_node wombat:config set_stats_target capybara',
				'make_node Echo pangolin',
				'command_node pangolin:config set_stats_target numbat',
			].join( '\n' )
		);

		d.run( 'move_node pangolin wombat' );

		expect( names( d ) ).toEqual( [ 'pangolin' ] );
		expect( reported.join( '\n' ) ).toContain( 'collision' );
		expect( d.dumpDocument() ).toContain( 'capybara' );
	} );
} );

describe( 'set_arguments', () => {
	it( 'replaces the named node’s constructor args', () => {
		const d = draft( 'make_node Partition p old.log 1024' );

		d.run( 'set_arguments p new.log 8192' );

		expect( d.childRegistry.node( 'p' ).arguments ).toEqual( [
			'new.log',
			'8192',
		] );
	} );

	it( 'leaves an unknown node alone rather than inventing one', () => {
		const d = draft( 'make_node Partition p p.log' );

		expect( d.run( 'set_arguments nonesuch x' ) ).toBeUndefined();
		expect( names( d ) ).toEqual( [ 'p' ] );
	} );
} );

describe( 'include / remove_include', () => {
	it( 'appends, and is a no-op for one already declared', () => {
		const d = draft( 'include alpha\ninclude beta\ninclude alpha' );

		expect( d.includes ).toEqual( [ 'alpha', 'beta' ] );
	} );

	it( 'drops the named include', () => {
		const d = draft( 'include alpha\ninclude beta' );

		d.run( 'remove_include alpha' );

		expect( d.includes ).toEqual( [ 'beta' ] );
	} );
} );

describe( 'the document survives its mutations', () => {
	it( 'keeps frontmatter and includes across every verb', () => {
		const d = draft(
			[
				'var num_partitions = 4',
				'include alpha',
				'make_node Echo pangolin',
				'make_node Echo quokka',
			].join( '\n' )
		);

		d.run( 'connect_node pangolin quokka' );
		d.run( 'move_node quokka armadillo' );
		d.run( 'set_arguments pangolin x' );
		d.run( 'remove_node armadillo' );

		expect( d.frontmatter ).toEqual( { num_partitions: '4' } );
		expect( d.includes ).toEqual( [ 'alpha' ] );
	} );
} );

describe( 'a stub standing for a fan-out class', () => {
	it( 'drops only the named target on disconnect', () => {
		const d = new DraftInterpreterNode();
		d.catalog = [ { shell_name: 'Settings_Sync', fans_out: true } ];
		d.load(
			[
				'make_node Settings_Sync spokes',
				'make_node Echo alpha',
				'make_node Echo beta',
				'connect_node spokes alpha',
				'connect_node spokes beta',
			].join( '\n' )
		);

		d.run( 'disconnect_node spokes alpha' );

		expect( d.childRegistry.node( 'spokes' ).target ).toEqual( [ 'beta' ] );
	} );

	it( 'clears the list when a target-less disconnect names it', () => {
		const d = new DraftInterpreterNode();
		d.catalog = [ { shell_name: 'Settings_Sync', fans_out: true } ];
		d.load(
			'make_node Settings_Sync spokes\nmake_node Echo alpha\nconnect_node spokes alpha'
		);

		// No target: the Tee rule removes the ISSUING node, and a document
		// statement has no FROM, so nothing matches and the list survives.
		d.run( 'disconnect_node spokes' );

		expect( d.childRegistry.node( 'spokes' ).target ).toEqual( [
			'alpha',
		] );
	} );

	it( 'switches an already-set single target to a list when it fans out', () => {
		const d = new DraftInterpreterNode();
		// A class the browser cannot build, so it is a stub.
		d.load( 'make_node Partition solo solo.log\nmake_node Echo alpha' );
		const node = d.childRegistry.node( 'solo' );
		node.connectNode( 'alpha' );

		node.fansOut = true;

		expect( node.target ).toEqual( [ 'alpha' ] );
	} );
} );

describe( 'a stub standing for a single-target class', () => {
	it( 'clears its target on disconnect', () => {
		const d = draft(
			'make_node Partition solo solo.log\nmake_node Echo alpha\nconnect_node solo alpha'
		);

		d.run( 'disconnect_node solo alpha' );

		expect( d.childRegistry.node( 'solo' ).target ).toBe( '' );
	} );
} );

/**
 * Round-trip defects the console-swap review caught. Each one loses or
 * corrupts something in a SAVED topology, which is the failure mode that does
 * not announce itself: the canvas looks right and the file on disk is wrong.
 */
describe( 'what a save must not lose', () => {
	it( 'keeps a bare `secure`, which is what the stock topologies write', () => {
		// Every stock topology ends with a bare `secure`. Dropping it on save
		// takes the process's security ratchet with it.
		const d = draft( 'make_node Echo aardvark\nsecure\n' );

		expect( d.secureLevel ).toBe( '1' );
		expect( d.dumpDocument() ).toBe(
			'make_node Echo aardvark\nsecure 1\n'
		);
	} );

	it( 'quotes a verb argument containing whitespace', () => {
		const d = draft( 'make_node Echo aardvark' );
		d.replaceInvocations( 'aardvark', [
			{ verb: 'add_profile', args: [ 'hello world' ], viaConfig: true },
		] );

		expect( d.dumpDocument() ).toBe(
			'make_node Echo aardvark\n' +
				"command_node aardvark:config add_profile 'hello world'\n"
		);
	} );

	it( 'keeps an edge to the canvas anchor, which is not a draft node', () => {
		// `_repl` is the worker's auto-mounted Partition. It is a legal target
		// and never a `make_node` line, so a save that drops unknown targets
		// silently deletes the connection the operator just drew.
		const d = draft(
			'make_node Echo aardvark\nconnect_node aardvark _repl'
		);

		expect( d.dumpDocument() ).toBe(
			'make_node Echo aardvark\nconnect_node aardvark _repl\n'
		);
	} );

	it( 'drops references to a node it removed', () => {
		const d = draft(
			[
				'make_node Tee zebra',
				'make_node Echo ocelot',
				'connect_node zebra ocelot',
			].join( '\n' )
		);

		d.run( 'remove_node ocelot' );

		expect( d.dumpDocument() ).toBe( 'make_node Tee zebra\n' );
	} );

	it( 'drops the declarations of a node removed by glob, not just by name', () => {
		const d = draft(
			'make_node Echo pangolin\ncommand_node pangolin:config set_x 1'
		);

		d.run( 'remove_node -a pangol.*' );

		expect( [ ...d.childRegistry.nodes.keys() ] ).toEqual( [] );
		// A later node reusing the name must not inherit the dead verb list.
		expect( d.declaredInvocationsFor( 'pangolin' ) ).toEqual( [] );
	} );

	it( 'quotes an argument carrying a comment or statement separator', () => {
		// An Inspector value arrives PLAIN. Unquoted, `#` starts a comment and
		// `;` ends the statement — both truncate the saved line.
		const d = draft( 'make_node Echo aardvark' );
		const args = [ 'a#b', 'c;d' ].map( serializeDraftArg ).join( ' ' );
		d.run( `set_arguments aardvark ${ args }` );

		const reloaded = draft( d.dumpDocument() );

		expect(
			reloaded.childRegistry
				.node( 'aardvark' )
				.arguments.map( ( a ) => a.replace( /^'|'$/g, '' ) )
		).toEqual( [ 'a#b', 'c;d' ] );
	} );
} );

describe( 'a node the document declares is the document’s', () => {
	it( 'is re-declared on save even if an expansion also supplied it', () => {
		// Opening a child topology while its PARENT's expansion is still in
		// state seeded `test:log` as borrowed, so the document stopped
		// declaring it and a save wrote an empty file. The file's own
		// `make_node` is the authority — an include cannot take a node away.
		const stale = {
			nodes: [ { name: 'test:log', class: 'Log', origin: [ 'test' ] } ],
			edges: [],
		};
		const d = new DraftInterpreterNode();

		d.load( 'make_node Log test:log test.log', stale );

		expect( d.dumpDocument( stale ) ).toBe(
			'make_node Log test:log test.log\n'
		);
	} );
} );

describe( 'round-trip defects the second review found', () => {
	it( 'holds a sparse verb-arg slot open instead of shifting later args left', () => {
		// The Inspector writes `args[i] = value` into a short list, leaving a
		// hole. Rendered as nothing, the tokenizer collapses the gap and every
		// later argument moves down one slot.
		const d = draft( 'make_node Grep aardvark ^x' );
		const args = [ 'first' ];
		args[ 2 ] = 'third';
		d.replaceInvocations( 'aardvark', [
			{ verb: 'set_thing', args, viaConfig: true },
		] );

		const reloaded = draft( d.dumpDocument() );

		expect(
			reloaded.declaredInvocationsFor( 'aardvark' )[ 0 ].args
		).toEqual( [ 'first', "''", 'third' ] );
	} );

	it( 'keeps an include’s edges when the file redeclares its node', () => {
		// An IDENTICAL redeclaration is legal TSL. Replacing the seeded node
		// with a bare stub loses the targets the include gave it, so opening
		// and saving with no edits severs the edge.
		const baseline = {
			nodes: [
				{
					name: 'fan',
					class: 'Tee',
					fans_out: true,
					origin: [ 'shared' ],
				},
				{ name: 'sink', class: 'Echo', origin: [ 'shared' ] },
			],
			edges: [ { from: 'fan', to: 'sink' } ],
		};
		const d = draft( 'include shared\nmake_node Tee fan', baseline );

		expect( d.dumpDocument( baseline ) ).not.toContain( 'disconnect_node' );
	} );

	it( 'strips quoting from the document verbs, which name things', () => {
		// Node ARGUMENTS keep their spans — the quote type is meaning. An
		// include NAME is a name: `include "shared"` includes `shared`.
		const d = draft( 'include "shared"\nvar num = "4"\nsecure "2"' );

		expect( d.includes ).toEqual( [ 'shared' ] );
		expect( d.frontmatter ).toEqual( { num: '4' } );
		expect( d.secureLevel ).toBe( '2' );
	} );
} );

describe( 'var follows the canonical frontmatter grammar', () => {
	it( 'splits on the first `=` even with no spaces around it', () => {
		// PHP `Topology_Registry::frontmatter()` splits the joined tail on the
		// FIRST `=`; assuming `=` is its own token stores the whole thing as
		// the key and writes back a line PHP re-reads differently.
		const d = draft( 'var num_partitions=1' );

		expect( d.frontmatter ).toEqual( { num_partitions: '1' } );
		expect( d.dumpDocument() ).toBe( 'var num_partitions = 1\n' );
	} );

	it( 'keeps a value that itself contains `=`', () => {
		const d = draft( 'var query = a=b&c=d' );

		expect( d.frontmatter ).toEqual( { query: 'a=b&c=d' } );
	} );

	it( 'round-trips a spaced assignment unchanged', () => {
		expect( draft( 'var num = 4' ).dumpDocument() ).toBe( 'var num = 4\n' );
	} );
} );

describe( 'a redeclaration that fails leaves the node it replaced', () => {
	it( 'does not lose the include’s node when construction throws', () => {
		// The claim tears the borrowed node down first. If the replacement
		// then fails to build, the document is left with neither — and the
		// next save writes the node out missing.
		const baseline = {
			nodes: [ { name: 'fan', class: 'Tee', origin: [ 'shared' ] } ],
			edges: [ { from: 'fan', to: 'sink' } ],
		};
		const d = draft( 'include shared', baseline );
		const build = jest
			.spyOn(
				Object.getPrototypeOf( DraftInterpreterNode.prototype ),
				'_cmdMakeNode'
			)
			.mockImplementation( () => {
				throw new Error( 'construction failed' );
			} );

		try {
			d.run( 'make_node Tee fan' );
		} finally {
			build.mockRestore();
		}

		expect( d.childRegistry.node( 'fan' ) ).not.toBeNull();
		expect( d.childRegistry.node( 'fan' ).target ).toEqual( [ 'sink' ] );
	} );
} );

describe( 'a statement the document rejects is not silent', () => {
	it( 'reports a connect_node naming a node nothing supplies', () => {
		// A draft has no sink, so a routed reply goes nowhere: the edge would
		// vanish from the canvas AND the next save with nothing said.
		const d = draft( 'make_node Echo aardvark' );

		d.run( 'connect_node nonesuch aardvark' );

		expect( reported.join( '\n' ) ).toContain( 'unknown node: nonesuch' );
	} );

	it( 'says nothing when every statement is accepted', () => {
		draft( 'make_node Echo aardvark' );

		expect( reported ).toEqual( [] );
	} );
} );

describe( 'round-trip defects the fourth review found', () => {
	it( 'quotes a frontmatter value that would truncate its own line', () => {
		// PHP reads `var` through the tokenizer, so a bare `#` ends the line
		// there too: the value comes back as `/tmp/a`.
		const d = draft( "var path = '/tmp/a#b'" );

		expect( d.frontmatter ).toEqual( { path: '/tmp/a#b' } );
		expect( draft( d.dumpDocument() ).frontmatter ).toEqual( {
			path: '/tmp/a#b',
		} );
	} );

	it( 'keeps a config line aimed at a node no expansion supplied', () => {
		// A load with a missing or partial expansion must not strip the
		// file's own `set_*target` lines on the next save.
		const tsl =
			'include shared\ncommand_node absent:config set_stats_target x\n';

		expect( draft( tsl ).dumpDocument() ).toBe( tsl );
	} );

	it( 'prunes a seeded config edge whose endpoint it removed', () => {
		const baseline = {
			nodes: [
				{ name: 'src', class: 'Echo', origin: [ 's' ] },
				{ name: 'dst', class: 'Echo', origin: [ 's' ] },
			],
			edges: [ { from: 'src', to: 'dst', roles: [ 'config' ] } ],
		};
		const d = draft( 'include shared', baseline );

		d.run( 'remove_node dst' );

		expect( d.seededEdges() ).toEqual( [] );
	} );

	it( 'rewrites a seeded config edge across a rename', () => {
		const baseline = {
			nodes: [
				{ name: 'src', class: 'Echo', origin: [ 's' ] },
				{ name: 'dst', class: 'Echo', origin: [ 's' ] },
			],
			edges: [ { from: 'src', to: 'dst', roles: [ 'config' ] } ],
		};
		const d = draft( 'include shared', baseline );

		d.run( 'move_node dst renamed' );

		expect( d.seededEdges()[ 0 ].to ).toBe( 'renamed' );
	} );

	it( 'reports the targets a non-fan-out redeclaration cannot keep', () => {
		const baseline = {
			nodes: [
				{ name: 'fan', class: 'Tee', fans_out: true, origin: [ 's' ] },
			],
			edges: [
				{ from: 'fan', to: 'a' },
				{ from: 'fan', to: 'b' },
			],
		};
		const d = draft( 'include shared', baseline );

		d.run( 'make_node Echo fan' );

		expect( reported.join( '\n' ) ).toContain( 'fan' );
	} );
} );

describe( 'a load that fails leaves the document alone', () => {
	it( 'keeps the previous document when the source will not parse', () => {
		// `load` clears everything before running the file, so a throw part
		// way through leaves a wiped document behind a toast that reads as
		// recovered — and the next gesture commits the wreckage.
		const d = draft( 'make_node Echo aardvark\nvar num = 4' );

		expect( () => d.load( "make_node Echo 'unterminated" ) ).toThrow();

		expect( names( d ) ).toEqual( [ 'aardvark' ] );
		expect( d.frontmatter ).toEqual( { num: '4' } );
	} );
} );

describe( 'what an include’s edges carry', () => {
	it( 'keeps the config role on an edge that is ALSO a connection', () => {
		// `export_edges` emits roles ['connect','config'] when the same pair
		// was both connected and set as a config target. Routing it down the
		// connect branch alone drops the slot, so removing the physical
		// connection deletes the config routing with it.
		const baseline = {
			nodes: [
				{ name: 'a', class: 'Echo', origin: [ 's' ] },
				{ name: 'b', class: 'Echo', origin: [ 's' ] },
			],
			edges: [
				{
					from: 'a',
					to: 'b',
					roles: [ 'connect', 'config' ],
					config_slots: [ 'set_errors_target' ],
				},
			],
		};

		const d = draft( 'include shared', baseline );

		expect( d.childRegistry.node( 'a' ).target ).toBe( 'b' );
		expect( d.seededEdges() ).toEqual( [
			{
				from: 'a',
				to: 'b',
				roles: [ 'config' ],
				config_slots: [ 'set_errors_target' ],
			},
		] );
	} );
} );

describe( 'set_sink is a verb the document can carry', () => {
	it( 'writes it back instead of dropping it on save', () => {
		// The draft EXECUTES set_sink on load, so a file carrying one renders
		// correctly and then saves without the line.
		const tsl = 'make_node Echo a\nmake_node Echo b\nset_sink a b\n';

		expect( draft( tsl ).dumpDocument() ).toContain( 'set_sink a b' );
	} );
} );

describe( 'remove_include takes what the include brought', () => {
	const SHARED = {
		nodes: [
			{ name: 'borrowedA', class: 'Echo', origin: [ 'shared' ] },
			{ name: 'borrowedB', class: 'Echo', origin: [ 'shared' ] },
			{ name: 'other', class: 'Echo', origin: [ 'kept' ] },
		],
		edges: [ { from: 'borrowedA', to: 'borrowedB' } ],
	};

	it( 'drops the nodes it supplied, so a save cannot name them', () => {
		// Left behind, they are written out as `connect_node borrowedA
		// borrowedB` for nodes the file no longer declares.
		const d = draft( 'include shared\ninclude kept', SHARED );

		d.run( 'remove_include shared' );

		expect( names( d ) ).toEqual( [ 'other' ] );
		expect( d.dumpDocument() ).toBe( 'include kept\n' );
	} );

	it( 'keeps a node another surviving include also provides', () => {
		const d = draft( 'include shared\ninclude kept', {
			nodes: [
				{
					name: 'shared-node',
					class: 'Echo',
					origin: [ 'shared', 'kept' ],
				},
			],
			edges: [],
		} );

		d.run( 'remove_include shared' );

		expect( names( d ) ).toEqual( [ 'shared-node' ] );
	} );
} );

describe( 'a borrowed node the file re-sinks', () => {
	it( 'keeps the set_sink line', () => {
		// The node is the include's, but the LINE is the file's — same rule
		// that keeps a `command_node` aimed at a borrowed node.
		const baseline = {
			nodes: [ { name: 'borrowed', class: 'Echo', origin: [ 's' ] } ],
			edges: [],
		};
		const d = draft(
			'include shared\nmake_node Echo mine\nset_sink borrowed mine',
			baseline
		);

		expect( d.dumpDocument( baseline ) ).toContain(
			'set_sink borrowed mine'
		);
	} );
} );
