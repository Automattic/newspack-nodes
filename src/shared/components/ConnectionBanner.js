import './ConnectionBanner.scss';

/**
 * Banner text for a caller that passes no `message`.
 *
 * Every dashboard passes its own string, translated in its own text domain, so
 * this renders only where a caller omits the prop or hands over an empty one.
 */
const DEFAULT_MESSAGE = 'Connection lost. Reconnecting…';

/**
 * The shared connection/reconnect banner a dashboard renders when its
 * transport drops, so a lost SSE stream and a failed poll look identical
 * wherever they surface.
 *
 * It carries two classes and needs both. `newspack-nodes-error-banner` is the
 * canonical error role in `src/shared/styles/_components.scss` and owns the
 * whole appearance; `newspack-nodes-connection-banner` is a placement hook
 * whose stylesheet sets margin alone. Declaring a fill, a radius or a color
 * here would fork the error look one dashboard at a time, so
 * `styleOwnership.test.js` pins the pair and this component's own suite fails
 * the stylesheet that reaches for an appearance property.
 *
 * `role="status"` makes it a polite live region. The banner mounts and
 * unmounts with no navigation to announce it, and a reconnect that resolves on
 * its own must not interrupt whatever the reader is on — which `role="alert"`
 * would.
 *
 * @param {Object}  props
 * @param {boolean} props.connectionError Whether the transport is down.
 * @param {string}  [props.message]       Banner text. An empty or absent value
 *                                        falls back to the default.
 * @return {import('react').ReactElement|null} The banner, or null while the connection holds.
 */
export default function ConnectionBanner( { connectionError, message } ) {
	if ( ! connectionError ) {
		return null;
	}
	return (
		<div
			className="newspack-nodes-error-banner newspack-nodes-connection-banner"
			role="status"
		>
			{ message || DEFAULT_MESSAGE }
		</div>
	);
}
