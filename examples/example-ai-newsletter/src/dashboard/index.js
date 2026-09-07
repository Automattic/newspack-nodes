/**
 * Publisher Insights dashboard entry point. Mounting is the whole job: the
 * plugin's admin page callback prints an empty container div inside the
 * standard `.wrap`, and this file renders `PublisherInsightsPage` into it. The
 * poll graph, the three widgets, the debug overlay and the stylesheet all hang
 * off that component.
 *
 * `scripts/build.mjs` names this file as its one entry, so the substrate's
 * build kit compiles it into the `build/dashboard` bundle WordPress enqueues.
 *
 * `Admin::enqueue_react_page()` enqueues that bundle in the footer, below the
 * mount div. A footer script runs while the document is still parsing, so
 * `DOMContentLoaded` has yet to fire and the listener registered here still
 * receives it.
 *
 * That same enqueue gates the bundle on `?page=`, so the mount div is present
 * on every page the bundle loads on. The guard below keeps a missing element a
 * silent no-op rather than the throw `createRoot( null )` raises.
 */

import { createRoot } from '@wordpress/element';
import PublisherInsightsPage from './PublisherInsightsPage';

/**
 * Id of the container div the Publisher Insights admin page prints.
 *
 * Hand-matched to `INSIGHTS_MOUNT_ID` in `example-ai-newsletter.php`. No
 * constant crosses the PHP/JS boundary — the enqueue localizes `restUrl` and
 * `nonce` and nothing else — so changing one side alone leaves the page blank
 * with nothing logged.
 *
 * @type {string}
 */
const MOUNT_ID = 'example-ai-newsletter-insights';

document.addEventListener( 'DOMContentLoaded', () => {
	const el = document.getElementById( MOUNT_ID );
	if ( el ) {
		createRoot( el ).render( <PublisherInsightsPage /> );
	}
} );
