/**
 * Inject a lazy DevTools tab bundle on first activation. The hub ships only the
 * default tab up front; every other tab's script + style URL + localize payload
 * ride `window.NewspackNodesLazyTabs` (localized by Admin), and this loads one
 * on demand. Idempotent per handle. Setting NewspackNodesData ahead of the
 * script mirrors the inline localize wp_enqueue_script emits before an enqueued
 * bundle — so the injected bundle reads the same data it would if enqueued.
 */

/**
 * One tab's load recipe, as `Admin::lazy_tab_script()` builds it.
 *
 * @typedef {Object} LazyTabEntry
 * @property {string}            src     Versioned URL of the tab's built bundle.
 * @property {string}            [style] Stylesheet URL enqueued before the script.
 * @property {Object<string, *>} [data]  Localize payload the bundle would have
 *                                       received had it been enqueued.
 */

/**
 * The globals Admin localizes: the lazy-tab recipes keyed by enqueue handle,
 * and the shared localize payload every bundle reads on render.
 *
 * @typedef {Window & {
 *     NewspackNodesLazyTabs?: Object<string, LazyTabEntry>,
 *     NewspackNodesData?: Object<string, *>,
 * }} HubWindow
 */

// Handles already injected this page-load; a re-mounted placeholder is a no-op.
const injected = new Set();

/**
 * @param {string} handle Enqueue handle whose recipe lives in NewspackNodesLazyTabs.
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
