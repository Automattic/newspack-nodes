/**
 * mountExospine — construct + register the canonical rule-#2 backbone every
 * node graph (console and dashboards) clips onto: `_command_interpreter` →
 * `_router`. The skeleton; the soft view-nodes hang off it. EVERYTHING sinks
 * into the interpreter, the interpreter sinks into the router, the router routes
 * by TO and stays bare (no sink, no target). Flow is steered by each node's
 * `target`, never by pointing a `sink` at an arbitrary node.
 *
 * THE CONSUMER CONTRACT IS ONE LINE: hand `mountExospine` a `build` callback that
 * registers your dashboard's nodes, keep the returned `teardown` for your effect
 * cleanup, and you're done. You get a working debug overlay — including a "Reset
 * Graph" that rebuilds your ENTIRE graph in place — for free. Nothing leaks into
 * your hook: no generation, no rebuild wiring, no reset plumbing.
 *
 *   useEffect( () => {
 *     const { teardown } = mountExospine( buildMyDashboard );
 *     return teardown;
 *   }, [] );
 *
 * Two rebuild granularities, both handled here so callers never touch them:
 *  - `reinit()` (also stashed on `Core.reinit`): tears down + rebuilds just the
 *    soft build nodes, keeping the backbone. The fine-grained rebuild.
 *  - A `Core.bumpGraphGeneration()` bump: the FULL rebuild — tears down EVERYTHING
 *    this exospine owns (backbone + build nodes) and reconstructs it. The overlay's
 *    "Reset Graph" removes every node then bumps, so the whole graph comes back
 *    fresh. mountExospine subscribes to that signal for you and unsubscribes on
 *    teardown; the build callback simply re-runs against the fresh backbone.
 *
 * mountExospine snapshots Core around `build` so a rebuild removes EXACTLY the
 * nodes build registered and rebuilds them — never a sibling's nodes (the debug
 * overlay mounts its own `_output`/`_metadata` into the same per-page Core, and
 * rebuilds them off the same generation signal). The build callback may return a
 * cleanup function (to undo non-node side effects — EventSource handles, slot
 * pokes — before its nodes are removed); it runs before every rebuild.
 *
 * One graph per admin page (`Core` is a per-page singleton), so the reserved
 * `_command_interpreter`/`_router` names never collide across dashboards. The
 * caller MUST pair every mount with `teardown()` (e.g. in a useEffect cleanup);
 * a second mount before teardown throws a name collision, by design.
 *
 * @param {Function} [build] `( spine ) => cleanup|void` — registers the soft
 *                           view-nodes onto the backbone. Re-run on every rebuild.
 * @return {{ interpreter: CommandInterpreterNode, router: RouterNode,
 *   reinit: Function, teardown: Function }} The backbone nodes, a `reinit()` that
 *   rebuilds the build-registered nodes, and a `teardown()` that additionally
 *   stops the router TIMER, removes the backbone, and unsubscribes the rebuild.
 */
import { Core } from './core';
import { RouterNode } from './router-node';
import { CommandInterpreterNode } from './command-interpreter-node';
import names from './reserved-node-names.json';

export function mountExospine( build ) {
	const spine = {};
	let router;
	let interpreter;

	// (Re)create the rule-#2 backbone. Mutable so the FULL rebuild can recreate it,
	// not just the soft build nodes — "Reset Graph" rebuilds everything.
	const mountBackbone = () => {
		// Idempotent under StrictMode's double-invoked useState initializer: if the
		// backbone is already registered, reuse it instead of colliding on the name.
		const existing = Core.node( names.COMMAND_INTERPRETER );
		if ( existing ) {
			interpreter = existing;
			router = Core.node( names.ROUTER );
			spine.interpreter = interpreter;
			spine.router = router;
			return;
		}

		router = new RouterNode();
		router.name = names.ROUTER;

		interpreter = new CommandInterpreterNode();
		interpreter.name = names.COMMAND_INTERPRETER;
		interpreter.sink = router;

		spine.interpreter = interpreter;
		spine.router = router;
	};

	// Snapshot Core around build so a rebuild/teardown removes only what build
	// registered — the overlay's own nodes (registered later into the same
	// per-page Core) must survive.
	let builtNames = [];
	let cleanup;
	const runBuild = () => {
		const before = new Set( Core.nodes.keys() );
		cleanup = 'function' === typeof build ? build( spine ) : undefined;
		builtNames = [ ...Core.nodes.keys() ].filter(
			( name ) => ! before.has( name )
		);
		// Publish the build-registered set so the debug overlay knows which names
		// belong to this dashboard (vs user-added nodes / its own infra).
		Core.reinitNames = builtNames;
	};
	const teardownBuilt = () => {
		if ( 'function' === typeof cleanup ) {
			cleanup();
		}
		cleanup = undefined;
		// Full removeNode (not a bare unregister) so each soft node clears its
		// own sink/target/registrations before the rebuild recreates it by name.
		for ( const name of builtNames ) {
			Core.node( name )?.removeNode();
		}
		builtNames = [];
	};
	const teardownBackbone = () => {
		router.stopTimer();
		// Clears interpreter.sink + any caller TIMER listeners, then unregisters
		// both names — the backbone leaves nothing dangling.
		interpreter.removeNode();
		router.removeNode();
	};

	// Fine-grained rebuild: just the soft build nodes, backbone preserved.
	spine.reinit = () => {
		teardownBuilt();
		runBuild();
	};

	// FULL rebuild: tear down EVERYTHING this exospine owns (backbone + build
	// nodes) and reconstruct it from scratch. Driven by Core.bumpGraphGeneration()
	// — the overlay's "Reset Graph" removes every node then bumps, and the build
	// callback re-runs against the fresh backbone. The consumer does nothing.
	const fullRebuild = () => {
		teardownBuilt();
		teardownBackbone();
		mountBackbone();
		runBuild();
	};

	let unsubscribe;
	spine.teardown = () => {
		if ( unsubscribe ) {
			unsubscribe();
		}
		teardownBuilt();
		teardownBackbone();
		Core.reinit = null;
		Core.reinitNames = null;
	};

	mountBackbone();
	runBuild();

	// Only a build-delegated graph exposes the rebuild handles + subscribes to the
	// full-rebuild signal. A bare mountExospine() — the console, or a dashboard
	// that builds its own nodes — leaves Core.reinit null (hiding the overlay
	// chip) and drives its own resetKey instead of the shared generation.
	if ( 'function' === typeof build ) {
		Core.reinit = spine.reinit;
		unsubscribe = Core.subscribeGraphGeneration( fullRebuild );
	}

	return spine;
}
