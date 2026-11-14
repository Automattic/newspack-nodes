/**
 * A composed page's layout editor, mounted in one call from what
 * `Composition::editor()` localized: the context's blocks registered against
 * the consumer's views, core's blocks left to core and confined to what a
 * layout keeps (`confineCanvas()`), each View providing `editing` to the
 * write controls it holds; then the context's editor for the page's slot,
 * standing inside the consumer's providers and sending for the group of the
 * `ComposedPage` they provide, under a `PageStateProvider` and a
 * `SourcesProvider` the blocks and the preview read their page state and
 * sources through. A bundle reads only the sources and page state its own
 * modules declare, so a page's `registerSource()` and `definePageState()`
 * declarations live in a module both its reader and its editor entries
 * import, such as its views map.
 *
 * The editor half of the composition layer: only a consumer's editor bundle
 * imports it, so `page/index.js` does not export it.
 */

import CompositionEditor from '../CompositionEditor';
import { confineCanvas } from '../confineCanvas';
import { registerCompositionEditor } from '../editorRegistry';
import { registerCompositionBlocks } from '../registerCompositionBlocks';
import { SourcesProvider } from '../../sources';
import { PageStateProvider } from './pageState';
import { providedViews, usePage } from './pageContext';

/**
 * What `Composition::editor()` localizes as `NewspackNodesComposition`.
 *
 * @typedef {Object} LocalizedComposition
 * @property {string}                                                                  context  The context edited.
 * @property {Object<string,import('../registerCompositionBlocks').CompositionSchema>} blocks   Block name => schema, the admitted ones included.
 * @property {import('../CompositionEditor').CompositionPattern[]}                     patterns The layouts it offers to start from.
 * @property {string[]}                                                                inline   The elements a text block keeps.
 */

/**
 * The editor under the consumer's providers.
 *
 * @param {Object}                                 props
 * @param {LocalizedComposition}                   props.localized What the server localized.
 * @param {string}                                 props.heading   The editor's heading.
 * @param {?import('react').ComponentType<Object>} props.Preview   What the blocks preview with, handed the slot's props.
 * @param {Object}                                 props.slot      The slot's props, `onDone` and `onDirty` among them.
 * @return {import('react').ReactElement} The editor.
 */
function PageEditor( {
	localized: { context, blocks, patterns, inline },
	heading,
	Preview,
	slot,
} ) {
	const { group } = usePage();
	return (
		<CompositionEditor
			group={ group }
			context={ context }
			heading={ heading }
			schemas={ blocks }
			patterns={ patterns }
			inline={ inline }
			preview={ Preview && <Preview { ...slot } /> }
			onDone={ slot.onDone }
			onDirty={ slot.onDirty }
		/>
	);
}

/**
 * Register the localized context's blocks against `views`, then its editor
 * for the page's slot.
 *
 * @param {LocalizedComposition}                                                                    localized         What `Composition::editor()` localized.
 * @param {Object<string,import('../CompositionView').CompositionBlockView>}                        views             Every block's view; those the context does not admit are passed over.
 * @param {Object}                                                                                  options
 * @param {string}                                                                                  options.heading   The editor's heading, in the consumer's words.
 * @param {(children: import('react').ReactElement, props: Object) => import('react').ReactElement} [options.wrap]    The consumer's providers, a `ComposedPage` among them unless the page provides one, handed the slot's props.
 * @param {(props: Object) => ?import('react').ReactElement}                                        [options.preview] What the blocks preview with, a component under `wrap` handed the slot's props.
 * @throws {Error} Naming a localized block with no view.
 */
export function mountComposedEditor(
	localized,
	views,
	{ heading, wrap = ( children ) => children, preview = null }
) {
	const { context, blocks, inline } = localized;
	confineCanvas(
		/** @type {Window & {wp?: Object}} */ ( window ).wp,
		Object.keys( blocks ).filter( ( name ) => blocks[ name ].core ),
		inline
	);
	const admitted = Object.entries( providedViews( views ) ).filter(
		( [ name ] ) => Object.hasOwn( blocks, name )
	);
	registerCompositionBlocks( blocks, Object.fromEntries( admitted ) );
	registerCompositionEditor( context, ( slot ) => (
		<PageStateProvider>
			<SourcesProvider>
				{ wrap(
					<PageEditor
						localized={ localized }
						heading={ heading }
						Preview={ preview }
						slot={ slot }
					/>,
					slot
				) }
			</SourcesProvider>
		</PageStateProvider>
	) );
}
