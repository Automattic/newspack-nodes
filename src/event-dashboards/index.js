/**
 * Dashboards Entry Point
 *
 * Raw Logs dashboard for Event Logger.
 */

import { createRoot } from '@wordpress/element';
import './nodes/register';
import './tabs';
import RawLogsPage from './RawLogsPage';

// Mount Raw Logs dashboard.
const rawlogsMount = document.getElementById( 'newspack-nodes-rawlogs' );
if ( rawlogsMount ) {
	const root = createRoot( rawlogsMount );
	root.render( <RawLogsPage /> );
}
