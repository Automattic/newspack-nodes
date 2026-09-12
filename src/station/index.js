/**
 * Browser entry for the top-level "Nodes" admin page: it mounts the station
 * station host into the one div `Admin::render_station_page()` prints.
 *
 * The entry carries no tool of its own. Every tool on the page registers as a
 * `host:'station'` tab from its own bundle — Overview, the Partition
 * Viewer and the Log Viewer come from event-dashboards, enqueued beside this
 * bundle; the Console, Vault, Sessions and Aggregator tabs are injected on
 * first activation by `lazyTabs.js`.
 *
 * Mounting runs at import with no `DOMContentLoaded` wait, because
 * `Admin::enqueue_react_page()` enqueues this bundle in the footer, below the
 * mount div the page has already printed.
 */
import { createRoot } from '@wordpress/element';
import Station from './Station';

/**
 * The station's mount element. Its id is the station page slug,
 * `Admin::STATION_MENU_SLUG`, which is also what the `?page=` gate on the enqueue
 * reads, so the page that loads this bundle is the page that prints the div.
 *
 * `createRoot()` throws on a null container, and the guard below is what makes
 * importing this module a no-op wherever the element is absent.
 */
const mount = document.getElementById( 'newspack-nodes-station' );
if ( mount ) {
	createRoot( mount ).render( <Station /> );
}
