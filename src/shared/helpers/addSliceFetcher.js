/**
 * addSliceFetcher — wire ONE dashboard slice in one call: the per-slice block
 * that used to be the `SLICES.forEach` body of every poll dashboard hook.
 *
 *   tee ─> <fetcher> (Fetcher) ─> <target>            the tick fans out to it
 *   <receiver> (Tee) ─> [<transform> ─>] <view>       the reply pivots back here
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
 * @param {Object} interpreter       The mounted CommandInterpreter node.
 * @param {Object} slice
 * @param {string} slice.fetcher     Fetcher node name (e.g. `fetch-counts`).
 * @param {string} slice.receiver    Receiver Tee name; the reply pivots back here (Fetcher FROM).
 * @param {string} slice.command     The verb the Fetcher sends.
 * @param {string} slice.view        View node name.
 * @param {string} slice.viewClass   Registered class name for the view node.
 * @param {Object} slice.tee         The fan-out Tee node the tick fans through.
 * @param {string} slice.target      Egress path the Fetcher targets (`_shell/_http/<ci>`).
 * @param {Object} [slice.transform] Optional `{ name, nodeClass, args }` node inserted on the receiver-Tee → view edge.
 * @return {string} The receiver Tee name.
 */
export function addSliceFetcher(
	interpreter,
	{ fetcher, receiver, command, view, viewClass, tee, target, transform }
) {
	// Fetcher: turns the tick into ONE configured command (FROM=receiver), aimed
	// at the egress; the fan-out Tee fans the tick to it.
	const f = interpreter.makeNode(
		'Fetcher',
		fetcher,
		`${ receiver } ${ command }`
	);
	f.connectNode( target );
	tee.connectNode( fetcher );

	// Receiver Tee: the reply pivots back here, then fans to the view (or, when a
	// transform is supplied, to the transform which forwards to the view).
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
