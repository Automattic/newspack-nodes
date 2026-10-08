/**
 * Exospine — the backbone every browser node graph clips onto, and the single
 * call a dashboard makes to get one.
 *
 * `_command_interpreter` sinks into `_router`, everything else sinks into the
 * interpreter, and the router dispatches by TO while staying bare: no sink, no
 * target. Flow is steered by each node's `target`, never by pointing a `sink`
 * at an arbitrary node (ADR-7). The backbone is the skeleton a page keeps; a
 * dashboard's soft view-nodes hang off it and come and go with a rebuild.
 */

import { ensureSession } from './command-auth';
import { Core } from './core';
import { RouterNode } from './router-node';
import { CommandInterpreterNode } from './command-interpreter-node';
import { TapNode } from './tap-node';
import { CallbackNode } from './callback-node';
import { HttpOutNode } from './http-out-node';
import { NullNode } from './null-node';
import { targetsOf } from './node';
import { HeartbeatNode } from './heartbeat-node';
import { RemoteLinkNode } from './remote-link-node';
import names from './reserved-node-names.json';
import { TO, TYPE, TM_ERROR } from './message';

/** What opens a group Tap's name, and a target path addressed to one. */
const SHELL_GROUP_PREFIX = 'shell:';

/**
 * The name of a dashboard group's Tap: `shell:<group>`.
 *
 * Every command a dashboard sends passes the Tap of the group it belongs to,
 * so `connect shell:<group>` watches that group's traffic alone. The name has
 * no underscore, because the Tap is a dashboard's own node rather than a
 * backbone fixture: it comes and goes with the mounts whose nodes target it.
 *
 * @param {string} group The group, such as `url`.
 * @return {string} The Tap's node name.
 * @throws {TypeError} When the group is missing or no string.
 */
export function shellGroup( group ) {
	if ( 'string' !== typeof group || '' === group ) {
		throw new TypeError(
			`a shell group is a non-empty string, not ${ JSON.stringify(
				group
			) }`
		);
	}
	return `${ SHELL_GROUP_PREFIX }${ group }`;
}

/**
 * The groups the given nodes' targets route through: the head of every
 * target path that names a group Tap.
 *
 * @param {Array<?Object>} nodes Nodes, any of them gone.
 * @return {Set<string>} The groups, without the `shell:` prefix.
 */
function groupsTargetedBy( nodes ) {
	const groups = new Set();
	for ( const node of nodes ) {
		for ( const path of targetsOf( node ) ) {
			const head = path.split( '/' )[ 0 ];
			if ( head.startsWith( SHELL_GROUP_PREFIX ) ) {
				groups.add( head.slice( SHELL_GROUP_PREFIX.length ) );
			}
		}
	}
	return groups;
}

/**
 * What a mount hands back: the six backbone nodes it points at, plus the two
 * lifecycle handles its caller drives.
 *
 * @typedef  {Object}                 Exospine
 * @property {CommandInterpreterNode} interpreter `_command_interpreter`, the sink everything reaches.
 * @property {RouterNode}             router      `_router`, dispatching by TO on its own TIMER.
 * @property {TapNode}                shell       `_shell`, the observe-only Tap an interactive session's commands pass.
 * @property {HttpOutNode}            http        `_http`, the batched `/command` egress.
 * @property {HeartbeatNode}          heartbeat   `_heartbeat`, the SSE-slot poke.
 * @property {RemoteLinkNode}         stream      `_stream`, the page's one SSE link.
 * @property {() => void}             reinit      Rebuilds the build nodes, keeping the backbone.
 * @property {() => void}             teardown    Undoes this mount; the caller MUST call it.
 */

/**
 * A dashboard's own wiring: it registers the soft view-nodes onto the backbone
 * it is handed, and returns a cleanup for whatever it started that is not a
 * node — an EventSource handle, a slot poke — or nothing.
 *
 * @typedef {( spine: Exospine ) => ( () => void )|void} ExospineBuild
 */

/**
 * Relay one reply a UI button asked for.
 *
 * A button's command names `_ui/<receiver>` as its FROM, so the Router hands
 * the reply here with TO peeled to `<receiver>`. `_output` gets a copy only
 * while `debug_ui` is on, which is what keeps button traffic out of the
 * transcript by default. The reply then goes on down the remainder; a bare
 * `_ui`, the address of a button that reads no reply, ends it here. An error
 * ending here prints whatever `debug_ui` says, since no receiver can show it.
 *
 * @param {CallbackNode} ui      The `_ui` node, whose sink is the interpreter.
 * @param {Array}        message The reply, TO already peeled by the Router.
 */
function uiRelay( ui, message ) {
	const unanswered = '' === message[ TO ] && message[ TYPE ] & TM_ERROR;
	if ( unanswered || Core.node( names.OUTPUT )?.debugUi ) {
		const copy = message.slice();
		copy[ TO ] = names.OUTPUT;
		ui.sink.fill( copy );
	}
	if ( '' !== message[ TO ] ) {
		ui.sink.fill( message );
	}
}

/**
 * Construct and register the backbone, then run `build` against it.
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
 *  - `reinit()` tears down and rebuilds the soft build nodes alone, keeping the
 *    backbone. The fine-grained rebuild, and what a mount REUSING someone else's
 *    backbone runs off both the graphGeneration and the backbone-up signal.
 *  - A `Core.bumpGraphGeneration()` bump is the FULL rebuild: the owning mount
 *    tears down EVERYTHING it owns (backbone and build nodes) and reconstructs
 *    it. The overlay's "Reset Graph" removes every node then bumps, so the whole
 *    graph comes back fresh. mountExospine subscribes to that signal for you and
 *    unsubscribes on teardown; the build callback re-runs against the fresh
 *    backbone.
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
 * Every node `build` registers whose target opens `shell:<group>/` claims that
 * group's Tap for this mount, so a slice targeting `egressPath( group, ci )`
 * needs no other declaration. A Tap stands while any mount claims its group,
 * and the last claim released removes it.
 *
 * The backbone stands while any mount does. The first non-passenger mount
 * owns it and answers a Reset Graph with the full rebuild; when it leaves
 * while others stay, ownership passes to the next non-passenger mount in
 * `Core.backboneMounts`.
 *
 * @param {ExospineBuild} [build]          Wires this dashboard's nodes onto
 *                                         the backbone. Re-run on every
 *                                         rebuild.
 * @param {Object}        [opts]           Mount options.
 * @param {boolean}       [opts.passenger] True to clip onto the backbone
 *                                         without owning it — see
 *                                         `ownsBackbone` below.
 * @return {Exospine} The six backbone nodes `syncSpineFromCore` assigns, a
 *   `reinit()` that rebuilds the build-registered nodes, and a `teardown()` that
 *   additionally removes the backbone — every node but the kept Router — when
 *   this mount is the last out, and unsubscribes the rebuild.
 */
export function mountExospine( build, { passenger = false } = {} ) {
	// Core reads the owner off these records; claimGroups reads the claims.
	const mount = {
		passenger,
		rebuilds: 'function' === typeof build,
		claimed: new Set(),
	};
	Core.backboneMounts.push( mount );
	// Signing reads the session synchronously; start the fetch at mount.
	void ensureSession();

	// Built empty; mountBackbone fills the node fields, the body the handles.
	const spine = /** @type {Exospine} */ ( {} );
	let router;
	let interpreter;

	/**
	 * Point the spine's six backbone fields at the nodes Core holds now.
	 *
	 * Runs again before every build, because a mount reusing a backbone
	 * another mount later replaced would otherwise hand `build` dead nodes.
	 */
	const syncSpineFromCore = () => {
		spine.interpreter = Core.node( names.COMMAND_INTERPRETER );
		spine.router = Core.node( names.ROUTER );
		spine.shell = Core.node( names.CONSOLE_TAP );
		spine.http = Core.node( names.HTTP );
		spine.heartbeat = Core.node( names.HEARTBEAT );
		spine.stream = Core.node( names.STREAM );
	};
	/**
	 * Whether THIS mount owns the backbone, and so runs its full rebuild.
	 *
	 * A PASSENGER never owns: it may bring the backbone up so its node has
	 * something to clip onto, but the graph's real owner (the console) adopts
	 * it on arrival and remains the one that can replace it. Every other mount
	 * re-attaches on backbone-up, which is what that signal exists for.
	 *
	 * @return {boolean} Whether `Core.backboneOwner` is this mount.
	 */
	const ownsBackbone = () => Core.backboneOwner === mount;

	/**
	 * The page's ONE Router, constructed on the first mount and kept from then
	 * on (see `teardownBackbone`).
	 *
	 * A kept Router comes back AS IS, never re-armed, because a stopped Router
	 * is usually stopped on purpose: the console stops it while the tab is
	 * hidden and re-arms it on the way back. Arming here would restart the
	 * heartbeat behind that gate every time anything mounted a passenger
	 * backbone.
	 *
	 * @return {RouterNode} The page's Router, kept or freshly named.
	 */
	const ensureRouter = () => {
		const kept = Core.node( names.ROUTER );
		if ( kept ) {
			return kept;
		}
		const fresh = new RouterNode();
		fresh.name = names.ROUTER;
		return fresh;
	};

	/**
	 * Create the backbone, or adopt the one already standing.
	 *
	 * A FULL rebuild runs it again, so every node here is disposable — bar the
	 * Router, which `ensureRouter` carries across.
	 */
	const mountBackbone = () => {
		// Idempotent under StrictMode double-invoke: reuse existing backbone.
		const existing = Core.node( names.COMMAND_INTERPRETER );
		if ( existing ) {
			interpreter = existing;
			router = ensureRouter();
			syncSpineFromCore();
			return;
		}
		router = ensureRouter();

		interpreter = new CommandInterpreterNode();
		interpreter.name = names.COMMAND_INTERPRETER;
		interpreter.sink = router;

		// `_shell` — the interactive session's observe-only Tap.
		const shell = new TapNode();
		shell.name = names.CONSOLE_TAP;
		shell.sink = interpreter;

		// `_ui` — UI buttons' replies return through it; see `uiRelay`.
		const ui = new CallbackNode( ( message ) => uiRelay( ui, message ) );
		ui.name = names.UI;
		ui.sink = interpreter;

		// `_null` — the black hole `_http` aims at with no console open.
		const nul = new NullNode();
		nul.name = names.NULL;
		// Rule #2: a terminal sinks too, even never reading it.
		nul.sink = interpreter;

		// `_http` + `_heartbeat` — shared backbone singletons, reused widely.
		const http = new HttpOutNode();
		http.name = names.HTTP;
		http.sink = interpreter;
		// Unaddressed reply-leg output (a server `log` line) lands here.
		http.target = names.NULL;

		const heartbeat = new HeartbeatNode();
		heartbeat.name = names.HEARTBEAT;
		heartbeat.sink = interpreter;
		// The poke's destination is fixed wiring: `_http/workers`.
		heartbeat.target = `${ names.HTTP }/workers`;

		// `_stream` — the page's one SSE link; stream graphs attach to it.
		const stream = new RemoteLinkNode();
		stream.name = names.STREAM;
		stream.sink = interpreter;

		spine.interpreter = interpreter;
		spine.router = router;
		spine.shell = shell;
		spine.http = http;
		spine.heartbeat = heartbeat;
		spine.stream = stream;

		// A bare mount never bumps graphGeneration; passengers need this.
		Core.notifyBackboneUp();
	};

	/**
	 * Record `groups` as this mount's claim, remove the Tap of every group no
	 * mount claims any longer, and stand every claimed Tap on the live
	 * interpreter.
	 *
	 * A Tap another mount raised is shared, and re-pointed rather than
	 * rebuilt, because a backbone replaced since left it sinking into a
	 * removed interpreter.
	 *
	 * @param {Set<string>} groups The groups this mount claims from now on.
	 */
	const claimGroups = ( groups ) => {
		const released = [ ...mount.claimed ].filter(
			( group ) => ! groups.has( group )
		);
		mount.claimed = groups;
		for ( const group of released ) {
			if (
				! Core.backboneMounts.some( ( other ) =>
					other.claimed.has( group )
				)
			) {
				Core.node( shellGroup( group ) )?.removeNode();
			}
		}
		for ( const group of groups ) {
			const name = shellGroup( group );
			let tap = Core.node( name );
			if ( ! tap ) {
				tap = new TapNode();
				tap.name = name;
			}
			tap.sink = spine.interpreter;
		}
	};

	/** Names `build` registered, the exact set a rebuild removes. */
	let builtNames = [];
	/** The optional cleanup `build` returned, run before every rebuild. */
	let cleanup;
	/**
	 * Run `build` against the live backbone, recording what it registers.
	 *
	 * The before/after snapshot of Core is what keeps a rebuild off a
	 * sibling's nodes: only names that appeared during the call are ours.
	 */
	const runBuild = () => {
		// A reusing mount's spine may be stale — re-point at live nodes first.
		syncSpineFromCore();
		// Nothing to clip onto yet; backbone-up brings this build back.
		if ( ! spine.interpreter ) {
			builtNames = [];
			return;
		}
		const before = new Set( Core.nodes.keys() );
		cleanup = 'function' === typeof build ? build( spine ) : undefined;
		builtNames = [ ...Core.nodes.keys() ].filter(
			( name ) => ! before.has( name )
		);
		// After the snapshot, so a Tap is no node of this build's own.
		claimGroups(
			groupsTargetedBy( builtNames.map( ( name ) => Core.node( name ) ) )
		);
	};
	/** Run the build cleanup, then remove every node `build` registered. */
	const teardownBuilt = () => {
		if ( 'function' === typeof cleanup ) {
			cleanup();
		}
		cleanup = undefined;
		// Full removeNode (not unregister) so each node clears its refs.
		for ( const name of builtNames ) {
			Core.node( name )?.removeNode();
		}
		builtNames = [];
	};
	/**
	 * Tear the backbone down — everything but the ROUTER, which is never
	 * removed.
	 *
	 * It is the page's one heartbeat: every poller hitchhikes its TIMER and
	 * every command batches inside the lock/flush bracket its tick opens. A
	 * Reset-Graph that replaced it would stop the clock the whole graph runs
	 * on, so nothing could depend on the tick, and every loop that must survive
	 * a rebuild would fall back to a private setInterval — exactly the
	 * unbatched second heartbeat the graph exists not to have.
	 *
	 * A node the rebuild removes unregisters itself (TimerNode.removeNode →
	 * stopTimer), so no stale TIMER registration outlives its node.
	 */
	const teardownBackbone = () => {
		Core.node( names.CONSOLE_TAP )?.removeNode();
		Core.node( names.UI )?.removeNode();
		// Before `_http` and `_heartbeat`: its close() reaches both.
		Core.node( names.STREAM )?.removeNode();
		Core.node( names.HTTP )?.removeNode();
		Core.node( names.NULL )?.removeNode();
		Core.node( names.HEARTBEAT )?.removeNode();
		Core.node( names.COMMAND_INTERPRETER )?.removeNode();
	};

	/** Fine-grained rebuild: the soft build nodes, backbone preserved. */
	spine.reinit = () => {
		teardownBuilt();
		runBuild();
	};

	/** FULL rebuild: tear the backbone and build nodes down, then remount. */
	const fullRebuild = () => {
		teardownBuilt();
		teardownBackbone();
		mountBackbone();
		runBuild();
	};

	/** Drops this mount's rebuild subscriptions; unset on a bare mount. */
	let unsubscribe;
	/**
	 * Undo this mount: subscriptions and build nodes, then the backbone when
	 * it is the last mount out.
	 *
	 * An owner leaving while other mounts stay hands ownership, and with it
	 * the Reset Graph rebuild, to the next non-passenger mount; the backbone
	 * stays up for them. The last mount out tears it down, as nobody else
	 * would, and the Router self-arms a 1s timer the moment it is
	 * constructed.
	 *
	 * The caller pairs it with the mount (a useEffect cleanup), because the
	 * reserved names stay taken until it runs.
	 */
	spine.teardown = () => {
		if ( unsubscribe ) {
			unsubscribe();
		}
		teardownBuilt();
		claimGroups( new Set() );
		Core.backboneMounts = Core.backboneMounts.filter(
			( other ) => other !== mount
		);
		if ( 0 === Core.backboneMounts.length ) {
			teardownBackbone();
		}
	};

	mountBackbone();
	runBuild();

	// Only a build-delegated mount has nodes a rebuild signal could rebuild.
	if ( mount.rebuilds ) {
		if ( ownsBackbone() ) {
			// Pre-subscribe bump: an open overlay rebuilds its poll.
			Core.bumpGraphGeneration();
		}
		// Ownership can arrive later, handed on by an owner that left.
		const offGeneration = Core.subscribeGraphGeneration( () =>
			ownsBackbone() ? fullRebuild() : spine.reinit()
		);
		// A replaced backbone leaves a non-owner sinking into a removed node.
		const offBackbone = Core.subscribeBackboneUp( () => {
			if ( ! ownsBackbone() ) {
				spine.reinit();
			}
		} );
		unsubscribe = () => {
			offGeneration();
			offBackbone();
		};
	}

	return spine;
}
