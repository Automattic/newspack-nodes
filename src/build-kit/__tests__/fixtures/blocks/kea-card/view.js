import apiFetch from '@wordpress/api-fetch';
import './view.scss';
import './chat/style.scss';

window.keaView = apiFetch( { path: '/kea-5150' } );
window.keaPanelUrl = 'lazy/kea-panel.js';
