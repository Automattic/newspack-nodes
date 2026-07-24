/**
 * Inject a lazy DevTools tab bundle on first activation. The hub ships only the
 * default tab up front; every other tab's script + style URL + localize payload
 * ride `window.NewspackNodesLazyTabs` (localized by Admin), and this loads one
 * on demand. Idempotent per handle. Setting NewspackNodesData ahead of the
 * script mirrors the inline localize wp_enqueue_script emits before an enqueued
 * bundle — so the injected bundle reads the same data it would if enqueued.
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
	const entry = ( window.NewspackNodesLazyTabs || {} )[ handle ];
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
		window.NewspackNodesData = {
			...( window.NewspackNodesData || {} ),
			...entry.data,
		};
	}

	const script = document.createElement( 'script' );
	script.src = entry.src;
	document.head.appendChild( script );
}
