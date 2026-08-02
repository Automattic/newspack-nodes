/**
 * makeOpId — a unique correlation id for an awaited verb. The caller stashes a
 * Promise resolver under it, stamps it into `message[ID]`, and the view node
 * matches the reply's ID back to settle that Promise.
 *
 * Was co-located in `useDashboardGraph`, which `useBatchedPoll` superseded.
 */

// Monotonic per-module ID counter — message[ID] matches a reply to its Promise.
let nextOpId = 0;

/**
 * @param {string} prefix Op-id prefix (the hook's name, e.g. `insights-op`).
 * @return {string} A unique, prefixed, monotonic correlation id.
 */
export default function makeOpId( prefix ) {
	nextOpId += 1;
	return `${ prefix }-${ Date.now() }-${ nextOpId }`;
}
