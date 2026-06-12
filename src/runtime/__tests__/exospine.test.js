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
} );
