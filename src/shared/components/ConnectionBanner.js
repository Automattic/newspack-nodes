import './ConnectionBanner.scss';

const DEFAULT_MESSAGE = 'Connection lost. Reconnecting…';

/**
 * Shared connection/reconnect banner. Rendered by every dashboard's
 * connection-error surface so they all look identical.
 *
 * @param {Object}  props
 * @param {boolean} props.connectionError Whether to show the banner.
 * @param {string}  [props.message]       Override text (poll dashboards pass their error string; SSE dashboards omit it for the default).
 * @return {import('react').ReactElement|null} The banner, or null when there's no error.
 */
export default function ConnectionBanner( { connectionError, message } ) {
	if ( ! connectionError ) {
		return null;
	}
	return (
		<div className="newspack-nodes-connection-banner" role="status">
			{ message || DEFAULT_MESSAGE }
		</div>
	);
}
