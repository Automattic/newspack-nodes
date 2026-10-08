import { mountExospine } from '../exospine';
import { Core } from '../core';
import { RouterNode } from '../router-node';
import { CommandInterpreterNode } from '../command-interpreter-node';
import { Node } from '../node';
import names from '../reserved-node-names.json';
import { DumperNode } from '../dumper-node';
import { CallbackNode } from '../callback-node';
import { TapNode } from '../tap-node';
import { RemoteLinkNode } from '../remote-link-node';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
} from '../message';

beforeEach( () => Core.reset() );

test( 'mounts _command_interpreter and _router under their reserved names', () => {
	const { interpreter, router } = mountExospine();

	expect( Core.node( names.COMMAND_INTERPRETER ) ).toBe( interpreter );
	expect( Core.node( names.ROUTER ) ).toBe( router );
	expect( interpreter ).toBeInstanceOf( CommandInterpreterNode );
	expect( router ).toBeInstanceOf( RouterNode );
} );

test( 'the interpreter sinks into the router (everything → interpreter → router)', () => {
	const { interpreter, router } = mountExospine();

	expect( interpreter.sink ).toBe( router );
} );

test( 'the router stays bare — no sink, no target (rule #2)', () => {
	const { router } = mountExospine();

	expect( router.sink ).toBeNull();
	expect( router.target ).toBe( '' );
} );

test( 'mounts a permanent _shell Tap that sinks into the interpreter', () => {
	const { interpreter } = mountExospine();

	const shell = Core.node( names.CONSOLE_TAP );
	expect( shell ).not.toBeNull();
	expect( shell.sink ).toBe( interpreter );
} );

test( 'teardown removes the _shell Tap', () => {
	const { teardown } = mountExospine();

	teardown();

	expect( Core.node( names.CONSOLE_TAP ) ).toBeNull();
} );

test( 'the backbone heartbeat targets _http/workers (permanent edge, even with no connect)', () => {
	// _heartbeat → _http/workers is fixed backbone wiring, not per-connect.
	const { teardown } = mountExospine();
	expect( Core.node( names.HEARTBEAT ).target ).toBe(
		`${ names.HTTP }/workers`
	);
	teardown();
} );

test( 'teardown unregisters the interpreter from Core, and keeps the Router', () => {
	const { teardown } = mountExospine();

	teardown();

	expect( Core.node( names.COMMAND_INTERPRETER ) ).toBeNull();
	expect( Core.node( names.ROUTER ) ).not.toBeNull();
} );

test( 'a hitchhiker removed with the graph unregisters itself from the kept Router', () => {
	const { interpreter, router, teardown } = mountExospine();
	// The ONLY way anything registers on the router TIMER: by node NAME,
	// from TimerNode.setTimer(). Nothing registers a closure there, which is
	// what makes a permanent Router safe — a removed node takes its own
	// registration with it (removeNode → stopTimer → unregister).
	const poller = interpreter.makeNode( 'Timer', 'poll' );
	poller.setTimer();
	expect( 'poll' in router.registrations.TIMER ).toBe( true );

	poller.removeNode();
	expect( 'poll' in router.registrations.TIMER ).toBe( false );

	teardown();
	expect( interpreter.sink ).toBeNull();
} );

/** What a Reset Graph does first: remove every node but the Router. */
function removeAllButRouter() {
	for ( const name of [ ...Core.nodes.keys() ] ) {
		if ( names.ROUTER !== name ) {
			Core.node( name ).removeNode();
		}
	}
}

describe( 'mountExospine( build )', () => {
	test( 'runs the build callback with the backbone spine', () => {
		const seen = {};
		mountExospine( ( spine ) => {
			seen.interpreter = spine.interpreter;
			seen.router = spine.router;
		} );

		expect( seen.interpreter ).toBeInstanceOf( CommandInterpreterNode );
		expect( seen.router ).toBeInstanceOf( RouterNode );
	} );

	test( 'build registers soft nodes that hang off the spine', () => {
		mountExospine( ( { interpreter } ) => {
			const view = new Node();
			view.name = 'view';
			view.sink = interpreter;
		} );

		expect( Core.node( 'view' ) ).not.toBeNull();
		expect( Core.node( 'view' ).sink ).toBe(
			Core.node( names.COMMAND_INTERPRETER )
		);
	} );

	test( 'reinit tears down the build-registered nodes and rebuilds them fresh', () => {
		let builds = 0;
		const { reinit } = mountExospine( ( { interpreter } ) => {
			builds += 1;
			const view = new Node();
			view.name = 'view';
			view.sink = interpreter;
		} );
		const first = Core.node( 'view' );
		expect( builds ).toBe( 1 );

		reinit();

		expect( builds ).toBe( 2 );
		// Fresh instance, same name (old one removed first, no collision).
		expect( Core.node( 'view' ) ).not.toBeNull();
		expect( Core.node( 'view' ) ).not.toBe( first );
		// The old instance was fully removed (removeNode clears its name).
		expect( first.name ).toBe( '' );
	} );

	// The console owns a backbone it did NOT delegate a build to, so a Reset
	// Graph replaces the interpreter under every passenger that clipped onto
	// it. Without rebuilding on backbone-up, a batched poll's Fetchers go on
	// sinking into a removed interpreter — alive, ticking, and unroutable.
	test( 'a reused-backbone mount rebuilds when the backbone is replaced', () => {
		// The owner: no build, so it registers no rebuild of its own.
		const owner = mountExospine();
		let builds = 0;
		mountExospine( ( { interpreter } ) => {
			builds += 1;
			interpreter.makeNode( 'Tee', 'passenger:tee' );
		} );
		expect( builds ).toBe( 1 );

		// What a Reset Graph does: every node but the Router goes, and the
		// backbone raised afresh announces itself.
		removeAllButRouter();
		mountExospine();

		expect( builds ).toBe( 2 );
		expect( Core.node( 'passenger:tee' ) ).not.toBeNull();
		owner.teardown();
	} );

	// Reset Graph removes every node and THEN bumps, so a passenger's rebuild
	// can fire with no backbone at all. Building onto nothing threw and took
	// the page's React tree with it; the backbone-up signal is what rebuilds.
	test( 'a rebuild with no backbone waits rather than throwing', () => {
		const owner = mountExospine();
		let builds = 0;
		mountExospine( ( { interpreter } ) => {
			builds += 1;
			interpreter.makeNode( 'Tee', 'passenger:tee' );
		} );
		removeAllButRouter();

		expect( () => Core.bumpGraphGeneration() ).not.toThrow();
		expect( builds ).toBe( 1 );

		mountExospine();
		expect( builds ).toBe( 2 );
		owner.teardown();
	} );

	test( 'reinit keeps the same backbone instances', () => {
		const { interpreter, router, reinit } = mountExospine( () => {} );

		reinit();

		expect( Core.node( names.COMMAND_INTERPRETER ) ).toBe( interpreter );
		expect( Core.node( names.ROUTER ) ).toBe( router );
	} );

	test( 'reinit preserves nodes registered OUTSIDE build (overlay coexistence)', () => {
		const { reinit } = mountExospine( ( { interpreter } ) => {
			const view = new Node();
			view.name = 'host:view';
			view.sink = interpreter;
		} );
		// Sibling registered into Core after mount — reinit must not touch it.
		const overlay = new Node();
		overlay.name = 'overlay:output';

		reinit();

		expect( Core.node( 'host:view' ) ).not.toBeNull();
		expect( Core.node( 'overlay:output' ) ).toBe( overlay );
	} );

	test( 'build may return a cleanup fn; reinit runs it before rebuilding', () => {
		const calls = [];
		const { reinit } = mountExospine( ( { interpreter } ) => {
			const view = new Node();
			view.name = 'view';
			view.sink = interpreter;
			return () => calls.push( 'cleanup' );
		} );

		reinit();

		expect( calls ).toEqual( [ 'cleanup' ] );
	} );

	test( 'teardown removes build-registered nodes, runs cleanup, and clears the backbone', () => {
		const calls = [];
		const { teardown } = mountExospine( () => {
			const view = new Node();
			view.name = 'view';
			return () => calls.push( 'cleanup' );
		} );

		teardown();

		expect( Core.node( 'view' ) ).toBeNull();
		expect( Core.node( names.COMMAND_INTERPRETER ) ).toBeNull();
		// The Router is the page's heartbeat and is never torn down.
		expect( Core.node( names.ROUTER ) ).not.toBeNull();
		expect( calls ).toEqual( [ 'cleanup' ] );
	} );
} );

describe( 'mountExospine — full rebuild on graphGeneration', () => {
	test( 'a graphGeneration bump tears down + rebuilds the WHOLE graph fresh (backbone too)', () => {
		let builds = 0;
		mountExospine( ( { interpreter } ) => {
			builds += 1;
			const view = new Node();
			view.name = 'view';
			view.sink = interpreter;
		} );
		const firstInterpreter = Core.node( names.COMMAND_INTERPRETER );
		const firstRouter = Core.node( names.ROUTER );
		const firstView = Core.node( 'view' );
		expect( builds ).toBe( 1 );

		Core.bumpGraphGeneration();

		// The graph is rebuilt; the ROUTER is not. It is the page's one
		// heartbeat — every poller hitchhikes its TIMER and every command
		// batches inside its lock/flush bracket — so replacing it on a
		// Reset-Graph is what made the tick undependable, and what drove
		// useReconcile to own a private setInterval instead of riding it.
		expect( builds ).toBe( 2 );
		expect( Core.node( names.COMMAND_INTERPRETER ) ).not.toBe(
			firstInterpreter
		);
		expect( Core.node( names.ROUTER ) ).toBe( firstRouter );
		expect( Core.node( names.ROUTER ).mode ).toBe( 'event_framework' );
		expect( Core.node( 'view' ) ).not.toBe( firstView );
		// The rebuilt soft node sinks into the rebuilt interpreter.
		expect( Core.node( 'view' ).sink ).toBe(
			Core.node( names.COMMAND_INTERPRETER )
		);
		expect( Core.node( names.COMMAND_INTERPRETER ).sink ).toBe(
			Core.node( names.ROUTER )
		);
	} );

	test( 'build cleanup runs on a graphGeneration full rebuild', () => {
		const calls = [];
		mountExospine( () => {
			const view = new Node();
			view.name = 'view';
			return () => calls.push( 'cleanup' );
		} );

		Core.bumpGraphGeneration();

		expect( calls ).toEqual( [ 'cleanup' ] );
	} );

	test( 'teardown unsubscribes — a later graphGeneration bump does NOT rebuild', () => {
		let builds = 0;
		const { teardown } = mountExospine( () => {
			builds += 1;
		} );
		expect( builds ).toBe( 1 );

		teardown();
		Core.bumpGraphGeneration();

		expect( builds ).toBe( 1 );
	} );

	test( 'a bare mountExospine() does NOT subscribe (console drives its own resetKey)', () => {
		const { interpreter, router } = mountExospine();

		Core.bumpGraphGeneration();

		// Backbone untouched — no full rebuild for a non-delegated graph.
		expect( Core.node( names.COMMAND_INTERPRETER ) ).toBe( interpreter );
		expect( Core.node( names.ROUTER ) ).toBe( router );
	} );
} );

describe( 'mountExospine — host-mount signal', () => {
	test( 'a build-delegated mount bumps graphGeneration (so an open overlay rebuilds its poll on a host tab switch)', () => {
		const before = Core.graphGeneration;

		mountExospine( () => {} );

		expect( Core.graphGeneration ).toBe( before + 1 );
	} );

	test( 'a build-delegated mount runs build exactly once (the pre-subscribe bump does not self-rebuild)', () => {
		let builds = 0;
		mountExospine( () => {
			builds += 1;
		} );

		expect( builds ).toBe( 1 );
	} );

	test( 'a bare mount does NOT bump graphGeneration (the console must not self-loop)', () => {
		const before = Core.graphGeneration;

		mountExospine();

		expect( Core.graphGeneration ).toBe( before );
	} );
} );

describe( 'mountExospine — Core.rebuildable capability flag', () => {
	test( 'sets Core.rebuildable for an owner build-delegated mount', () => {
		mountExospine( () => {} );

		expect( Core.rebuildable ).toBe( true );
	} );

	test( 'does NOT set Core.rebuildable for a bare mount (no build)', () => {
		mountExospine();

		expect( Core.rebuildable ).toBe( false );
	} );

	test( 'clears Core.rebuildable on teardown', () => {
		const { teardown } = mountExospine( () => {} );

		teardown();

		expect( Core.rebuildable ).toBe( false );
	} );
} );

test( 'a second build-mount reuses the backbone without tearing it down (no orphaned interpreter)', () => {
	const a = mountExospine( () => {} ); // owner — creates the backbone
	const b = mountExospine( () => {} ); // reuser — must NOT rebuild backbone

	// The reuser must see the SAME backbone — no generation bump on reuse.
	expect( b.interpreter ).toBe( Core.node( names.COMMAND_INTERPRETER ) );
	expect( a.interpreter ).toBe( b.interpreter );
	expect( b.interpreter.sink ).toBe( Core.node( names.ROUTER ) );

	// Tearing down the reuser leaves the backbone intact for the owner.
	b.teardown();
	expect( Core.node( names.COMMAND_INTERPRETER ) ).toBe( a.interpreter );
	expect( a.interpreter.sink ).toBe( Core.node( names.ROUTER ) );

	// The owner still tears the backbone down.
	a.teardown();
	expect( Core.node( names.COMMAND_INTERPRETER ) ).toBeNull();
} );

test( 'a second co-mounted build graph does NOT bump graphGeneration again (no spurious first-graph rebuild)', () => {
	// Only the owner co-mount may bump; the reuser keeps generation at +1.
	const before = Core.graphGeneration;

	mountExospine( () => {} ); // owner — the one allowed bump
	expect( Core.graphGeneration ).toBe( before + 1 );

	mountExospine( () => {} ); // reuser — must NOT bump
	expect( Core.graphGeneration ).toBe( before + 1 );
} );

test( 'a reusing co-mount rebuilds against the FRESH backbone after the owner full-rebuilds', () => {
	// After the owner rebuilds, a reuser's reinit must re-sync to NEW _http.
	mountExospine( () => {} ); // owner — owns the backbone, subscribes rebuild
	const seen = {};
	mountExospine( ( spine ) => {
		seen.http = spine.http; // record the _http this build was handed
	} );
	const firstHttp = Core.node( names.HTTP );
	expect( seen.http ).toBe( firstHttp );

	Core.bumpGraphGeneration();

	const freshHttp = Core.node( names.HTTP );
	expect( freshHttp ).not.toBe( firstHttp ); // owner replaced the backbone
	expect( seen.http ).toBe( freshHttp ); // reuser's rebuild saw the fresh one
} );

test( 'co-mount does not rebuild the first graph (its build runs once across both mounts)', () => {
	let firstBuilds = 0;
	mountExospine( () => {
		firstBuilds += 1;
	} ); // owner
	mountExospine( () => {} ); // reuser co-mounts after

	// The reuser's mount must not bump generation and re-run the first build.
	expect( firstBuilds ).toBe( 1 );
} );

/**
 * `_http` targets `_null` until a console mounts `_output`. The wire-inbound
 * clause stamps an unaddressed non-response with that target, which is how a
 * server-side `log` broadcast — minted with no TO and packed verbatim into the
 * reply body — reaches somewhere real. `_output` exists only while a console
 * is open, so aiming there unconditionally sends the stamped message to a node
 * that is not registered, and the miss bounces NOT_AVAILABLE at a graph with
 * nowhere to put it. The black hole is a node that is always there.
 */
test( '_http targets _null, and _null is mounted', () => {
	mountExospine();
	expect( Core.node( names.NULL ) ).not.toBeNull();
	expect( Core.node( names.HTTP ).target ).toBe( names.NULL );
} );

/** What lands on the black hole is counted, never forwarded. */
test( '_null swallows what it is filled with', () => {
	mountExospine();
	const nul = Core.node( names.NULL );
	const m = newMessage();
	m[ TO ] = '';

	expect( () => nul.fill( m ) ).not.toThrow();
	expect( nul.counter ).toBe( 1 );
} );

// A page whose only graph is a passenger's — a lone Request node behind a
// front-end panel — still has to put the backbone away when that panel goes.
// Nobody else will: the router self-arms a 1s timer at construction.
describe( 'mountExospine — a passenger-only page', () => {
	beforeEach( () => {
		Core.reset();
	} );

	it( 'tears the backbone down when the LAST passenger leaves', () => {
		const first = mountExospine( undefined, { passenger: true } );
		const second = mountExospine( undefined, { passenger: true } );
		expect( Core.node( names.ROUTER ) ).not.toBeNull();

		first.teardown();
		expect( Core.node( names.ROUTER ) ).not.toBeNull();

		second.teardown();
		// The Router stays; everything else goes.
		expect( Core.node( names.ROUTER ) ).not.toBeNull();
		expect( Core.node( names.HTTP ) ).toBeNull();
		expect( Core.node( names.COMMAND_INTERPRETER ) ).toBeNull();
	} );

	it( 'leaves an OWNED backbone alone when a passenger leaves', () => {
		const owner = mountExospine();
		const passenger = mountExospine( undefined, { passenger: true } );

		passenger.teardown();
		expect( Core.node( names.ROUTER ) ).not.toBeNull();

		owner.teardown();
		expect( Core.node( names.COMMAND_INTERPRETER ) ).toBeNull();
		expect( Core.node( names.ROUTER ) ).not.toBeNull();
	} );
} );

describe( 'the _ui relay', () => {
	// A reply as a worker sends it: TO the invoke's FROM, through the router.
	const replyTo = ( to, payload = 'ok: 42' ) => {
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
		m[ FROM ] = 'worker-7';
		m[ TO ] = to;
		m[ VALUE ] = { name: 'dl_list', payload };
		return m;
	};
	const mountWith = ( debugUi ) => {
		const spine = mountExospine();
		const output = new DumperNode();
		output.name = names.OUTPUT;
		output.setDebugUi( debugUi );
		const got = [];
		const receiver = new CallbackNode( ( m ) => got.push( m ) );
		receiver.name = '_triage:dl_list';
		const stderr = jest.spyOn( Core, 'stderr' ).mockImplementation();
		return { spine, output, got, stderr };
	};
	afterEach( () => jest.restoreAllMocks() );

	test( 'is a backbone node that sinks into the interpreter', () => {
		const { interpreter } = mountExospine();
		expect( Core.node( names.UI )?.sink ).toBe( interpreter );
	} );

	test( 'teardown removes it', () => {
		const { teardown } = mountExospine();
		teardown();
		expect( Core.node( names.UI ) ).toBeNull();
	} );

	test( 'delivers the TO remainder, and prints nothing while debug_ui is off', () => {
		const { spine, output, got } = mountWith( false );
		spine.router.fill( replyTo( `${ names.UI }/_triage:dl_list` ) );
		expect( got ).toHaveLength( 1 );
		expect( got[ 0 ][ VALUE ].payload ).toBe( 'ok: 42' );
		expect( output.transcript ?? [] ).toEqual( [] );
	} );

	test( 'copies the reply to _output as well while debug_ui is on', () => {
		const { spine, output, got } = mountWith( true );
		spine.router.fill( replyTo( `${ names.UI }/_triage:dl_list` ) );
		expect( got ).toHaveLength( 1 );
		expect( output.transcript.map( ( e ) => e.text ).join( '' ) ).toContain(
			'ok: 42'
		);
	} );

	test( 'a reply to bare _ui ends there, unaddressed and unwarned', () => {
		const { spine, output, stderr } = mountWith( false );
		spine.router.fill( replyTo( names.UI ) );
		expect( stderr ).not.toHaveBeenCalled();
		expect( output.transcript ?? [] ).toEqual( [] );
	} );
} );

describe( 'the _ui relay with no receiver behind it', () => {
	afterEach( () => jest.restoreAllMocks() );
	const endAtBareUi = ( type, payload ) => {
		const spine = mountExospine();
		const output = new DumperNode();
		output.name = names.OUTPUT;
		jest.spyOn( Core, 'stderr' ).mockImplementation();
		const m = newMessage();
		m[ TYPE ] = type;
		m[ FROM ] = 'worker-7';
		m[ TO ] = names.UI;
		m[ VALUE ] = { name: 'seek_frame', payload };
		spine.router.fill( m );
		return ( output.transcript ?? [] ).map( ( e ) => e.text ).join( '' );
	};

	test( 'prints a TM_ERROR reply even while debug_ui is off', () => {
		expect(
			endAtBareUi( TM_COMMAND | TM_ERROR, 'unauthorized: step\n' )
		).toContain( 'unauthorized: step' );
	} );

	test( 'hides a plain reply while debug_ui is off, whatever its text', () => {
		expect(
			endAtBareUi( TM_COMMAND | TM_RESPONSE, 'error: not an error\n' )
		).toBe( '' );
	} );

	test( 'still hides an `ok:` reply while debug_ui is off', () => {
		expect( endAtBareUi( TM_COMMAND | TM_RESPONSE, 'ok: paused\n' ) ).toBe(
			''
		);
	} );
} );

describe( 'mountExospine( build ) — shell group Taps, derived from targets', () => {
	/**
	 * A build making one node per path, each targeting it, as a slice's
	 * Fetcher targets `egressPath( group, ci )`.
	 *
	 * @param {...string} paths Target paths.
	 * @return {Function} The build.
	 */
	const targeting =
		( ...paths ) =>
		( { interpreter } ) =>
			paths.forEach( ( path, i ) =>
				interpreter
					.makeNode( 'Node', `sender-${ i }-${ path }` )
					.connectNode( path )
			);

	test( 'mounts a Tap for each group a built node targets, with no declaration', () => {
		const { interpreter } = mountExospine(
			targeting( 'quokka:shell/_http/wombat-ci', 'kea:shell/_http' )
		);

		for ( const name of [ 'quokka:shell', 'kea:shell' ] ) {
			const tap = Core.node( name );
			expect( tap ).toBeInstanceOf( TapNode );
			expect( tap.sink ).toBe( interpreter );
		}
		// A group Tap is a sibling of `_shell`, never routed through it.
		expect( Core.node( 'quokka:shell' ).sink ).not.toBe(
			Core.node( names.CONSOLE_TAP )
		);
	} );

	test( 'claims nothing for a target naming no group', () => {
		mountExospine(
			targeting(
				`${ names.HTTP }/wombat-ci`,
				'shellfish',
				'shell:kea/_http',
				'kea:shellfish/_http'
			)
		);

		expect(
			[ ...Core.nodes.keys() ].filter(
				( n ) => n.endsWith( ':shell' ) || n.startsWith( 'shell:' )
			)
		).toEqual( [] );
	} );

	test( 'a rebuild naming another group releases the old Tap and mounts the new', () => {
		let group = 'quokka';
		const { reinit } = mountExospine( ( spine ) =>
			targeting( `${ group }:shell/_http/wombat-ci` )( spine )
		);
		expect( Core.node( 'quokka:shell' ) ).toBeInstanceOf( TapNode );

		group = 'kea';
		reinit();

		expect( Core.node( 'quokka:shell' ) ).toBeNull();
		expect( Core.node( 'kea:shell' ).sink ).toBe(
			Core.node( names.COMMAND_INTERPRETER )
		);
	} );

	test( 'the Tap stands ahead of the first send the build schedules', async () => {
		let seen = null;
		mountExospine( ( spine ) => {
			targeting( 'quokka:shell/_http/wombat-ci' )( spine );
			Promise.resolve().then( () => {
				seen = Core.node( 'quokka:shell' );
			} );
		} );
		await Promise.resolve();

		expect( seen ).toBeInstanceOf( TapNode );
	} );

	test( 'the group Tap outlives an owner while another owner of it is mounted', () => {
		const first = mountExospine( targeting( 'quokka:shell/_http' ) );
		const second = mountExospine( targeting( 'quokka:shell/_http/x' ), {
			passenger: true,
		} );
		const tap = Core.node( 'quokka:shell' );
		expect( tap ).toBeInstanceOf( TapNode );

		second.teardown();
		expect( Core.node( 'quokka:shell' ) ).toBe( tap );

		first.teardown();
		expect( Core.node( 'quokka:shell' ) ).toBeNull();
	} );

	test( 'the last owner out removes the Tap even when the owner left first', () => {
		const owner = mountExospine( targeting( 'quokka:shell/_http' ) );
		const rider = mountExospine( targeting( 'quokka:shell/_http/x' ), {
			passenger: true,
		} );

		owner.teardown();
		expect( Core.node( 'quokka:shell' ) ).toBeInstanceOf( TapNode );

		rider.teardown();
		expect( Core.node( 'quokka:shell' ) ).toBeNull();
	} );

	test( 'each mount records the groups it claims; Core keeps no count', () => {
		const first = mountExospine( targeting( 'quokka:shell/_http' ) );
		const second = mountExospine(
			targeting( 'quokka:shell/_http/x', 'kea:shell/_http' ),
			{ passenger: true }
		);

		expect( 'shellGroups' in Core ).toBe( false );
		expect(
			Core.backboneMounts.map( ( mount ) => [ ...mount.claimed ].sort() )
		).toEqual( [ [ 'quokka' ], [ 'kea', 'quokka' ] ] );

		second.teardown();
		expect( Core.node( 'kea:shell' ) ).toBeNull();
		expect( Core.node( 'quokka:shell' ) ).toBeInstanceOf( TapNode );
		first.teardown();
	} );

	test( "a build's teardown never removes a group Tap another mount claims", () => {
		const first = mountExospine( targeting( 'quokka:shell/_http' ) );
		const second = mountExospine( targeting( 'quokka:shell/_http/x' ), {
			passenger: true,
		} );

		second.reinit();
		first.reinit();

		expect( Core.node( 'quokka:shell' ) ).toBeInstanceOf( TapNode );
		second.teardown();
		first.teardown();
	} );

	test( 'a command addressed to the group reaches the interpreter through its Tap', () => {
		const { interpreter } = mountExospine(
			targeting( 'quokka:shell/_http' )
		);
		const seen = [];
		interpreter.fill = ( m ) => seen.push( m );

		const m = newMessage();
		m[ TO ] = 'quokka:shell/_http/wombat-ci';
		Core.node( 'quokka:shell' ).fill( m );

		expect( Core.node( 'quokka:shell' ).counter ).toBe( 1 );
		expect( seen ).toHaveLength( 1 );
	} );

	test( 'a full rebuild re-points the group Tap at the fresh interpreter', () => {
		mountExospine( targeting( 'quokka:shell/_http' ) );

		Core.bumpGraphGeneration();

		expect( Core.node( 'quokka:shell' ).sink ).toBe(
			Core.node( names.COMMAND_INTERPRETER )
		);
	} );

	test( "a passenger's group follows a replaced backbone", () => {
		const rider = mountExospine( targeting( 'quokka:shell/_http' ), {
			passenger: true,
		} );
		const owner = mountExospine( () => {} );

		Core.bumpGraphGeneration();

		expect( Core.node( 'quokka:shell' ).sink ).toBe(
			Core.node( names.COMMAND_INTERPRETER )
		);
		rider.teardown();
		owner.teardown();
	} );

	test( 'a Reset Graph that removed every node brings the group Tap back', () => {
		mountExospine( targeting( 'quokka:shell/_http' ) );

		removeAllButRouter();
		Core.bumpGraphGeneration();

		expect( Core.node( 'quokka:shell' ).sink ).toBe(
			Core.node( names.COMMAND_INTERPRETER )
		);
	} );
} );

describe( 'the shared stream link', () => {
	class ClosableEventSource {
		constructor( url ) {
			this.url = url;
			this.closed = false;
			ClosableEventSource.instances.push( this );
		}
		addEventListener() {}
		close() {
			this.closed = true;
		}
	}

	beforeEach( () => {
		ClosableEventSource.instances = [];
		global.EventSource = ClosableEventSource;
		window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'N' };
	} );

	test( 'the backbone mounts one bare RemoteLink as _stream', () => {
		const spine = mountExospine();
		const stream = Core.node( '_stream' );
		expect( names.STREAM ).toBe( '_stream' );
		expect( stream ).toBeInstanceOf( RemoteLinkNode );
		expect( spine.stream ).toBe( stream );
		expect( stream.sink ).toBe( Core.node( names.COMMAND_INTERPRETER ) );
		expect( stream.graphs.size ).toBe( 0 );
		// Bare: it opens nothing until a graph attaches.
		expect( stream.sseIn ).toBeNull();
		expect( ClosableEventSource.instances ).toHaveLength( 0 );
		spine.teardown();
	} );

	test( 'a build is handed the page link', () => {
		let handed = null;
		const spine = mountExospine( ( { stream } ) => {
			handed = stream;
		} );
		expect( handed ).toBe( Core.node( names.STREAM ) );
		spine.teardown();
	} );

	test( 'a passenger reuses the owner’s link rather than mounting a second', () => {
		const owner = mountExospine( () => {} );
		const passenger = mountExospine( () => {}, { passenger: true } );
		expect( owner.stream ).toBeInstanceOf( RemoteLinkNode );
		expect( passenger.stream ).toBe( owner.stream );
		passenger.teardown();
		owner.teardown();
	} );

	test( 'teardown of the owner removes the link and closes its stream', async () => {
		const spine = mountExospine( () => {} );
		spine.stream.attach( [ 'wren.p6' ], 'plover:stream' );
		await Promise.resolve();
		expect( ClosableEventSource.instances ).toHaveLength( 1 );
		spine.teardown();
		expect( Core.node( names.STREAM ) ).toBeNull();
		expect( ClosableEventSource.instances[ 0 ].closed ).toBe( true );
	} );

	test( 'a full rebuild hands the build a fresh link', () => {
		const seen = [];
		mountExospine( ( { stream } ) => {
			seen.push( stream );
		} );
		Core.bumpGraphGeneration();
		expect( seen ).toHaveLength( 2 );
		expect( seen[ 1 ] ).not.toBe( seen[ 0 ] );
		expect( Core.node( names.STREAM ) ).toBe( seen[ 1 ] );
	} );
} );

// Several dashboards share one page's backbone; the first owns it, and its
// leaving must not take the backbone from the mounts that stay.
describe( 'mountExospine — the backbone outlives its owner', () => {
	const asking =
		( name, path ) =>
		( { interpreter } ) =>
			interpreter.makeNode( 'Node', name ).connectNode( path );

	test( 'the owner leaving keeps the backbone, and the other mount’s commands still go out', () => {
		const owner = mountExospine( () => {} );
		const stays = mountExospine(
			asking( 'kiwi-4417:ask', 'kiwi:shell/_http/workers' )
		);
		const kept = [
			names.COMMAND_INTERPRETER,
			names.HTTP,
			names.HEARTBEAT,
			names.STREAM,
		].map( ( name ) => Core.node( name ) );

		owner.teardown();

		expect(
			[
				names.COMMAND_INTERPRETER,
				names.HTTP,
				names.HEARTBEAT,
				names.STREAM,
			].map( ( name ) => Core.node( name ) )
		).toEqual( kept );
		expect( kept.every( Boolean ) ).toBe( true );
		const posted = [];
		Core.node( names.HTTP ).client = {
			postBatch: ( messages ) => {
				posted.push( ...messages );
				return Promise.resolve( [] );
			},
		};
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ VALUE ] = { name: 'list', arguments: [ 'wren-209' ] };
		Core.node( 'kiwi-4417:ask' ).fill( m );
		expect( posted.map( ( p ) => p[ VALUE ] ) ).toEqual( [
			{ name: 'list', arguments: [ 'wren-209' ] },
		] );
		stays.teardown();
	} );

	test( 'a Reset Graph after the owner left raises the backbone through the new owner', () => {
		const owner = mountExospine( () => {} );
		const stays = mountExospine(
			asking( 'kiwi-4417:ask', 'kiwi:shell/_http/workers' )
		);
		owner.teardown();
		expect( Core.rebuildable ).toBe( true );
		const before = Core.node( names.COMMAND_INTERPRETER );

		removeAllButRouter();
		Core.bumpGraphGeneration();

		const raised = Core.node( names.COMMAND_INTERPRETER );
		expect( raised ).toBeInstanceOf( CommandInterpreterNode );
		expect( raised ).not.toBe( before );
		expect( Core.node( names.STREAM ) ).toBeInstanceOf( RemoteLinkNode );
		expect( Core.node( 'kiwi-4417:ask' ).sink ).toBe( raised );
		stays.teardown();
	} );

	test( 'ownership and the Reset Graph capability are read off the mounts', () => {
		const rider = mountExospine( () => {}, { passenger: true } );
		const bare = mountExospine();
		const builder = mountExospine( () => {} );
		const [ , bareMount, builderMount ] = Core.backboneMounts;

		expect( Core.backboneOwner ).toBe( bareMount );
		expect( Core.rebuildable ).toBe( false );
		bare.teardown();
		expect( Core.backboneOwner ).toBe( builderMount );
		expect( Core.rebuildable ).toBe( true );
		expect( () => {
			Core.backboneOwner = null;
		} ).toThrow( TypeError );
		expect( () => {
			Core.rebuildable = false;
		} ).toThrow( TypeError );

		builder.teardown();
		expect( Core.backboneOwner ).toBeNull();
		rider.teardown();
	} );

	test( 'the last mount leaving tears the backbone down, the Router aside', () => {
		const owner = mountExospine( () => {} );
		const stays = mountExospine(
			asking( 'kiwi-4417:ask', 'kiwi:shell/_http/workers' )
		);
		owner.teardown();
		stays.teardown();
		for ( const name of [
			names.COMMAND_INTERPRETER,
			names.HTTP,
			names.HEARTBEAT,
			names.STREAM,
			names.CONSOLE_TAP,
			'kiwi-4417:ask',
		] ) {
			expect( Core.node( name ) ).toBeNull();
		}
		expect( Core.node( names.ROUTER ) ).not.toBeNull();
		expect( Core.rebuildable ).toBe( false );
	} );
} );
