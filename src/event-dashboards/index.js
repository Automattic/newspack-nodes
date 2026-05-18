/**
 * Dashboards Entry Point
 *
 * Workers and Raw Logs dashboards for Event Logger.
 */

import { createRoot } from '@wordpress/element';
import WorkerStatusPage from './WorkerStatusPage';
import RawLogsPage from './RawLogsPage';

// Mount Workers dashboard.
const workersMount = document.getElementById( 'event-logger-workers' );
if ( workersMount ) {
	const root = createRoot( workersMount );
	root.render( <WorkerStatusPage /> );
}

// Mount Raw Logs dashboard.
const rawlogsMount = document.getElementById( 'event-logger-rawlogs' );
if ( rawlogsMount ) {
	const root = createRoot( rawlogsMount );
	root.render( <RawLogsPage /> );
}
