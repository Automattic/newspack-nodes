/**
 * nodesData — read the PHP-localized `window.NewspackNodesData` (the REST base +
 * command nonce the SSE/HTTP boundary nodes need) with safe defaults. The nonce
 * is request-scoped, so it lives in this per-page global — NOT in a node's
 * make_node arguments; a nonce baked into a `.tsl` would be stale on load.
 *
 * @return {{ restUrl: string, nonce: string }} The localized data, defaulted.
 */
export function nodesData() {
	const data =
		( typeof window !== 'undefined' && window.NewspackNodesData ) || {};
	return {
		restUrl: data.restUrl || '/wp-json/',
		nonce: data.nonce || '',
	};
}
