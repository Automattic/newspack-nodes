/**
 * The browser half of PHP's `Worker_Should_Stop::attempt_each()` and
 * `raise()`: a loop that must attempt every step collects what each one
 * threw, and throws it after the last. The browser has no cooperative stop,
 * so nothing is ranked — one failure is rethrown as it was caught, and
 * several become an AggregateError whose message reads as PHP's `Failures`.
 */

/**
 * Offer every item to `step`, whatever an earlier one threw.
 *
 * @template T
 * @param {Iterable<T>}       items Items to offer, in order.
 * @param {function(T): void} step  Called once per item.
 * @return {Error[]} Everything the steps threw, in order.
 */
export function attemptEach( items, step ) {
	const caught = [];
	for ( const item of items ) {
		try {
			step( item );
		} catch ( e ) {
			caught.push( e );
		}
	}
	return caught;
}

/**
 * Throw what a run of attempts caught: nothing, the one, or all of them. It
 * runs on every success path, so the empty case returns before allocating.
 *
 * @param {Error[]} caught Every throwable caught, in order.
 * @throws {Error} The one caught, or an AggregateError over several.
 */
export function raise( caught ) {
	if ( 0 === caught.length ) {
		return;
	}
	const all = caught.flatMap( ( e ) =>
		e instanceof AggregateError ? e.errors : [ e ]
	);
	if ( 1 === all.length ) {
		throw all[ 0 ];
	}
	const messages = all.map( ( e ) => e.message ).join( ' | ' );
	throw new AggregateError( all, `${ all.length } failures: ${ messages }` );
}
