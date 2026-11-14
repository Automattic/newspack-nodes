/**
 * registerCompositionBlocks — a consumer's blocks registered in the browser
 * alone, from the schemas `Composition::editor()` localized, so no post, site
 * or widget editor ever offers one.
 *
 * Every block is dynamic: its edit renders its View live and its save renders
 * nothing, because the server stores and reads the delimiters alone. The core
 * blocks every context admits register as core registers them, so they are
 * passed over here. Editor features that would write an attribute the schema
 * does not declare are switched off (`UNKEPT_SUPPORTS`), since the server
 * refuses one, and so is saving a block as a synced pattern, which would swap
 * the block for a core/block.
 *
 * The editor half of the composition layer.
 */

import { registerBlockType } from '@wordpress/blocks';
import CompositionBlockEdit from './CompositionBlockEdit';
import { UNKEPT_SUPPORTS } from './confineCanvas';

/**
 * One block as `Composition::schemas()` declares it.
 *
 * @typedef {Object} CompositionSchema
 * @property {string}                title      The inserter's name for it.
 * @property {Object<string,Object>} attributes Attribute => JSON schema with a default.
 * @property {boolean}               container  It holds blocks, and stands only at the top, in a column or in a group.
 * @property {boolean}               multiple   False when it stands once.
 * @property {boolean}               [core]     A core block, which core registers.
 * @property {?string}               [text]     The tag a core block's text is written in, null for one that holds none.
 */

/** A dynamic block writes no markup of its own. */
const SAVES_NOTHING = () => null;

/**
 * Refuse a name one map carries and the other does not.
 *
 * @param {Object} from    The map whose names are checked.
 * @param {Object} against The map that must carry each.
 * @param {string} missing What the absence is called.
 * @throws {Error} Naming the first unmatched name.
 */
function pairUp( from, against, missing ) {
	const unmatched = Object.keys( from ).find(
		( name ) => ! Object.hasOwn( against, name )
	);
	if ( undefined !== unmatched ) {
		throw new Error( `${ unmatched } has no ${ missing }` );
	}
}

/**
 * Register each schema but a core block's with its view, a container
 * admitting every block but a container.
 *
 * @param {Object<string,CompositionSchema>}                                schemas Block name => schema.
 * @param {Object<string,import('./CompositionView').CompositionBlockView>} views   Block name => View and Controls.
 * @throws {Error} Before registering anything, naming a schema without a view or a view without a schema.
 */
export function registerCompositionBlocks( schemas, views ) {
	const own = Object.fromEntries(
		Object.entries( schemas ).filter( ( [ , schema ] ) => ! schema.core )
	);
	pairUp( own, views, 'view' );
	pairUp( views, own, 'schema' );
	const leaves = Object.keys( schemas ).filter(
		( name ) => ! schemas[ name ].container
	);
	for ( const [ name, schema ] of Object.entries( own ) ) {
		const view = views[ name ];
		const allowedBlocks = schema.container ? leaves : undefined;
		registerBlockType( name, {
			apiVersion: 3,
			title: schema.title,
			category: 'widgets',
			attributes: schema.attributes,
			supports: { multiple: schema.multiple, ...UNKEPT_SUPPORTS },
			edit: ( props ) => (
				<CompositionBlockEdit
					{ ...props }
					view={ view }
					allowedBlocks={ allowedBlocks }
					schema={ schema.attributes }
				/>
			),
			save: SAVES_NOTHING,
		} );
	}
}
