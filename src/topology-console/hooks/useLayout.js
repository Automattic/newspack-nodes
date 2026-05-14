/**
 * useLayout — fetch and save canvas-position layouts.
 *
 * Layouts are decoupled from topologies (a topology's TSL describes
 * graph structure; a layout file describes node positions). One
 * layout per topology name, stored server-side at
 * <base_directory>/layouts/<name>.layout.
 *
 * Returns:
 *   - fetchLayout(name) → Promise<{ name, positions: {id: [x,y]} | null }>
 *   - saveLayout({ name, positions }) → Promise<{ name, path, positions }>
 */

import { useCallback } from '@wordpress/element';
import apiFetch from '@wordpress/api-fetch';

export function useLayout() {
	const fetchLayout = useCallback( async ( name ) => {
		return apiFetch( {
			path: `/newspack-nodes/v1/layouts/${ encodeURIComponent( name ) }`,
		} );
	}, [] );

	const saveLayout = useCallback( async ( { name, positions } ) => {
		const nonce =
			( window.NewspackNodesData &&
				window.NewspackNodesData.saveLayoutNonce ) ||
			'';
		return apiFetch( {
			path:
				`/newspack-nodes/v1/layouts/${ encodeURIComponent( name ) }` +
				`?save_nonce=${ encodeURIComponent( nonce ) }`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify( { positions } ),
			parse: true,
		} );
	}, [] );

	return { fetchLayout, saveLayout };
}
