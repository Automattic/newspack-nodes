/**
 * DataViews entry — emits `build/dataviews/`, which `Admin::register_dataviews()`
 * registers as the `newspack-nodes-dataviews` script and style handles.
 *
 * WordPress serves no DataViews global, so every plugin using it would bundle
 * its own copy. This bundle is the one copy: it publishes the pinned package
 * as `window.newspackNodesDataViews`, and the build kit's `WP_EXTERNALS` reads
 * every consumer's `@wordpress/dataviews` import from it. The packages
 * WordPress does serve stay external here too, `@wordpress/components` and
 * `@wordpress/private-apis` among them, so DataViews unlocks the page's own
 * components rather than a second copy.
 */
import * as dataviews from '@wordpress/dataviews';
import '@wordpress/dataviews/build-style/style.css';

/**
 * The page's window, carrying the substrate's DataViews global.
 *
 * @typedef {Window & { newspackNodesDataViews?: typeof dataviews }} DataViewsWindow
 */

/** @type {DataViewsWindow} */ ( window ).newspackNodesDataViews = dataviews;
