/**
 * Run a DOM-mutating callback inside a View Transition so the change crossfades
 * instead of snapping, falling back to a plain call where the API is absent
 * (older browsers, jsdom). The caller must mutate the DOM synchronously inside
 * `update` (e.g. wrap a React state setter in `flushSync`) — the transition
 * snapshots the DOM once `update` returns.
 *
 * @param {Function} update Synchronous DOM mutation to animate.
 */
export default function withViewTransition( update ) {
	if ( 'function' === typeof document.startViewTransition ) {
		document.startViewTransition( update );
		return;
	}
	update();
}
