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
 *  - `reinit()` (the returned handle; also fired on this mount's graphGeneration
 *    subscription when it reuses a backbone): tears down + rebuilds just the soft
 *    build nodes, keeping the backbone. The fine-grained rebuild.
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
 * @param {Function} [build]          `( spine ) => cleanup|void` — registers the soft
 *                                    view-nodes onto the backbone. Re-run on every rebuild.
 * @param {Object}   [opts]
 * @param {boolean}  [opts.passenger] True to clip onto the backbone without
 *                                    owning it — see `ownsBackbone` below.
 * @return {{ interpreter: CommandInterpreterNode, router: RouterNode,
 *   reinit: Function, teardown: Function }} The backbone nodes, a `reinit()` that
 *   rebuilds the build-registered nodes, and a `teardown()` that additionally
 *   stops the router TIMER, removes the backbone, and unsubscribes the rebuild.
 */
import { ensureSession } from './command-auth';
import { Core } from './core';
import { RouterNode } from './router-node';
import { CommandInterpreterNode } from './command-interpreter-node';
import { TapNode } from './tap-node';
import { HttpOutNode } from './http-out-node';
import { HeartbeatNode } from './heartbeat-node';
import names from './reserved-node-names.json';

export function mountExospine( build, { passenger = false } = {} ) {
	// Signing is sync and reads this; start the round trip before any command.
	void ensureSession();

	const spine = {};
	let router;
	let interpreter;

	// Point the spine's backbone refs at live Core nodes; re-run before build.
	const syncSpineFromCore = () => {
		spine.interpreter = Core.node( names.COMMAND_INTERPRETER );
		spine.router = Core.node( names.ROUTER );
		spine.shell = Core.node( names.CONSOLE_TAP );
		spine.http = Core.node( names.HTTP );
		spine.heartbeat = Core.node( names.HEARTBEAT );
	};
	// @longform
	// Whether THIS mount owns the backbone — i.e. tears it down on teardown.
	// A PASSENGER never owns: it may bring the backbone up so its node has
	// something to clip onto, but the graph's real owner (the console) adopts
	// it on arrival and remains the one that can replace it. Passengers
	// re-attach on backbone-up, which is what that signal exists for.
	let ownsBackbone = false;

	// (Re)create the rule-#2 backbone; mutable so a FULL rebuild recreates it.
	const mountBackbone = () => {
		// Idempotent under StrictMode double-invoke: reuse existing backbone.
		const existing = Core.node( names.COMMAND_INTERPRETER );
		if ( existing ) {
			interpreter = existing;
			router = Core.node( names.ROUTER );
			// Adopt a backbone a passenger raised; it has no owner yet.
			if ( ! passenger && ! Core.backboneOwned ) {
				ownsBackbone = true;
				Core.backboneOwned = true;
			}
			syncSpineFromCore();
			return;
		}
		ownsBackbone = ! passenger;
		Core.backboneOwned = Core.backboneOwned || ownsBackbone;

		router = new RouterNode();
		router.name = names.ROUTER;

		interpreter = new CommandInterpreterNode();
		interpreter.name = names.COMMAND_INTERPRETER;
		interpreter.sink = router;

		// `_shell` — permanent observe-only Tap all commands route through.
		const shell = new TapNode();
		shell.name = names.CONSOLE_TAP;
		shell.sink = interpreter;

		// `_http` + `_heartbeat` — shared backbone singletons, reused widely.
		const http = new HttpOutNode();
		http.name = names.HTTP;
		http.sink = interpreter;
		// Unaddressed reply-leg output (a server `log` line) lands here.
		http.target = names.OUTPUT;

		const heartbeat = new HeartbeatNode();
		heartbeat.name = names.HEARTBEAT;
		heartbeat.sink = interpreter;
		// Poke target is fixed wiring (`_http/workers`); set here.
		heartbeat.target = `${ names.HTTP }/workers`;

		spine.interpreter = interpreter;
		spine.router = router;
		spine.shell = shell;
		spine.http = http;
		spine.heartbeat = heartbeat;

		// A bare mount never bumps graphGeneration; passengers need this.
		Core.notifyBackboneUp();
	};

	// Snapshot Core around build so rebuild removes only what build added.
	let builtNames = [];
	let cleanup;
	const runBuild = () => {
		// A reusing mount's spine may be stale — re-point at live nodes first.
		syncSpineFromCore();
		const before = new Set( Core.nodes.keys() );
		cleanup = 'function' === typeof build ? build( spine ) : undefined;
		builtNames = [ ...Core.nodes.keys() ].filter(
			( name ) => ! before.has( name )
		);
		// Publish the build-registered set (UNION across mounts) for overlay.
		Core.reinitNames = [
			...new Set( [ ...( Core.reinitNames || [] ), ...builtNames ] ),
		];
	};
	const teardownBuilt = () => {
		if ( 'function' === typeof cleanup ) {
			cleanup();
		}
		cleanup = undefined;
		// Full removeNode (not unregister) so each node clears its refs.
		for ( const name of builtNames ) {
			Core.node( name )?.removeNode();
		}
		// Drop only THIS mount's names (inverse of runBuild's union).
		const gone = new Set( builtNames );
		Core.reinitNames = ( Core.reinitNames || [] ).filter(
			( name ) => ! gone.has( name )
		);
		builtNames = [];
	};
	const teardownBackbone = () => {
		router.stopTimer();
		// Remove leaf singletons, then interpreter + router — nothing dangles.
		Core.node( names.CONSOLE_TAP )?.removeNode();
		Core.node( names.HTTP )?.removeNode();
		Core.node( names.HEARTBEAT )?.removeNode();
		interpreter.removeNode();
		router.removeNode();
	};

	// Fine-grained rebuild: just the soft build nodes, backbone preserved.
	spine.reinit = () => {
		teardownBuilt();
		runBuild();
	};

	// FULL rebuild: tear down EVERYTHING (backbone + build nodes), rebuild.
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
		// Only the owning mount tears the backbone down.
		if ( ownsBackbone ) {
			teardownBackbone();
			Core.backboneOwned = false;
			Core.rebuildable = false;
			Core.reinitNames = null;
		}
	};

	mountBackbone();
	runBuild();

	// Only a build-delegated graph exposes rebuild handles + rebuild sub.
	if ( 'function' === typeof build ) {
		if ( ownsBackbone ) {
			// Overlay Reset-Graph capability (owner build-delegated graph).
			Core.rebuildable = true;
			// Pre-subscribe bump: an open overlay rebuilds its poll.
			Core.bumpGraphGeneration();
			unsubscribe = Core.subscribeGraphGeneration( fullRebuild );
		} else {
			// Reused backbone — owner owns full rebuilds; just reinit ours.
			unsubscribe = Core.subscribeGraphGeneration( spine.reinit );
		}
	}

	return spine;
}
