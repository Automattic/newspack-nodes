import { createRoot } from '@wordpress/element';
import PublisherInsightsPage from './PublisherInsightsPage';

const MOUNT_ID = 'example-ai-newsletter-insights';

document.addEventListener( 'DOMContentLoaded', () => {
	const el = document.getElementById( MOUNT_ID );
	if ( el ) {
		createRoot( el ).render( <PublisherInsightsPage /> );
	}
} );
