import { mountExospine } from '../exospine';
import { Core } from '../core';
import { RouterNode } from '../router-node';
import { CommandInterpreterNode } from '../command-interpreter-node';
import { Node } from '../node';
import names from '../reserved-node-names.json';

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

		// What a Reset Graph does: the owner replaces the backbone, and the
		// fresh one announces itself.
		owner.teardown();
		mountExospine();

		expect( builds ).toBe( 2 );
		expect( Core.node( 'passenger:tee' ) ).not.toBeNull();
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
		owner.teardown();

		expect( () => Core.bumpGraphGeneration() ).not.toThrow();
		expect( builds ).toBe( 1 );

		mountExospine();
		expect( builds ).toBe( 2 );
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
 * `_http` targets `_output`: the wire-inbound clause stamps an unaddressed
 * non-response with it, which is how a server-side `log` broadcast — minted
 * with no TO and packed verbatim into the reply body — reaches the transcript
 * instead of dying at `_router` as "message not addressed".
 */
test( '_http targets _output', () => {
	mountExospine();
	expect( Core.node( names.HTTP ).target ).toBe( names.OUTPUT );
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
