/**
 * Topology Console bundle entry. Registering the Console as a DevTools hub tab
 * is its whole job.
 *
 * Nothing here mounts a root — the Console is a tab on the hub page, not a page
 * of its own. The hub registers a placeholder carrying the same `./tabMeta`
 * descriptor, then injects this bundle when a reader first opens the tab; the
 * `./tabs` import registers the live component under that id, shadowing the
 * placeholder.
 *
 * Both imports run for their side effects. Importing the stylesheet is what
 * makes the build emit the `index.css` the hub injects ahead of the script.
 */

import './tabs';
import './styles/topology-console.scss';
