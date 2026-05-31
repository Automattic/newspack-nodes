/**
 * mountExospine — construct + register the canonical rule-#2 backbone every
 * node graph (console and dashboards) clips onto: `_command_interpreter` →
 * `_router`. The skeleton; the soft view-nodes hang off it. EVERYTHING sinks
 * into the interpreter, the interpreter sinks into the router, the router routes
 * by TO and stays bare (no sink, no target). Flow is steered by each node's
 * `target`, never by pointing a `sink` at an arbitrary node.
 *
 * Pass a `build( spine )` callback to register those soft view-nodes; it may
 * return a cleanup function (to undo non-node side effects — EventSource
 * handles, slot pokes — before the nodes are removed). mountExospine snapshots
 * Core around `build` so `reinit()` removes EXACTLY the nodes build registered
 * and rebuilds them — never a sibling's nodes (the debug overlay mounts its own
 * `_output`/`_metadata` into the same per-page Core). `reinit()` is what "Reset
 * Graph" calls: it restores the default wiring an in-canvas edit broke, leaving
 * the backbone (and any sibling-registered nodes) intact.
 *
 * One graph per admin page (`Core` is a per-page singleton), so the reserved
 * `_command_interpreter`/`_router` names never collide across dashboards. The
 * caller MUST pair every mount with `teardown()` (e.g. in a useEffect cleanup);
 * a second mount before teardown throws a name collision, by design.
 *
 * mountExospine also stashes its `reinit` on `Core.reinit` and the set of names
 * build registered on `Core.reinitNames` (both cleared on teardown) so a sibling
 * like the debug overlay can drive Reset Graph without any page threading a prop.
 *
 * @param {Function} [build] `( spine ) => cleanup|void` — registers the soft
 *                           view-nodes onto the backbone. Re-run on every `reinit()`.
 * @return {{ interpreter: CommandInterpreterNode, router: RouterNode,
 *   reinit: Function, teardown: Function }} The backbone nodes, a `reinit()`
 *   that tears down + rebuilds the build-registered nodes, and a `teardown()`
 *   that additionally stops the router TIMER and removes the backbone.
 */
import { Core } from './core';
import { RouterNode } from './router-node';
import { CommandInterpreterNode } from './command-interpreter-node';
import names from './reserved-node-names.json';

export function mountExospine( build ) {
	const router = new RouterNode();
	router.setName( names.ROUTER );

	const interpreter = new CommandInterpreterNode();
	interpreter.setName( names.COMMAND_INTERPRETER );
	interpreter.sink = router;

	const spine = { interpreter, router };

	// Snapshot Core around build so reinit/teardown remove only what build
	// registered — the overlay's own nodes (registered later into the same
	// per-page Core) must survive a host reinit.
	let builtNames = [];
	let cleanup;
	const runBuild = () => {
		const before = new Set( Core.nodes.keys() );
		cleanup = 'function' === typeof build ? build( spine ) : undefined;
		builtNames = [ ...Core.nodes.keys() ].filter(
			( name ) => ! before.has( name )
		);
		// Publish the reinit-managed set so the debug overlay's Reset Graph can
		// keep these (and the reserved backbone/infra) while dropping user nodes.
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

	spine.reinit = () => {
		teardownBuilt();
		runBuild();
	};
	spine.teardown = () => {
		teardownBuilt();
		router.stopTimer();
		// Clears interpreter.sink + any caller TIMER listeners, then unregisters
		// both names — the backbone leaves nothing dangling.
		interpreter.removeNode();
		router.removeNode();
		Core.reinit = null;
		Core.reinitNames = null;
	};

	runBuild();

	// Only expose Reset Graph (via the overlay's Core.reinit read) when this
	// graph delegated its node construction to `build`, so reinit() can rebuild
	// it. A bare mountExospine() — the console, or a dashboard that builds its
	// own nodes — leaves Core.reinit null, hiding the overlay chip instead of
	// offering a destructive no-op rebuild.
	if ( 'function' === typeof build ) {
		Core.reinit = spine.reinit;
	}

	return spine;
}
