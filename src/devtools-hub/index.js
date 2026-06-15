/**
 * DevTools hub entry — mounts the hub host into its admin page div.
 */
import { createRoot } from '@wordpress/element';
import DevToolsHub from './DevToolsHub';

const mount = document.getElementById( 'newspack-nodes-hub' );
if ( mount ) {
	createRoot( mount ).render( <DevToolsHub /> );
}
