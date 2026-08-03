/**
 * Render helper for components that read `useCatalog()`.
 *
 * The catalogs moved off the prop chain into a context, so a test that mounts
 * Palette / SchematicCanvas / Inspector directly has to provide them. Catalog
 * entries a test does not name default to empty, which is what the real
 * providers do.
 *
 * @testonly
 */

import { render } from '@testing-library/react';
import { CatalogProvider } from '../CatalogContext';

/**
 * @param {*}      ui         The element under test.
 * @param {Object} [catalogs] Catalog overrides for this render.
 * @param {Object} [options]  Passed through to Testing Library's `render`.
 * @return {Object} Whatever `render` returns.
 */
export function renderWithCatalog( ui, catalogs = {}, options = {} ) {
	// Testing Library's `wrapper`, not a hand-wrapped element: `rerender`
	// replaces the whole tree, so a manual wrapper vanishes on the second
	// render and the component throws for want of a provider.
	const wrapper = ( { children } ) => (
		<CatalogProvider { ...catalogs }>{ children }</CatalogProvider>
	);
	return render( ui, { ...options, wrapper } );
}

/**
 * A `wrapper` for `renderHook`/`render` when the catalogs can stay empty.
 *
 * @param {Object} props          Wrapper props.
 * @param {*}      props.children Consumers.
 * @return {Element} The provider.
 */
export function CatalogWrapper( { children } ) {
	return <CatalogProvider>{ children }</CatalogProvider>;
}
