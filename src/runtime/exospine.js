/**
 * mountExospine — construct + register the canonical rule-#2 backbone every
 * node graph (console and dashboards) clips onto: `_command_interpreter` →
 * `_router`. The skeleton; the soft view-nodes hang off it. EVERYTHING sinks
 * into the CI, the CI sinks into the router, the router routes by TO and stays
 * bare (no sink, no target). Flow is steered by each node's `target`, never by
 * pointing a `sink` at an arbitrary node.
 *
 * One graph per admin page (`Core` is a per-page singleton), so the reserved
 * `_command_interpreter`/`_router` names never collide across dashboards. The
 * caller MUST pair every mount with `teardown()` (e.g. in a useEffect cleanup);
 * a second mount before teardown throws a name collision, by design.
 *
 * @return {{ ci: CommandInterpreter, router: Router, teardown: Function }} The
 *   backbone nodes plus a teardown() that stops the router TIMER and fully
 *   removes both (clearing the sink edge + any caller-registered TIMER
 *   listeners), then unregisters them from Core.
 */
import { Router } from './router';
import { CommandInterpreter } from './command_interpreter';
import names from './reserved-node-names.json';

export function mountExospine() {
	const router = new Router();
	router.setName( names.ROUTER );

	const ci = new CommandInterpreter();
	ci.setName( names.COMMAND_INTERPRETER );
	ci.sink = router;

	return {
		ci,
		router,
		teardown() {
			router.stopTimer();
			// Full removeNode (not a bare unregister): clears ci.sink and any
			// TIMER listeners a caller clipped onto the router, then unregisters
			// each name — so the backbone leaves nothing dangling.
			ci.removeNode();
			router.removeNode();
		},
	};
}
