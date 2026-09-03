/**
 * Publisher Insights dashboard entry point — the `build/dashboard` bundle
 * esbuild compiles from this file (`scripts/build.mjs`).
 *
 * Mounting is the whole job. The plugin's admin page callback prints a bare
 * container div and nothing else, and this file renders `PublisherInsightsPage`
 * into it; the graph, the widgets and the styling all hang off that component.
 * `Admin::enqueue_react_page()` enqueues the bundle in the footer, below that
 * markup, so the listener registered here is in place before `DOMContentLoaded`
 * fires.
 *
 * The same enqueue already gates the bundle to the Publisher Insights page, so
 * a missing container means the bundle loaded somewhere it was not expected.
 * Rendering nothing is the right answer there rather than throwing on a page
 * that never asked for the dashboard.
 */

import { createRoot } from '@wordpress/element';
import PublisherInsightsPage from './PublisherInsightsPage';

/**
 * Id of the container div the Publisher Insights admin page prints.
 *
 * Hand-matched to `INSIGHTS_MOUNT_ID` in `example-ai-newsletter.php`. No
 * constant crosses the PHP/JS boundary, so changing one side alone leaves the
 * page blank with nothing logged.
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
