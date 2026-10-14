/**
 * Inject one station tab bundle into the station page on first activation.
 *
 * A tab bundle the station filter marks `lazy` is never enqueued. `Admin` puts its
 * script URL, stylesheet URL and localize payload on the station handle as
 * `window.NewspackNodesLazyTabs`, and the placeholder `lazyTabs.js` registers
 * calls in here the first time a reader opens that tab, which keeps the heavy
 * tab bundles off every station page load that never reaches them.
 *
 * A lazy tab reads its own payload through `tabData()`, never off the shared
 * `NewspackNodesData`: WordPress prints every enqueued bundle's localize as a
 * fresh `var NewspackNodesData = {…}` in the footer, so a key written onto that
 * global here is lost to whichever footer localize runs after the injection.
 * `NewspackNodesLazyTabs` has one writer, the station handle's localize, which
 * prints before the station script, so nothing replaces it once a tab reads it.
 */

/**
 * One tab's load recipe, as `Admin::lazy_tab_script()` builds it.
 *
 * @typedef {Object} LazyTabEntry
 * @property {string}           src     Bundle URL, cache-busted with a `?ver=`
 *                                      query the browser would otherwise miss.
 * @property {Object<string,*>} data    The tab's own localize extras, without
 *                                      the shared `restUrl` and `nonce`.
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
 * }} StationWindow
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
	const station = /** @type {StationWindow} */ ( window );
	const entry = ( station.NewspackNodesLazyTabs || {} )[ handle ];
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

	const script = document.createElement( 'script' );
	script.src = entry.src;
	document.head.appendChild( script );
}

/**
 * One lazy tab's localize payload: its own recipe's `data` laid over the shared
 * `NewspackNodesData`, read at call time.
 *
 * The shared half supplies `restUrl`, `nonce` and `version`, which every footer
 * localize carries alike; the tab's keys come from `NewspackNodesLazyTabs`,
 * which no later localize replaces. A handle with no recipe — the bundle
 * enqueued outright, or a test seeding the shared global — answers the shared
 * payload alone.
 *
 * @param {string} handle Enqueue handle whose recipe sits in
 *                        `NewspackNodesLazyTabs`.
 * @return {Object<string,*>} The payload, a fresh object on each call.
 */
export function tabData( handle ) {
	const station = /** @type {StationWindow} */ ( window );
	const entry = ( station.NewspackNodesLazyTabs || {} )[ handle ];
	return {
		...( station.NewspackNodesData || {} ),
		...( ( entry && entry.data ) || {} ),
	};
}
