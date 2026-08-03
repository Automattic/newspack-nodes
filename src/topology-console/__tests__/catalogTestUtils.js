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
import { ChromeProvider } from '../ChromeContext';
import { LayoutProvider } from '../LayoutContext';

/**
 * @param {*}      ui         The element under test.
 * @param {Object} [catalogs] Ambient overrides — catalog, chrome and layout
 *                            keys all land here; each provider takes the ones
 *                            it recognises and defaults the rest.
 * @param {Object} [options]  Passed through to Testing Library's `render`.
 * @return {Object} Whatever `render` returns.
 */
export function renderWithCatalog( ui, catalogs = {}, options = {} ) {
	// Testing Library's `wrapper`, not a hand-wrapped element: `rerender`
	// replaces the whole tree, so a manual wrapper vanishes on the second
	// render and the component throws for want of a provider.
	//
	// The ambient values live in a ref the wrapper reads, so re-providing does
	// not change the tree SHAPE. Nesting a second set of providers would — and
	// React remounts on a shape change, resetting every ref the component owns.
	const ambient = { current: catalogs };
	const wrapper = ( { children } ) => (
		<ChromeProvider { ...ambient.current }>
			<LayoutProvider { ...ambient.current }>
				<CatalogProvider { ...ambient.current }>
					{ children }
				</CatalogProvider>
			</LayoutProvider>
		</ChromeProvider>
	);
	const result = render( ui, { ...options, wrapper } );
	return {
		...result,
		/**
		 * Re-render with DIFFERENT ambient values, same tree shape.
		 *
		 * @param {*}      next          The element under test.
		 * @param {Object} [nextAmbient] Ambient overrides for this render.
		 */
		rerenderWithCatalog( next, nextAmbient = {} ) {
			ambient.current = nextAmbient;
			result.rerender( next );
		},
	};
}
