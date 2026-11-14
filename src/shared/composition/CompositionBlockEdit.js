/**
 * CompositionBlockEdit — one block in the layout editor: its View rendered
 * live with `editing: true`, so the View disables every write control it
 * holds, its Controls in the block inspector, handed its attribute schemas,
 * and a container's children through `InnerBlocks`.
 *
 * The editor half of the composition layer: it imports
 * `@wordpress/block-editor`, so only the editor's own bundle carries it.
 */

import {
	InnerBlocks,
	InspectorControls,
	useBlockProps,
} from '@wordpress/block-editor';

/**
 * @param {Object}                                           props
 * @param {Object}                                           props.attributes      The block's attributes.
 * @param {(next: Object) => void}                           props.setAttributes   Writes attributes.
 * @param {import('./CompositionView').CompositionBlockView} props.view            The block's View and Controls.
 * @param {string[]}                                         [props.allowedBlocks] What a container admits; absent for any other block.
 * @param {Object<string,Object>}                            [props.schema]        Each attribute's declared schema, which the Controls read.
 * @return {import('react').ReactElement} The block as the editor shows it.
 */
export default function CompositionBlockEdit( {
	attributes,
	setAttributes,
	view: { View, Controls },
	allowedBlocks,
	schema,
} ) {
	return (
		<div { ...useBlockProps() }>
			{ Controls && (
				<InspectorControls>
					<Controls
						attributes={ attributes }
						setAttributes={ setAttributes }
						schema={ schema }
					/>
				</InspectorControls>
			) }
			<View attributes={ attributes } editing>
				{ allowedBlocks && (
					<InnerBlocks allowedBlocks={ allowedBlocks } />
				) }
			</View>
		</div>
	);
}
