/**
 * addSliceFetcher — wire ONE dashboard slice in one call.
 *
 *   tee ─> <fetcher> (Fetcher) ─> <target>            the tick fans out to it
 *   <receiver> (Tee) ─> [<transform> ─>] <view>       the reply routes back here
 *
 * A Fetcher emits its ONE configured command (`<receiver> <command>`) toward
 * `target` (`_shell/_http/<ci>`); the server CI replies `TO = FROM = receiver`,
 * so the reply lands on the receiver `Tee`, which fans it to the view node — an
 * independent reply path per slice, nothing crosses. The optional `transform`
 * slot drops a Hook/Callback/Counter node onto the receiver-Tee → view edge so a
 * per-slice merge/dedup lands on a graph edge, not inside the view.
 *
 * Pair it with `useBatchedPoll`, whose `build` calls this once per slice and
 * which owns the `_shell`/`_http`/Timer/lock-flush boilerplate.
 *
 * @param {Object}   interpreter       The mounted CommandInterpreter node.
 * @param {Object}   slice
 * @param {string}   slice.fetcher     Fetcher node name (e.g. `fetch-counts`).
 * @param {string}   slice.receiver    Receiver Tee name; the reply routes back here (Fetcher FROM).
 * @param {string}   slice.command     The verb the Fetcher sends.
 * @param {string}   slice.view        View node name.
 * @param {string}   slice.viewClass   Registered class name for the view node.
 * @param {Object}   slice.tee         The fan-out Tee node the tick fans through.
 * @param {string}   slice.target      Egress path the Fetcher targets (`_shell/_http/<ci>`).
 * @param {Object}   [slice.transform] Optional `{ name, nodeClass, args }` node inserted on the receiver-Tee → view edge.
 * @param {Function} [slice.argsFn]    Optional fire-time getter `() => argsString`; assigned to the Fetcher's `command_args` so each tick emits live, UI-state-driven command args (filter / sort / page) without re-wiring.
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
		tee,
		target,
		transform,
		argsFn,
	}
) {
	// Fetcher: turns the tick into ONE command (FROM=receiver) at the egress.
	const f = interpreter.makeNode(
		'Fetcher',
		fetcher,
		`${ receiver } ${ command }`
	);
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
			transform.args || ''
		);
		t.connectNode( view );
		recv.connectNode( transform.name );
	} else {
		recv.connectNode( view );
	}
	interpreter.makeNode( viewClass, view );

	return receiver;
}
