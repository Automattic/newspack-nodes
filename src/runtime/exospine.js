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
import { TapNode } from './tap-node';
import { HttpOutNode } from './http-out-node';
import { HeartbeatNode } from './heartbeat-node';
import names from './reserved-node-names.json';

export function mountExospine( build ) {
	const spine = {};
	let router;
	let interpreter;
	// Whether THIS mount created the backbone. A second build-mount on the same
	// page (e.g. the Overview runs useTopologyManager AND useTopicProbeStream)
	// REUSES the existing backbone — it must not own it: no generation bump (which
	// would full-rebuild and tear the shared backbone out from under the first
	// mount's nodes) and no backbone teardown.
	let ownsBackbone = false;

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
			spine.shell = Core.node( names.CONSOLE_TAP );
			spine.http = Core.node( names.HTTP );
			spine.heartbeat = Core.node( names.HEARTBEAT );
			return;
		}
		ownsBackbone = true;

		router = new RouterNode();
		router.name = names.ROUTER;

		interpreter = new CommandInterpreterNode();
		interpreter.name = names.COMMAND_INTERPRETER;
		interpreter.sink = router;

		// `_shell` — a permanent observe-only Tap every command path routes
		// through: a constructed Shell sinks into it, and the dashboards' periodic
		// poll commands do too. Always present so `connect _shell` watches all
		// outbound commands, with or without a REPL. It forwards its sink → the
		// interpreter.
		const shell = new TapNode();
		shell.name = names.CONSOLE_TAP;
		shell.sink = interpreter;

		// `_http` (egress POST boundary) + `_heartbeat` (SSE slot keepalive) —
		// shared singletons every RemoteLink/dashboard reuses. Backbone-owned (like
		// `_shell`) so they survive a Reset Graph rebuild and are always laid out;
		// callers set `_http.client`, RemoteLink arms the heartbeat's timer + slot on
		// connect. Dormant until a stream opens (fire() no-ops without a slot).
		const http = new HttpOutNode();
		http.name = names.HTTP;
		http.sink = interpreter;

		const heartbeat = new HeartbeatNode();
		heartbeat.name = names.HEARTBEAT;
		heartbeat.sink = interpreter;
		// The poke target is fixed wiring (`_http/workers`) — set it here, not on
		// connect, so the `_heartbeat → _http/workers` edge is permanent and survives
		// a Reset Graph rebuild even at `/` where no RemoteLink connects.
		heartbeat.target = `${ names.HTTP }/workers`;

		spine.interpreter = interpreter;
		spine.router = router;
		spine.shell = shell;
		spine.http = http;
		spine.heartbeat = heartbeat;
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
		// belong to a dashboard (vs user-added nodes). UNION across mounts — several
		// build-delegated dashboards co-mount on one page (the hub overview), so the
		// Reset Graph chip must recognize EVERY build's infra, not just the last
		// mount's (teardownBuilt drops a mount's names again).
		Core.reinitNames = [
			...new Set( [ ...( Core.reinitNames || [] ), ...builtNames ] ),
		];
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
		// Drop only THIS mount's names from the shared set — co-mounted dashboards
		// keep theirs (the inverse of runBuild's union).
		const gone = new Set( builtNames );
		Core.reinitNames = ( Core.reinitNames || [] ).filter(
			( name ) => ! gone.has( name )
		);
		builtNames = [];
	};
	const teardownBackbone = () => {
		router.stopTimer();
		// Remove the leaf singletons (they sink into the interpreter), then clear
		// the interpreter (sink + caller TIMER listeners) and router — the backbone
		// leaves nothing dangling.
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
		// Only the owner tears the shared backbone down (and owns Core.reinit).
		if ( ownsBackbone ) {
			teardownBackbone();
			Core.reinit = null;
			Core.reinitNames = null;
		}
	};

	mountBackbone();
	runBuild();

	// Only a build-delegated graph exposes the rebuild handles + subscribes to the
	// full-rebuild signal. A bare mountExospine() — the console, or a dashboard
	// that builds its own nodes — leaves Core.reinit null (hiding the overlay
	// chip) and drives its own resetKey instead of the shared generation.
	if ( 'function' === typeof build ) {
		if ( ownsBackbone ) {
			Core.reinit = spine.reinit;
			// Pre-subscribe bump: an open overlay rebuilds its poll on the new backbone.
			Core.bumpGraphGeneration();
			unsubscribe = Core.subscribeGraphGeneration( fullRebuild );
		} else {
			// Reused backbone — the owner manages full rebuilds. Don't bump (it
			// would tear the shared backbone out from under us). Just rebuild OUR
			// build nodes when the generation bumps: the owner's fullRebuild (it
			// subscribed first) recreates the backbone, then our reinit re-runs our
			// build against it.
			unsubscribe = Core.subscribeGraphGeneration( spine.reinit );
		}
	}

	return spine;
}
