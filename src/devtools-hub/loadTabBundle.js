/**
 * Inject one DevTools tab bundle into the hub page on first activation.
 *
 * A tab bundle the hub filter marks `lazy` is never enqueued. `Admin` puts its
 * script URL, stylesheet URL and localize payload on the hub handle as
 * `window.NewspackNodesLazyTabs`, and the placeholder `lazyTabs.js` registers
 * calls in here the first time a reader opens that tab, which keeps the heavy
 * tab bundles off every hub page load that never reaches them.
 *
 * Setting `NewspackNodesData` before the script goes in mirrors the inline
 * localize `wp_enqueue_script` emits ahead of an enqueued bundle, so an
 * injected bundle reads the same data it would have read enqueued.
 */

/**
 * One tab's load recipe, as `Admin::lazy_tab_script()` builds it.
 *
 * @typedef {Object} LazyTabEntry
 * @property {string}           src     Bundle URL, cache-busted with a `?ver=`
 *                                      query the browser would otherwise miss.
 * @property {Object<string,*>} data    Localize payload the bundle would have
 *                                      received had it been enqueued.
 * @property {string}           [style] Stylesheet URL, injected ahead of the
 *                                      script.
 */

/**
 * The globals Admin localizes: the lazy-tab recipes keyed by enqueue handle,
 * and the shared localize payload every bundle reads on render.
 *
 * @typedef {Window & {
 *     NewspackNodesLazyTabs?: Object<string,LazyTabEntry>,
 *     NewspackNodesData?: Object<string,*>,
 * }} HubWindow
 */

/**
 * Handles injected during this page load. A placeholder that re-mounts — a
 * switch away from the tab and back — finds its handle here and does nothing.
 *
 * @type {Set<string>}
 */
const injected = new Set();

/**
 * Inject the bundle registered under one enqueue handle, at most once.
 *
 * A handle absent from the map returns silently: Admin omits a bundle whose
 * `index.js` was never built, so an unbuilt tab keeps showing its placeholder
 * instead of fetching a 404.
 *
 * @param {string} handle Enqueue handle whose recipe sits in
 *                        `NewspackNodesLazyTabs`.
 * @return {void}
 */
export function loadTabBundle( handle ) {
	if ( injected.has( handle ) ) {
		return;
	}
	const hub = /** @type {HubWindow} */ ( window );
	const entry = ( hub.NewspackNodesLazyTabs || {} )[ handle ];
	if ( ! entry || ! entry.src ) {
		return;
	}
	injected.add( handle );

	if ( entry.style ) {
		const link = document.createElement( 'link' );
		link.rel = 'stylesheet';
		link.href = entry.style;
		document.head.appendChild( link );
	}

	// Merge, never replace: sibling tabs' live reads keep their own keys.
	if ( entry.data ) {
		hub.NewspackNodesData = {
			...( hub.NewspackNodesData || {} ),
			...entry.data,
		};
	}

	const script = document.createElement( 'script' );
	script.src = entry.src;
	document.head.appendChild( script );
}
