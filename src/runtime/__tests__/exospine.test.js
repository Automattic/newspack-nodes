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
	// The poke target is fixed backbone wiring, not set on RemoteLink connect — so
	// the `_heartbeat → _http/workers` edge survives a Reset Graph rebuild at `/`
	// where the console never connects a worker stream.
	const { teardown } = mountExospine();
	expect( Core.node( names.HEARTBEAT ).target ).toBe(
		`${ names.HTTP }/workers`
	);
	teardown();
} );

test( 'teardown unregisters both backbone nodes from Core', () => {
	const { teardown } = mountExospine();

	teardown();

	expect( Core.node( names.COMMAND_INTERPRETER ) ).toBeNull();
	expect( Core.node( names.ROUTER ) ).toBeNull();
} );

test( 'teardown fully clears the backbone (sink edge + caller TIMER listeners)', () => {
	const { interpreter, router, teardown } = mountExospine();
	// A caller clips a poll node onto the router TIMER, as the console does.
	router.register( 'TIMER', 'poll', () => {} );

	teardown();

	expect( interpreter.sink ).toBeNull();
	// removeNode wipes registrations wholesale, so the caller's TIMER listener
	// cannot survive teardown.
	expect( router.registrations.TIMER?.poll ).toBeUndefined();
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
		// A fresh instance under the same name (the old one was removed first, so
		// the rebuild's setName doesn't collide).
		expect( Core.node( 'view' ) ).not.toBeNull();
		expect( Core.node( 'view' ) ).not.toBe( first );
		// The old instance was fully removed (removeNode clears its name).
		expect( first.name ).toBe( '' );
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
		// A sibling (the debug overlay) registers its own node into the same
		// per-page Core AFTER mount — reinit must not touch it.
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
		expect( Core.node( names.ROUTER ) ).toBeNull();
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

		// Everything is a fresh instance — no exceptions, the backbone included.
		expect( builds ).toBe( 2 );
		expect( Core.node( names.COMMAND_INTERPRETER ) ).not.toBe(
			firstInterpreter
		);
		expect( Core.node( names.ROUTER ) ).not.toBe( firstRouter );
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

		// The backbone is untouched — no full rebuild for a non-delegated graph.
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

describe( 'mountExospine — Core.reinit stash', () => {
	test( 'stashes the spine reinit on Core.reinit (same function)', () => {
		const spine = mountExospine( () => {} );

		expect( Core.reinit ).toBe( spine.reinit );
	} );

	test( 'does NOT stash Core.reinit for a bare mount (no build)', () => {
		mountExospine();

		expect( Core.reinit ).toBeNull();
	} );

	test( 'clears Core.reinit on teardown', () => {
		const { teardown } = mountExospine( () => {} );

		teardown();

		expect( Core.reinit ).toBeNull();
	} );

	test( 'stashes the build-registered names on Core.reinitNames', () => {
		mountExospine( ( { interpreter } ) => {
			const view = new Node();
			view.name = 'view';
			view.sink = interpreter;
		} );

		expect( Core.reinitNames ).toEqual( [ 'view' ] );
	} );

	test( 'clears Core.reinitNames on teardown', () => {
		const { teardown } = mountExospine( ( { interpreter } ) => {
			const view = new Node();
			view.name = 'view';
			view.sink = interpreter;
		} );

		teardown();

		expect( Core.reinitNames ).toBeNull();
	} );

	test( 'accumulates names across co-mounted builds; a teardown drops only its own', () => {
		// Two build-delegated mounts share the page (e.g. the hub overview's several
		// dashboards). reinitNames must recognize BOTH builds' infra, not just the
		// last — else the Reset Graph chip counts the others as user-added.
		const a = mountExospine( ( { interpreter } ) => {
			const n = new Node();
			n.name = 'a:view';
			n.sink = interpreter;
		} );
		const b = mountExospine( ( { interpreter } ) => {
			const n = new Node();
			n.name = 'b:view';
			n.sink = interpreter;
		} );

		expect( [ ...Core.reinitNames ].sort() ).toEqual( [
			'a:view',
			'b:view',
		] );

		// Tearing down the reusing mount drops only its names; the owner's survive.
		b.teardown();
		expect( Core.reinitNames ).toEqual( [ 'a:view' ] );

		a.teardown();
	} );
} );

test( 'a second build-mount reuses the backbone without tearing it down (no orphaned interpreter)', () => {
	const a = mountExospine( () => {} ); // owner — creates the backbone
	const b = mountExospine( () => {} ); // reuser — must NOT rebuild it out from under itself

	// The reuser sees the SAME live backbone; its mount must not have triggered a
	// generation bump that swapped the shared backbone (orphaning nodes wired to it).
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
	// The Overview co-mounts two build-delegated graphs (useDashboardGraph +
	// useTopicProbeStream) on one page. Only the FIRST (owner) mount may bump:
	// a second bump would full-rebuild the first graph (swapping the shared
	// backbone out from under its nodes / its SSE link). The reuser's
	// ownsBackbone=false guard must keep the generation at exactly +1.
	const before = Core.graphGeneration;

	mountExospine( () => {} ); // owner — the one allowed bump
	expect( Core.graphGeneration ).toBe( before + 1 );

	mountExospine( () => {} ); // reuser — must NOT bump
	expect( Core.graphGeneration ).toBe( before + 1 );
} );

test( 'a reusing co-mount rebuilds against the FRESH backbone after the owner full-rebuilds', () => {
	// The owner's full rebuild (generation bump) replaces the backbone instances.
	// A co-mounted reuser captured its spine at mount; its reinit must re-sync so
	// its build sees the NEW _http — else it sets .client on the removed node while
	// the live _http has none.
	mountExospine( () => {} ); // owner — owns the backbone, subscribes fullRebuild
	const seen = {};
	mountExospine( ( spine ) => {
		seen.http = spine.http; // record the _http this build was handed
	} );
	const firstHttp = Core.node( names.HTTP );
	expect( seen.http ).toBe( firstHttp );

	Core.bumpGraphGeneration();

	const freshHttp = Core.node( names.HTTP );
	expect( freshHttp ).not.toBe( firstHttp ); // owner replaced the backbone
	expect( seen.http ).toBe( freshHttp ); // the reuser's rebuild saw the fresh one
} );

test( 'co-mount does not rebuild the first graph (its build runs once across both mounts)', () => {
	let firstBuilds = 0;
	mountExospine( () => {
		firstBuilds += 1;
	} ); // owner
	mountExospine( () => {} ); // reuser co-mounts after

	// The reuser's mount must not have driven a generation bump that re-ran
	// (and thus tore down + rebuilt) the first graph's build.
	expect( firstBuilds ).toBe( 1 );
} );
