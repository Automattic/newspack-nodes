/** @typedef {import('../../runtime/node').NodeClass} NodeClass */
/** @typedef {import('../../runtime/tee-node').TeeNode} TeeNode */

/**
 * The transform node a slice inserts between its receiver Tee and its view.
 *
 * @typedef {Object} SliceTransform
 * @property {string}           name          Node name to register it under.
 * @property {string|NodeClass} nodeClass     Its class, or its registered name (ADR-16).
 * @property {string[]}         [args]        Constructor argument tokens.
 * @property {string}           [controlFrom] Its own control origin, for a transform its dashboard drives directly.
 */

/**
 * addSliceFetcher — wire ONE dashboard slice in one call.
 *
 *   tee ─> <fetcher> (Fetcher) ─> <target>            the tick fans out to it
 *   <receiver> (Tee) ─> [<transform> ─>] <view>       the reply routes back here
 *                    ─> <fetcher>                     …and settles the ask
 *
 * A Fetcher emits its ONE configured command (`<receiver> <command>`) toward
 * `target` (`_shell/_http/<ci>`); the server CI replies `TO = FROM = receiver`,
 * so the reply lands on the receiver `Tee`, which fans it to the view node — an
 * independent reply path per slice, nothing crossing and nothing to correlate
 * (ADR-7). The optional `transform` slot drops a Hook/Callback/Counter node onto
 * the receiver-Tee → view edge so a per-slice merge/dedup lands on a graph edge,
 * not inside the view.
 *
 * The receiver fans the reply back to the Fetcher too, which is what settles the
 * ask so the next tick may make a new one — the view cannot do it, because a
 * transform that drops an unchanged reply means the view never hears about it.
 * The Fetcher goes LAST, after the view: a consumer that acts once per ANSWER
 * asks `isAsking()` as the reply renders, and a settled ask is gone by then. A
 * Tee fans out in CONNECT order, and that order is contractual — which is what
 * makes LAST mean last.
 *
 * A receiver that ALSO takes out-of-band sends — a dashboard minting straight
 * from it rather than through the Fetcher — sees those replies settle whatever
 * the Fetcher had outstanding, since a pathless ask matches any pathless reply.
 * That costs one extra command in flight and levels out on the next tick; give
 * such a send its own receiver if one ask at a time has to be exact.
 *
 * Pair it with `useBatchedPoll`, whose `build` calls this once per slice and
 * which owns the `_shell`/`_http`/Timer/lock-flush boilerplate.
 *
 * @param {Object}           interpreter         The mounted CommandInterpreter node.
 * @param {Object}           slice
 * @param {string}           slice.fetcher       Fetcher node name (e.g. `fetch-counts`).
 * @param {string}           slice.receiver      Receiver Tee name; the reply routes back here (Fetcher FROM).
 * @param {string}           slice.command       The verb the Fetcher sends.
 * @param {string}           slice.view          View node name.
 * @param {string|NodeClass} slice.viewClass     The view node's class, or its registered name. Hand the CLASS when you have it: the name map is a per-bundle static, so a hub tab building its graph through another bundle's interpreter cannot resolve a name its own bundle registered (ADR-16).
 * @param {TeeNode}          slice.tee           The fan-out Tee node the tick fans through.
 * @param {string}           slice.target        Egress path the Fetcher targets (`_shell/_http/<ci>`).
 * @param {string}           [slice.controlFrom] Control origin for a view that takes local controls: the FROM its dashboard mints under. Omitted for the majority, whose view class owns no control path — stamping every view plants an inert field on them, and the wrong name on any view whose controls come from its transform rather than itself.
 * @param {SliceTransform}   [slice.transform]   Node inserted on the receiver-Tee → view edge.
 * @param {() => ?string[]}  [slice.argsFn]      Fire-time getter assigned to the Fetcher's `command_args`, so each tick emits live, UI-state-driven args (filter / sort / page) without re-wiring the graph. A null return sends nothing that tick.
 * @return {string} The receiver Tee name.
 */
export function addSliceFetcher(
	interpreter,
	{
		fetcher,
		receiver,
		command,
		view,
		viewClass,
		controlFrom,
		tee,
		target,
		transform,
		argsFn,
	}
) {
	// Fetcher: turns the tick into ONE command (FROM=receiver) at the egress.
	const f = interpreter.makeNode( 'Fetcher', fetcher, [ receiver, command ] );
	// A getter makes the Fetcher emit live args each tick, else static (empty).
	if ( argsFn ) {
		f.command_args = argsFn;
	}
	f.connectNode( target );
	tee.connectNode( fetcher );

	// Receiver Tee: reply routes back here, then fans to view (or transform).
	const recv = interpreter.makeNode( 'Tee', receiver );
	if ( transform ) {
		const t = interpreter.makeNode(
			transform.nodeClass,
			transform.name,
			transform.args || []
		);
		t.connectNode( view );
		if ( undefined !== transform.controlFrom ) {
			t.controlFrom = transform.controlFrom;
		}
	}
	// The Fetcher goes LAST: the ask must still stand while the reply renders.
	for ( const next of [ transform?.name ?? view, fetcher ] ) {
		recv.connectNode( next );
	}
	const v = interpreter.makeNode( viewClass, view );
	if ( undefined !== controlFrom ) {
		v.controlFrom = controlFrom;
	}

	return receiver;
}
